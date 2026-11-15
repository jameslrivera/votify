import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as snarkjs from "snarkjs";
import { TREE_DEPTH } from "@zk-election/constants";
import { IncrementalMerkleTree, commitment, voteNullifier, type Credential } from "@zk-election/merkle";
import type { SnarkjsProof } from "@zk-election/proof-format";
import { RelayError, type Chain, type ProofBody } from "./chain.ts";
import type { RelayerConfig } from "./config.ts";
import { proveMockRegistrationsInBackground, type DemoCredential } from "./demo-prover.ts";

const SKIP_CHANCE = 0.1;
const REGISTER_AT_ONCE = 6;
const PROVE_AHEAD = 4;

export type SimulationState = "off" | "preparing" | "ready" | "running" | "done";

export interface SimulationInfo {
  state: SimulationState;
  voters: number;
  total: number;
  spares: number;
}

interface StoredBallot {
  ids: string[];
  voters: DemoCredential[];
}

interface SeedFile {
  current?: StoredBallot;
  spares?: StoredBallot[];
}

interface PlannedVote {
  voter: Credential;
  race: number;
  option: number;
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function pick(weights: number[]): number {
  let roll = Math.random() * weights.reduce((sum, weight) => sum + weight, 0);
  for (const [index, weight] of weights.entries()) {
    roll -= weight;
    if (roll <= 0) return index;
  }
  return weights.length - 1;
}

function shuffle<T>(items: T[]): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j]!, items[i]!];
  }
  return items;
}

const toCredential = (hex: DemoCredential): Credential => ({
  secret: BigInt("0x" + hex.secretHex),
  nullifierKey: BigInt("0x" + hex.nullifierKeyHex),
});

const randomHex = (): DemoCredential => ({
  secretHex: randomBytes(31).toString("hex"),
  nullifierKeyHex: randomBytes(31).toString("hex"),
});

export class Seeder {
  private generation = 0;
  private voters: DemoCredential[] = [];
  private phase: "idle" | "registering" | "running" | "done" = "idle";
  private spares: StoredBallot[] = [];
  private building = false;
  private readonly file: string;

  constructor(
    private readonly config: RelayerConfig,
    private readonly chain: Chain,
  ) {
    this.file = config.statePath.replace(/\.json$/, "") + ".seed.json";
    this.spares = (this.read().spares ?? []).filter(
      (spare) => spare.ids.length === config.ballot.races.length && spare.voters.length > 0,
    );
  }

  info(): SimulationInfo {
    const total = this.config.seedVoters;
    let state: SimulationState = "off";
    if (total > 0) {
      if (this.phase === "running") state = "running";
      else if (this.phase === "done") state = "done";
      else if (this.phase === "registering" || this.voters.length === 0) state = "preparing";
      else state = "ready";
    }
    return { state, voters: this.voters.length, total, spares: this.spares.length };
  }

  async newBallot(): Promise<void> {
    const generation = ++this.generation;
    this.voters = [];
    const spare = this.config.seedVoters > 0 ? this.spares.shift() : undefined;
    if (spare) {
      this.chain.switchTo(spare.ids.map((id) => BigInt(id)));
      this.voters = spare.voters;
      this.phase = "idle";
      this.write({ current: spare, spares: this.spares });
      void this.refill();
      return;
    }
    await this.chain.createBallot();
    const ids = this.chain.electionIdsNow().map(String);
    this.write({ current: { ids, voters: [] }, spares: this.spares });
    if (this.config.seedVoters < 1) {
      this.phase = "idle";
      return;
    }
    this.phase = "registering";
    void this.registerVoters(ids, (voter) => {
      if (this.stale(generation)) return false;
      this.voters.push(voter);
      this.write({ current: { ids, voters: this.voters } });
      return true;
    })
      .catch(() => undefined)
      .finally(() => {
        if (this.stale(generation)) return;
        if (this.phase === "registering") this.phase = "idle";
        void this.refill();
      });
  }

  resume(): void {
    const saved = this.read();
    const ids = this.chain.electionIdsNow().map(String);
    if (saved.current && saved.current.ids.join(",") === ids.join(",")) this.voters = saved.current.voters;
    this.phase = "idle";
    void this.chain
      .info()
      .then((info) => {
        if (info.phase !== "registration" && this.phase === "idle") this.phase = "done";
      })
      .catch(() => undefined);
    void this.refill();
  }

  simulate(): void {
    if (this.config.seedVoters < 1) throw new RelayError("BadRequest", "Simulated voters are turned off");
    if (this.phase === "running" || this.phase === "done") return;
    if (this.phase === "registering" || this.voters.length === 0) {
      throw new RelayError("BadRequest", "The simulated voters are still registering");
    }
    this.phase = "running";
    const generation = this.generation;
    void this.run(generation)
      .catch(() => undefined)
      .finally(() => {
        if (!this.stale(generation)) this.phase = "done";
      });
  }

  private stale(generation: number): boolean {
    return generation !== this.generation;
  }

  private read(): SeedFile {
    try {
      return existsSync(this.file) ? (JSON.parse(readFileSync(this.file, "utf8")) as SeedFile) : {};
    } catch {
      return {};
    }
  }

  private write(patch: SeedFile): void {
    writeFileSync(this.file, JSON.stringify({ ...this.read(), ...patch }) + "\n");
  }

