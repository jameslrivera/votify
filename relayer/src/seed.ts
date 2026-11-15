import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as snarkjs from "snarkjs";
import { TREE_DEPTH } from "@zk-election/constants";
import { IncrementalMerkleTree, commitment, voteNullifier, type Credential } from "@zk-election/merkle";
import { yymmdd } from "@zk-election/passport";
import type { SnarkjsProof } from "@zk-election/proof-format";
import { RelayError, type Chain, type ProofBody } from "./chain.ts";
import type { RelayerConfig } from "./config.ts";
import { proveMockRegistrationsInBackground, type DemoCredential } from "./demo-prover.ts";

const SKIP_CHANCE = 0.1;
const DAY_MS = 24 * 60 * 60 * 1000;

export type SimulationState = "off" | "preparing" | "ready" | "running" | "done";

export interface SimulationInfo {
  state: SimulationState;
  voters: number;
  total: number;
}

interface PreparedVoter extends DemoCredential {
  proofs: ProofBody[];
}

interface NextBatch {
  ids: string[];
  date: number;
  voters: PreparedVoter[];
}

interface SeedFile {
  current?: { ids: string[]; voters: DemoCredential[] };
  next?: NextBatch;
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

const randomIds = (count: number): string[] =>
  Array.from({ length: count }, () => randomBytes(8).readBigUInt64BE().toString());

export class Seeder {
  private generation = 0;
  private voters: DemoCredential[] = [];
  private phase: "idle" | "registering" | "running" | "done" = "idle";
  private next: NextBatch | null = null;
  private preparing = false;
  private readonly file: string;

  constructor(
    private readonly config: RelayerConfig,
    private readonly chain: Chain,
  ) {
    this.file = config.statePath.replace(/\.json$/, "") + ".seed.json";
    const saved = this.read();
    if (saved.next && this.batchUsable(saved.next)) this.next = saved.next;
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
    return { state, voters: this.voters.length, total };
  }

  async newBallot(): Promise<void> {
    const generation = ++this.generation;
    this.voters = [];
    const races = this.config.ballot.races.length;
    const batch = this.config.seedVoters > 0 && this.next && this.batchUsable(this.next) ? this.next : null;
    this.next = null;
    await this.chain.createBallot(batch ? batch.ids.map((id) => BigInt(id)) : undefined);
    const ids = this.chain.electionIdsNow().map(String);
    this.write({ current: { ids, voters: [] }, next: undefined });
    if (this.config.seedVoters < 1) {
      this.phase = "idle";
      return;
    }
    this.phase = "registering";
    void this.registerAll(generation, ids, batch?.voters ?? [])
      .catch(() => undefined)
      .finally(() => {
        if (this.stale(generation)) return;
        if (this.phase === "registering") this.phase = "idle";
        void this.prepareNext(races).catch(() => undefined);
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
    if (this.config.seedVoters > 0) void this.prepareNext(this.config.ballot.races.length).catch(() => undefined);
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

  private batchUsable(batch: NextBatch): boolean {
    const today = yymmdd(new Date());
    const yesterday = yymmdd(new Date(Date.now() - DAY_MS));
    return (
      batch.ids.length === this.config.ballot.races.length &&
      batch.voters.length >= this.config.seedVoters &&
      (batch.date === today || batch.date === yesterday)
    );
  }

  private async registerAll(generation: number, ids: string[], ready: PreparedVoter[]): Promise<void> {
    const electionIds = ids.map((id) => BigInt(id));
    const inFlight = new Set<Promise<void>>();
    const registerVoter = async (voter: PreparedVoter, proofs: ProofBody[]): Promise<void> => {
      if (this.stale(generation) || (await this.chain.info()).phase !== "registration") return;
      const results = await Promise.allSettled(proofs.map((proof) => this.chain.register(proof)));
      if (this.stale(generation) || !results.every((result) => result.status === "fulfilled")) return;
      this.voters.push({ secretHex: voter.secretHex, nullifierKeyHex: voter.nullifierKeyHex });
      this.write({ current: { ids, voters: this.voters } });
    };
    for (let i = 0; i < this.config.seedVoters; i++) {
      if (this.stale(generation) || (await this.chain.info()).phase !== "registration") break;
      const voter = ready[i] ?? { ...randomHex(), proofs: [] };
      const proofs =
        voter.proofs.length === electionIds.length
          ? voter.proofs
          : await proveMockRegistrationsInBackground(this.config, voter, electionIds, 3);
      while (inFlight.size >= 2) await Promise.race(inFlight);
      const task = registerVoter(voter, proofs).catch(() => undefined);
      inFlight.add(task);
      void task.finally(() => inFlight.delete(task));
    }
    await Promise.all(inFlight);
  }

  private async prepareNext(races: number): Promise<void> {
    if (this.preparing || (this.next && this.batchUsable(this.next))) return;
    this.preparing = true;
    try {
      const ids = randomIds(races);
      const electionIds = ids.map((id) => BigInt(id));
      const date = yymmdd(new Date());
      const voters: PreparedVoter[] = [];
      for (let i = 0; i < this.config.seedVoters; i++) {
        const hex = randomHex();
        voters.push({ ...hex, proofs: await proveMockRegistrationsInBackground(this.config, hex, electionIds, 2) });
      }
      this.next = { ids, date, voters };
      this.write({ next: this.next });
    } finally {
      this.preparing = false;
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
    const pending: Promise<unknown>[] = [];
    for (const [index, item] of planned.entries()) {
      if (this.stale(generation)) return;
      const race = info.races[item.race]!;
      const electionId = BigInt(race.electionId);
      const proof = await this.prove(item.voter, trees[item.race]!, electionId, item.option);
      if (this.stale(generation)) return;
      const sent = this.chain.vote(proof).catch(() => undefined);
      pending.push(sent);
      if (index === repeatAt) {
        const again = await this.prove(item.voter, trees[item.race]!, electionId, (item.option + 1) % race.candidates.length);
        pending.push(
          sent
            .then(() => wait(1500))
            .then(() => this.chain.vote(again))
            .catch(() => undefined),
        );
      }
      await wait(1000 + Math.random() * 4000);
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
