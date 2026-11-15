import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import anchorPackage from "@anchor-lang/core";
import type { BN as BNType, EventParser as EventParserType, Idl, Program as ProgramType } from "@anchor-lang/core";
import {
  ComputeBudgetProgram,
  Connection,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  type Transaction,
} from "@solana/web3.js";
import {
  proofToSolana,
  publicSignalsToBytes,
  toBytes32BE,
  REGISTER_INPUT,
  VOTE_INPUT,
  type SnarkjsProof,
} from "@zk-election/proof-format";
import { TREE_DEPTH } from "@zk-election/constants";
import { IncrementalMerkleTree } from "@zk-election/merkle";
import type { RelayerConfig } from "./config.ts";

const { AnchorProvider, BN, BorshCoder, EventParser, Program, Wallet } = anchorPackage;

const CU_LIMIT = { createElection: 50_000, register: 400_000, phase: 20_000, castVote: 250_000 };

export interface ProofBody {
  proof: SnarkjsProof;
  publicSignals: string[];
}

export class RelayError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly signature?: string,
  ) {
    super(message);
  }
}

export interface RaceInfo {
  index: number;
  office: string;
  district: string;
  electionId: string;
  election: string;
  candidates: string[];
  tally: number[];
}

export type TransactionKind = "registered" | "vote" | "double-vote" | "double-registration" | "rejected";

export interface RaceTransaction {
  signature: string;
  time: number | null;
  kind: TransactionKind;
  candidate?: string;
}

interface RaceLive {
  phase: BallotInfo["phase"];
  tally: number[];
  leaves: string[];
  feed: RaceTransaction[];
  voted: Set<string>;
}

export interface BallotInfo {
  title: string;
  area: string;
  note: string;
  programId: string;
  phase: "registration" | "voting" | "closed";
  registered: number;
  rpcUrl: string;
  keyTree: "demo" | "strict";
  demoMode: boolean;
  races: RaceInfo[];
}

const bytes = (u: Uint8Array): number[] => Array.from(u);
const hex32 = (b: ArrayLike<number>): string => Buffer.from(Uint8Array.from(b)).toString("hex");

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function patientFetch(spacingMs: number): typeof fetch {
  let gate: Promise<void> = Promise.resolve();
  return async (input, init) => {
    for (let attempt = 0; ; attempt++) {
      const turn = gate;
      gate = turn.then(() => pause(spacingMs));
      await turn;
      const response = await fetch(input, init);
      if (response.status !== 429 || attempt >= 24) return response;
      await pause(1500 + 500 * Math.min(attempt, 10));
    }
  };
}

export class Chain {
  readonly connection: Connection;
  readonly program: ProgramType;
  readonly programId: PublicKey;
  private readonly parser: EventParserType;
  private electionIds: bigint[] = [];
  private readonly scans = new Map<string, { leaves: string[]; newest?: string }>();
  private readonly classified = new Map<string, RaceTransaction | null>();
  private live: RaceLive[] | null = null;
  private liveComplete = false;
  private loading: Promise<RaceLive[]> | null = null;
  private readonly others = new Map<string, { ids: bigint[]; live: RaceLive[] }>();

  constructor(private readonly config: RelayerConfig) {
    const idl = JSON.parse(readFileSync(config.idlPath, "utf8")) as Idl;
    const local = /127\.0\.0\.1|localhost/.test(config.rpcUrl);
    this.connection = local
      ? new Connection(config.rpcUrl, "confirmed")
      : new Connection(config.rpcUrl, {
          commitment: "confirmed",
          fetch: patientFetch(Number(process.env.RPC_SPACING_MS ?? 220)),
          disableRetryOnRateLimit: true,
        });
    const provider = new AnchorProvider(this.connection, new Wallet(config.payer), { commitment: "confirmed" });
    this.program = new Program(idl, provider);
    this.programId = this.program.programId;
    this.parser = new EventParser(this.programId, new BorshCoder(idl));
    if (existsSync(config.statePath)) {
      const state = JSON.parse(readFileSync(config.statePath, "utf8")) as { elections?: string[] };
      if (Array.isArray(state.elections)) this.electionIds = state.elections.map((id) => BigInt(id));
    }
  }