  private async registerVoters(ids: string[], accept: (voter: DemoCredential) => boolean): Promise<void> {
    const electionIds = ids.map((id) => BigInt(id));
    const inFlight = new Set<Promise<void>>();
    let stop = false;
    for (let i = 0; i < this.config.seedVoters && !stop; i++) {
      const voter = randomHex();
      while (this.phase === "running" && ids.join(",") !== this.chain.electionIdsNow().map(String).join(",")) await wait(1000);
      const proofs = await proveMockRegistrationsInBackground(this.config, voter, electionIds, 3);
      while (inFlight.size >= REGISTER_AT_ONCE) await Promise.race(inFlight);
      const task = Promise.allSettled(proofs.map((proof) => this.chain.register(proof))).then((results) => {
        if (results.every((result) => result.status === "fulfilled")) {
          if (!accept(voter)) stop = true;
          return;
        }
        const closed = results.some(
          (result) => result.status === "rejected" && result.reason instanceof RelayError && result.reason.code === "WrongPhase",
        );
        if (closed) stop = true;
      });
      inFlight.add(task);
      void task.finally(() => inFlight.delete(task));
    }
    await Promise.all(inFlight);
  }

  private async refill(): Promise<void> {
    if (this.building || this.config.seedVoters < 1) return;
    this.building = true;
    try {
      while (this.spares.length < this.config.spareBallots) {
        while (this.phase === "running") await wait(1000);
        const ids = (await this.chain.createElections()).map(String);
        const voters: DemoCredential[] = [];
        await this.registerVoters(ids, (voter) => {
          voters.push(voter);
          return true;
        });
        if (voters.length === 0) break;
        this.spares.push({ ids, voters });
        this.write({ spares: this.spares });
      }
    } catch {
      return;
    } finally {
      this.building = false;
    }
  }

  private async run(generation: number): Promise<void> {
    const info = await this.chain.info();
    if (info.phase === "registration") await this.chain.openVoting();
    if (this.stale(generation)) return;
    const trees: IncrementalMerkleTree[] = [];
    for (const race of info.races) {
      const leaves = await this.chain.fetchLeaves(BigInt(race.electionId));
      trees.push(
        new IncrementalMerkleTree(
          TREE_DEPTH,
          leaves.map((leaf) => BigInt("0x" + leaf)),
        ),
      );
    }
    const planned: PlannedVote[] = [];
    for (const race of info.races) {
      const weights = race.candidates.map(() => 1 + Math.random() * 3);
      const electionId = BigInt(race.electionId);
      for (const hex of this.voters) {
        const voter = toCredential(hex);
        if (trees[race.index]!.indexOf(commitment(voter, electionId)) < 0) continue;
        if (await this.chain.hasVoted(electionId, voteNullifier(voter.nullifierKey, electionId))) continue;
        if (Math.random() < SKIP_CHANCE) continue;
        planned.push({ voter, race: race.index, option: pick(weights) });
      }
    }
    shuffle(planned);
    const repeatAt = Math.floor(planned.length / 2);
    const proofs: Promise<ProofBody>[] = [];
    let next = 0;
    const proveAhead = () => {
      while (next < planned.length && next - sentCount < PROVE_AHEAD) {
        const item = planned[next]!;
        proofs[next] = this.prove(item.voter, trees[item.race]!, BigInt(info.races[item.race]!.electionId), item.option);
        proofs[next]!.catch(() => undefined);
        next++;
      }
    };
    let sentCount = 0;
    const pending: Promise<unknown>[] = [];
    proveAhead();
    for (const [index, item] of planned.entries()) {
      if (this.stale(generation)) return;
      const race = info.races[item.race]!;
      const electionId = BigInt(race.electionId);
      const started = Date.now();
      const proof = await proofs[index]!;
      sentCount = index + 1;
      proveAhead();
      if (this.stale(generation)) return;
      const sent = this.chain.vote(proof).catch(() => undefined);
      pending.push(sent);
      if (index === repeatAt) {
        const again = this.prove(item.voter, trees[item.race]!, electionId, (item.option + 1) % race.candidates.length);
        pending.push(
          sent
            .then(() => wait(1500))
            .then(async () => this.chain.vote(await again))
            .catch(() => undefined),
        );
      }
      const gap = this.config.seedPaceMs * (0.6 + Math.random() * 0.8);
      await wait(Math.max(0, gap - (Date.now() - started)));
    }
    await Promise.all(pending);
  }

  private async prove(
    voter: Credential,
    tree: IncrementalMerkleTree,
    electionId: bigint,
    option: number,
  ): Promise<ProofBody> {
    const path = tree.proof(tree.indexOf(commitment(voter, electionId)));
    const input = {
      root: path.root.toString(),
      vote_nullifier: voteNullifier(voter.nullifierKey, electionId).toString(),
      vote: option.toString(),
      election_id: electionId.toString(),
      secret: voter.secret.toString(),
      nullifier_key: voter.nullifierKey.toString(),
      path_elements: path.pathElements.map(String),
      path_index: path.pathIndex.map(String),
    };
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(
      input,
      join(this.config.artifactsDir, "vote", "vote.wasm"),
      join(this.config.artifactsDir, "vote", "vote.zkey"),
    );
    return { proof: proof as SnarkjsProof, publicSignals };
  }
}