  private async state(): Promise<RaceLive[]> {
    if (this.live) return this.live;
    this.requireIds();
    if (!this.loading) {
      this.loading = this.loadLive().finally(() => {
        this.loading = null;
      });
    }
    return this.loading;
  }

  private async loadLive(): Promise<RaceLive[]> {
    const ids = this.requireIds();
    const accounts = (await this.accounts.election.fetchMultiple(ids.map((id) => this.electionAddress(id)))) as any[];
    if (accounts.some((account) => !account)) throw new RelayError("NoElection", "The ballot was not found on Solana");
    const live: RaceLive[] = [];
    for (const [index, id] of ids.entries()) {
      const race = this.config.ballot.races[index]!;
      live.push({
        phase: Object.keys(accounts[index].phase)[0] as BallotInfo["phase"],
        tally: (accounts[index].tally as BNType[]).slice(0, race.candidates.length).map((t) => Number(t.toString())),
        leaves: await this.scanLeaves(id),
        feed: await this.loadTransactions(id),
        voted: new Set(),
      });
    }
    if (ids === this.electionIds) {
      this.live = live;
      this.liveComplete = false;
    }
    return live;
  }

  private freshLive(): RaceLive[] {
    return this.config.ballot.races.map((race) => ({
      phase: "registration" as const,
      tally: race.candidates.map(() => 0),
      leaves: [],
      feed: [],
      voted: new Set<string>(),
    }));
  }

  private record(live: RaceLive[], index: number, item: RaceTransaction): void {
    const race = live[index];
    if (!race || race.feed.some((entry) => entry.signature === item.signature)) return;
    race.feed.unshift(item);
  }

  private async target(electionId: bigint): Promise<{ index: number; live: RaceLive[] }> {
    const index = this.electionIds.indexOf(electionId);
    if (index >= 0 && this.electionIds.length === this.config.ballot.races.length) {
      return { index, live: await this.state() };
    }
    for (const other of this.others.values()) {
      const position = other.ids.indexOf(electionId);
      if (position >= 0) return { index: position, live: other.live };
    }
    throw new RelayError("BadRequest", "This proof is for an election that is not on this ballot");
  }

  private now(): number {
    return Math.floor(Date.now() / 1000);
  }

  private get methods(): any {
    return this.program.methods;
  }

  private get accounts(): any {
    return this.program.account;
  }

  electionAddress(id: bigint): PublicKey {
    const le = Buffer.alloc(8);
    le.writeBigUInt64LE(id);
    return PublicKey.findProgramAddressSync([Buffer.from("election"), le], this.programId)[0];
  }

  private requireIds(): bigint[] {
    if (this.electionIds.length !== this.config.ballot.races.length) {
      throw new RelayError("NoElection", "No ballot has been created yet");
    }
    return this.electionIds;
  }

  private raceFor(electionId: bigint): number {
    const index = this.requireIds().indexOf(electionId);
    if (index < 0) throw new RelayError("BadRequest", "This proof is for an election that is not on this ballot");
    return index;
  }

  async fundPayerIfLocal(): Promise<void> {
    const balance = await this.connection.getBalance(this.config.payer.publicKey);
    const local = /127\.0\.0\.1|localhost/.test(this.config.rpcUrl);
    if (balance >= (local ? 5 : 0.5) * LAMPORTS_PER_SOL) return;
    if (!local) {
      throw new Error(`The fee payer ${this.config.payer.publicKey.toBase58()} needs funds on ${this.config.rpcUrl}`);
    }
    const signature = await this.connection.requestAirdrop(this.config.payer.publicKey, 100 * LAMPORTS_PER_SOL);
    const latest = await this.connection.getLatestBlockhash();
    await this.connection.confirmTransaction({ signature, ...latest }, "confirmed");
  }

  async ensureBallot(): Promise<void> {
    if (this.electionIds.length === this.config.ballot.races.length) {
      const found = await Promise.all(this.electionIds.map((id) => this.connection.getAccountInfo(this.electionAddress(id))));
      if (found.every((account) => account !== null)) return;
    }
    await this.createBallot();
  }

  async createBallot(chosen?: bigint[]): Promise<void> {
    this.switchTo(await this.createElections(chosen));
  }

  switchTo(ids: bigint[]): void {
    const key = ids.join(",");
    const known = this.others.get(key);
    this.others.delete(key);
    this.electionIds = ids;
    this.live = known ? known.live : null;
    this.liveComplete = Boolean(known);
    this.loading = null;
    writeFileSync(this.config.statePath, JSON.stringify({ elections: ids.map(String) }) + "\n");
  }

  async createElections(chosen?: bigint[]): Promise<bigint[]> {
    const ids: bigint[] = [];
    for (const [index, race] of this.config.ballot.races.entries()) {
      const id = chosen?.[index] ?? randomBytes(8).readBigUInt64BE();
      await this.send(
        await this.methods
          .createElection(new BN(id.toString()), race.candidates.length, bytes(toBytes32BE(this.config.trustedKeyRoot)))
          .accountsPartial({
            authority: this.config.payer.publicKey,
            election: this.electionAddress(id),
            systemProgram: SystemProgram.programId,
          })
          .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: CU_LIMIT.createElection })])
          .transaction(),
        "createElection",
        false,
      );
      ids.push(id);
    }
    this.others.set(ids.join(","), { ids, live: this.freshLive() });
    return ids;
  }

  electionIdsNow(): bigint[] {
    return [...this.requireIds()];
  }

  async info(): Promise<BallotInfo> {
    const ids = this.requireIds();
    const live = await this.state();
    const { title, area, note, races } = this.config.ballot;
    return {
      title,
      area,
      note,
      programId: this.programId.toBase58(),
      phase: live[0]!.phase,
      registered: Math.max(...live.map((race) => race.leaves.filter(Boolean).length)),
      rpcUrl: this.config.publicRpcUrl,
      keyTree: this.config.keyTreeConfig,
      demoMode: this.config.demoMode,
      races: races.map((race, index) => ({
        index,
        office: race.office,
        district: race.district,
        electionId: ids[index]!.toString(),
        election: this.electionAddress(ids[index]!).toBase58(),
        candidates: race.candidates,
        tally: [...live[index]!.tally],
      })),
    };
  }

  async feed(): Promise<(RaceTransaction & { race: number })[]> {
    const live = await this.state();
    return live
      .flatMap((race, index) => race.feed.map((item) => ({ ...item, race: index })))
      .sort((a, b) => (b.time ?? 0) - (a.time ?? 0));
  }

  async electionRoot(electionId: bigint): Promise<string> {
    const leaves = await this.fetchLeaves(electionId);
    const tree = new IncrementalMerkleTree(
      TREE_DEPTH,
      leaves.map((leaf) => BigInt("0x" + leaf)),
    );
    return tree.root.toString(16).padStart(64, "0");
  }

  async hasVoted(electionId: bigint, nullifier: bigint): Promise<boolean> {
    const index = this.raceFor(electionId);
    const live = await this.state();
    if (live[index]!.voted.has(nullifier.toString())) return true;
    if (this.liveComplete) return false;
    const election = this.electionAddress(electionId);
    const address = PublicKey.findProgramAddressSync(
      [Buffer.from("vn"), election.toBuffer(), Buffer.from(toBytes32BE(nullifier))],
      this.programId,
    )[0];
    return (await this.connection.getAccountInfo(address, "confirmed")) !== null;
  }

  async fetchLeaves(electionId: bigint): Promise<string[]> {
    const index = this.raceFor(electionId);
    const live = await this.state();
    const known = live[index]!.leaves;
    if (known.length === 0 || known.every((leaf) => leaf !== undefined)) return [...known];
    try {
      return await this.scanLeaves(electionId);
    } catch (e) {
      const account = await this.accounts.election.fetch(this.electionAddress(electionId));
      const cached = this.scans.get(electionId.toString())?.leaves ?? [];
      const complete = cached.length === account.nextIndex && cached.every((leaf) => leaf !== undefined);
      if (complete) return [...cached];
      throw e;
    }
  }

  private async scanLeaves(electionId: bigint): Promise<string[]> {
    const address = this.electionAddress(electionId);
    const key = electionId.toString();
    const scan = this.scans.get(key) ?? { leaves: [] };
    this.scans.set(key, scan);
    const fresh: string[] = [];
    let before: string | undefined;
    for (;;) {
      const page = await this.connection.getSignaturesForAddress(
        address,
        { before, until: scan.newest, limit: 1000 },
        "confirmed",
      );
      for (const entry of page) if (!entry.err) fresh.push(entry.signature);
      if (page.length < 1000) break;
      before = page[page.length - 1]!.signature;
    }
    const found: { index: number; commitment: string }[] = [];
    for (const signature of fresh.reverse()) {
      const tx = await this.connection.getTransaction(signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
      for (const event of this.parser.parseLogs(tx?.meta?.logMessages ?? [])) {
        if (event.name.toLowerCase() !== "registered") continue;
        const data = event.data as Record<string, unknown>;
        found.push({
          index: Number(data.leafIndex ?? data.leaf_index),
          commitment: hex32(data.commitment as number[]),
        });
      }
      scan.newest = signature;
    }
    for (const leaf of found.sort((a, b) => a.index - b.index)) scan.leaves[leaf.index] = leaf.commitment;
    return [...scan.leaves];
  }

  async transactions(electionId: bigint): Promise<RaceTransaction[]> {
    const index = this.raceFor(electionId);
    const live = await this.state();
    return [...live[index]!.feed];
  }

  private async loadTransactions(electionId: bigint): Promise<RaceTransaction[]> {
    const race = this.config.ballot.races[this.raceFor(electionId)]!;
    const entries = await this.connection.getSignaturesForAddress(
      this.electionAddress(electionId),
      { limit: 200 },
      "confirmed",
    );
    const out: RaceTransaction[] = [];
    for (const entry of entries) {
      let item = this.classified.get(entry.signature);
      if (item === undefined) {
        item = await this.classify(entry.signature, entry.err !== null, entry.blockTime ?? null, race.candidates);
        this.classified.set(entry.signature, item);
      }
      if (item) out.push(item);
    }
    return out;
  }

  private async classify(
    signature: string,
    failed: boolean,
    time: number | null,
    candidates: string[],
  ): Promise<RaceTransaction | null> {
    const tx = await this.connection.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    const logs = tx?.meta?.logMessages ?? [];
    const text = logs.join("\n");
    const isVote = text.includes("Instruction: CastVote");
    const isRegister = text.includes("Instruction: Register");
    if (failed) {
      const duplicate = text.includes("already in use");
      if (isVote) return { signature, time, kind: duplicate ? "double-vote" : "rejected" };
      if (isRegister) return { signature, time, kind: duplicate ? "double-registration" : "rejected" };
      return { signature, time, kind: "rejected" };
    }
    if (isRegister) return { signature, time, kind: "registered" };
    if (isVote) {
      const event = this.parser.parseLogs(logs).next().value as { data?: Record<string, unknown> } | undefined;
      const option = Number(event?.data?.option ?? -1);
      return { signature, time, kind: "vote", candidate: candidates[option] };
    }
    return null;
  }

  async register(body: ProofBody): Promise<string> {
    if (body.publicSignals.length !== 5) throw new RelayError("BadRequest", "Expected 5 public inputs");
    const proof = proofToSolana(body.proof);
    const inputs = publicSignalsToBytes(body.publicSignals);
    const electionId = BigInt(body.publicSignals[REGISTER_INPUT.electionId]!);
    const { index, live } = await this.target(electionId);
    const election = this.electionAddress(electionId);
    const nullifier = inputs[REGISTER_INPUT.passportNullifier]!;
    const tx = await this.methods
      .register(
        { a: bytes(proof.a), b: bytes(proof.b), c: bytes(proof.c) },
        {
          passportNullifier: bytes(nullifier),
          commitment: bytes(inputs[REGISTER_INPUT.commitment]!),
          electionId: bytes(inputs[REGISTER_INPUT.electionId]!),
          currentDate: bytes(inputs[REGISTER_INPUT.currentDate]!),
          trustedKeyRoot: bytes(inputs[REGISTER_INPUT.trustedKeyRoot]!),
        },
      )
      .accountsPartial({
        payer: this.config.payer.publicKey,
        election,
        passportNullifier: PublicKey.findProgramAddressSync(
          [Buffer.from("pn"), election.toBuffer(), Buffer.from(nullifier)],
          this.programId,
        )[0],
        systemProgram: SystemProgram.programId,
      })
      .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: CU_LIMIT.register })])
      .transaction();
    let signature: string;
    try {
      signature = await this.send(tx, "register", this.config.demoMode);
    } catch (e) {
      if (e instanceof RelayError && e.signature) {
        this.record(live, index, {
          signature: e.signature,
          time: this.now(),
          kind: e.code === "AlreadyRegistered" ? "double-registration" : "rejected",
        });
      }
      throw e;
    }
    const leaf = await this.registeredLeaf(signature);
    if (leaf) live[index]!.leaves[leaf.index] = leaf.commitment;
    this.record(live, index, { signature, time: this.now(), kind: "registered" });
    return signature;
  }

  private async registeredLeaf(signature: string): Promise<{ index: number; commitment: string } | null> {
    for (let attempt = 0; attempt < 10; attempt++) {
      const tx = await this.connection.getTransaction(signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
      if (tx) {
        for (const event of this.parser.parseLogs(tx.meta?.logMessages ?? [])) {
          if (event.name.toLowerCase() !== "registered") continue;
          const data = event.data as Record<string, unknown>;
          return { index: Number(data.leafIndex ?? data.leaf_index), commitment: hex32(data.commitment as number[]) };
        }
        return null;
      }
      await pause(500);
    }
    return null;
  }

  async vote(body: ProofBody): Promise<string> {
    if (body.publicSignals.length !== 4) throw new RelayError("BadRequest", "Expected 4 public inputs");
    const proof = proofToSolana(body.proof);
    const inputs = publicSignalsToBytes(body.publicSignals);
    const electionId = BigInt(body.publicSignals[VOTE_INPUT.electionId]!);
    const index = this.raceFor(electionId);
    const live = await this.state();
    const election = this.electionAddress(electionId);
    const nullifier = inputs[VOTE_INPUT.voteNullifier]!;
    const tx = await this.methods
      .castVote(
        { a: bytes(proof.a), b: bytes(proof.b), c: bytes(proof.c) },
        {
          root: bytes(inputs[VOTE_INPUT.root]!),
          voteNullifier: bytes(nullifier),
          vote: bytes(inputs[VOTE_INPUT.vote]!),
          electionId: bytes(inputs[VOTE_INPUT.electionId]!),
        },
      )
      .accountsPartial({
        payer: this.config.payer.publicKey,
        election,
        voteNullifier: PublicKey.findProgramAddressSync(
          [Buffer.from("vn"), election.toBuffer(), Buffer.from(nullifier)],
          this.programId,
        )[0],
        systemProgram: SystemProgram.programId,
      })
      .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: CU_LIMIT.castVote })])
      .transaction();
    const option = Number(body.publicSignals[VOTE_INPUT.vote]);
    let signature: string;
    try {
      signature = await this.send(tx, "vote", this.config.demoMode);
    } catch (e) {
      if (e instanceof RelayError && e.signature) {
        this.record(live, index, {
          signature: e.signature,
          time: this.now(),
          kind: e.code === "AlreadyVoted" ? "double-vote" : "rejected",
        });
      }
      throw e;
    }
    const race = live[index]!;
    race.voted.add(BigInt(body.publicSignals[VOTE_INPUT.voteNullifier]!).toString());
    if (option >= 0 && option < race.tally.length) race.tally[option]! += 1;
    this.record(live, index, {
      signature,
      time: this.now(),
      kind: "vote",
      candidate: this.config.ballot.races[index]!.candidates[option],
    });
    return signature;
  }

  async openVoting(): Promise<string[]> {
    const signatures: string[] = [];
    for (const id of this.requireIds()) {
      signatures.push(
        await this.send(
          await this.methods
            .openVoting()
            .accountsPartial({ authority: this.config.payer.publicKey, election: this.electionAddress(id) })
            .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: CU_LIMIT.phase })])
            .transaction(),
          "openVoting",
          false,
        ),
      );
    }
    for (const race of this.live ?? []) race.phase = "voting";
    return signatures;
  }

  async closeVoting(): Promise<string[]> {
    const signatures: string[] = [];
    for (const id of this.requireIds()) {
      signatures.push(
        await this.send(
          await this.methods
            .closeElection()
            .accountsPartial({ authority: this.config.payer.publicKey, election: this.electionAddress(id) })
            .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: CU_LIMIT.phase })])
            .transaction(),
          "closeVoting",
          false,
        ),
      );
    }
    for (const race of this.live ?? []) race.phase = "closed";
    return signatures;
  }

  private async confirm(signature: string, lastValidBlockHeight: number): Promise<unknown> {
    const local = /127\.0\.0\.1|localhost/.test(this.config.rpcUrl);
    for (let round = 0; ; round++) {
      const { value } = await this.connection.getSignatureStatuses([signature]);
      const status = value[0];
      if (status && (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized")) {
        return status.err;
      }
      if (round % 8 === 7 && (await this.connection.getBlockHeight("confirmed")) > lastValidBlockHeight) {
        throw new RelayError("TransactionFailed", "The transaction was not confirmed in time");
      }
      await pause(local ? 300 : 1000);
    }
  }

  private async send(tx: Transaction, action: string, skipPreflight: boolean): Promise<string> {
    const latest = await this.connection.getLatestBlockhash("confirmed");
    tx.feePayer = this.config.payer.publicKey;
    tx.recentBlockhash = latest.blockhash;
    tx.sign(this.config.payer);
    let signature: string;
    try {
      signature = await this.connection.sendRawTransaction(tx.serialize(), { skipPreflight });
    } catch (e) {
      const logs = (e as { logs?: string[] }).logs ?? [];
      throw explain(action, [String((e as Error).message), ...logs]);
    }
    const failure = await this.confirm(signature, latest.lastValidBlockHeight);
    if (failure) {
      const failed = await this.connection.getTransaction(signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
      throw explain(action, failed?.meta?.logMessages ?? [JSON.stringify(failure)], signature);
    }
    return signature;
  }
}

const MESSAGES: Record<string, string> = {
  WrongPhase: "The election is not open for this action right now",
  ElectionMismatch: "This proof is for a different election",
  RootMismatch: "The voter list changed. Please try again",
  KeyRootMismatch: "This proof is for a different list of trusted passport keys",
  StaleDate: "This proof is too old. Please create it again",
  InvalidOption: "That option is not on the ballot",
  InvalidProof: "The proof did not verify",
  TreeFull: "The voter list is full",
};

function explain(action: string, lines: string[], signature?: string): RelayError {
  const text = lines.join("\n");
  if (text.includes("already in use")) {
    return action === "register"
      ? new RelayError("AlreadyRegistered", "This passport has already registered", signature)
      : new RelayError("AlreadyVoted", "This code has already voted", signature);
  }
  const code = /Error Code: (\w+)/.exec(text)?.[1];
  if (code) return new RelayError(code, MESSAGES[code] ?? `The program rejected the transaction (${code})`, signature);
  return new RelayError("TransactionFailed", "The transaction failed", signature);
}
