import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { AnchorProvider, BN, Program, Wallet, type Idl } from "@anchor-lang/core";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import * as snarkjs from "snarkjs";
import { IncrementalMerkleTree, commitment, voteNullifier, type Credential } from "@zk-election/merkle";
import {
  buildKeyTree,
  buildRegisterInput,
  loadMockKey,
  makeDg1,
  makeSod,
  yymmdd,
  type MockIdentity,
  type MockKey,
} from "@zk-election/passport";
import {
  proofToSolana,
  publicSignalsToBytes,
  toBytes32BE,
  REGISTER_INPUT,
  VOTE_INPUT,
  type SnarkjsProof,
} from "@zk-election/proof-format";
import {
  RPC_URL,
  measurementsFile,
  mockKeyPem,
  registerWasm,
  registerZkey,
  repoRoot,
  untrustedKeyPem,
  voteWasm,
  voteZkey,
} from "./env.ts";

export const idl = JSON.parse(readFileSync(join(repoRoot, "target", "idl", "zk_election.json"), "utf8")) as Idl;
export const programId = new PublicKey((idl as { address: string }).address);

export const CU_LIMIT = { createElection: 50_000, register: 400_000, phase: 20_000, castVote: 250_000 };

export interface Ctx {
  connection: Connection;
  authority: Keypair;
  program: Program;
}

export async function makeCtx(): Promise<Ctx> {
  const connection = new Connection(RPC_URL, "confirmed");
  const authority = Keypair.generate();
  const sig = await connection.requestAirdrop(authority.publicKey, 100 * LAMPORTS_PER_SOL);
  const bh = await connection.getLatestBlockhash();
  await connection.confirmTransaction({ signature: sig, ...bh }, "confirmed");
  const provider = new AnchorProvider(connection, new Wallet(authority), {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
  return { connection, authority, program: new Program(idl, provider) };
}

export const bytes = (u: Uint8Array): number[] => Array.from(u);
export const field = (x: bigint): number[] => bytes(toBytes32BE(x));

export function randomElectionId(): bigint {
  return randomBytes(8).readBigUInt64BE();
}

export function electionPda(electionId: bigint): PublicKey {
  const le = Buffer.alloc(8);
  le.writeBigUInt64LE(electionId);
  return PublicKey.findProgramAddressSync([Buffer.from("election"), le], programId)[0];
}

export function voteNullifierPda(election: PublicKey, nullifier: bigint): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vn"), election.toBuffer(), Buffer.from(toBytes32BE(nullifier))],
    programId,
  )[0];
}

const methods = (ctx: Ctx): any => ctx.program.methods;
const limit = (units: number) => [ComputeBudgetProgram.setComputeUnitLimit({ units })];

export const mockDsc: MockKey = loadMockKey(readFileSync(mockKeyPem, "utf8"));
export const untrustedDsc: MockKey = loadMockKey(readFileSync(untrustedKeyPem, "utf8"));
export const keyTree = buildKeyTree([mockDsc.modulus]);

export async function createElection(
  ctx: Ctx,
  optionCount = 3,
  electionId = randomElectionId(),
  trustedKeyRoot = keyTree.root,
) {
  const election = electionPda(electionId);
  await methods(ctx)
    .createElection(new BN(electionId.toString()), optionCount, field(trustedKeyRoot))
    .accountsPartial({ authority: ctx.authority.publicKey, election, systemProgram: SystemProgram.programId })
    .preInstructions(limit(CU_LIMIT.createElection))
    .rpc();
  return { electionId, election };
}

export function passportNullifierPda(election: PublicKey, nullifier: bigint): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("pn"), election.toBuffer(), Buffer.from(toBytes32BE(nullifier))],
    programId,
  )[0];
}

export interface Passport {
  dg1: Uint8Array;
  sod: Uint8Array;
}

let passportCounter = 0;
export function mockPassport(over: Partial<MockIdentity> = {}, key: MockKey = mockDsc): Passport {
  passportCounter += 1;
  const dg1 = makeDg1({
    nationality: "USA",
    dateOfBirth: "900115",
    expiry: "991231",
    documentNumber: "T" + String(passportCounter).padStart(8, "0"),
    ...over,
  });
  return { dg1, sod: makeSod(dg1, key) };
}

export interface RegisterProof {
  proof: SnarkjsProof;
  publicSignals: string[];
  rawInputs?: Uint8Array[];
}

export async function proveRegistration(
  passport: Passport,
  cred: Credential,
  electionId: bigint,
  currentDate: number = yymmdd(new Date()),
): Promise<RegisterProof> {
  const { input } = buildRegisterInput({ ...passport, credential: cred, electionId, currentDate, keyTree });
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, registerWasm, registerZkey);
  return { proof: proof as SnarkjsProof, publicSignals };
}

export async function register(ctx: Ctx, election: PublicKey, rp: RegisterProof): Promise<string> {
  const p = proofToSolana(rp.proof);
  const pub = (rp.rawInputs ?? publicSignalsToBytes(rp.publicSignals)).map(bytes);
  return methods(ctx)
    .register(
      { a: bytes(p.a), b: bytes(p.b), c: bytes(p.c) },
      {
        passportNullifier: pub[REGISTER_INPUT.passportNullifier]!,
        commitment: pub[REGISTER_INPUT.commitment]!,
        electionId: pub[REGISTER_INPUT.electionId]!,
        currentDate: pub[REGISTER_INPUT.currentDate]!,
        trustedKeyRoot: pub[REGISTER_INPUT.trustedKeyRoot]!,
      },
    )
    .accountsPartial({
      payer: ctx.authority.publicKey,
      election,
      passportNullifier: passportNullifierPda(election, BigInt(rp.publicSignals[REGISTER_INPUT.passportNullifier]!)),
      systemProgram: SystemProgram.programId,
    })
    .preInstructions(limit(CU_LIMIT.register))
    .rpc();
}

export async function openVoting(ctx: Ctx, election: PublicKey): Promise<string> {
  return methods(ctx)
    .openVoting()
    .accountsPartial({ authority: ctx.authority.publicKey, election })
    .preInstructions(limit(CU_LIMIT.phase))
    .rpc();
}

export async function closeElection(ctx: Ctx, election: PublicKey): Promise<string> {
  return methods(ctx)
    .closeElection()
    .accountsPartial({ authority: ctx.authority.publicKey, election })
    .preInstructions(limit(CU_LIMIT.phase))
    .rpc();
}

export interface VoteProof {
  proof: SnarkjsProof;
  publicSignals: string[];
}

export async function proveVote(
  cred: Credential,
  tree: IncrementalMerkleTree,
  electionId: bigint,
  vote: number,
): Promise<VoteProof> {
  const index = tree.indexOf(commitment(cred, electionId));
  if (index < 0) throw new Error("credential is not in the tree");
  const path = tree.proof(index);
  const input = {
    root: path.root.toString(),
    vote_nullifier: voteNullifier(cred.nullifierKey, electionId).toString(),
    vote: vote.toString(),
    election_id: electionId.toString(),
    secret: cred.secret.toString(),
    nullifier_key: cred.nullifierKey.toString(),
    path_elements: path.pathElements.map(String),
    path_index: path.pathIndex.map(String),
  };
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, voteWasm, voteZkey);
  return { proof: proof as SnarkjsProof, publicSignals };
}

export async function castVote(ctx: Ctx, election: PublicKey, vp: VoteProof): Promise<string> {
  const p = proofToSolana(vp.proof);
  const pub = publicSignalsToBytes(vp.publicSignals).map(bytes);
  return methods(ctx)
    .castVote(
      { a: bytes(p.a), b: bytes(p.b), c: bytes(p.c) },
      {
        root: pub[VOTE_INPUT.root]!,
        voteNullifier: pub[VOTE_INPUT.voteNullifier]!,
        vote: pub[VOTE_INPUT.vote]!,
        electionId: pub[VOTE_INPUT.electionId]!,
      },
    )
    .accountsPartial({
      payer: ctx.authority.publicKey,
      election,
      voteNullifier: voteNullifierPda(election, BigInt(vp.publicSignals[VOTE_INPUT.voteNullifier]!)),
      systemProgram: SystemProgram.programId,
    })
    .preInstructions(limit(CU_LIMIT.castVote))
    .rpc();
}

export async function fetchElection(ctx: Ctx, election: PublicKey) {
  const acc = await (ctx.program.account as any).election.fetch(election);
  return {
    phase: Object.keys(acc.phase)[0] as "registration" | "voting" | "closed",
    optionCount: acc.optionCount as number,
    root: BigInt("0x" + Buffer.from(acc.root).toString("hex")),
    nextIndex: acc.nextIndex as number,
    tally: (acc.tally as BN[]).map((t) => Number(t.toString())),
  };
}

export async function computeUnits(ctx: Ctx, signature: string): Promise<number> {
  const tx = await ctx.connection.getTransaction(signature, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  const cu = tx?.meta?.computeUnitsConsumed;
  if (cu === undefined) throw new Error("transaction not found");
  return cu;
}

export function recordMeasurement(key: string, value: number): void {
  const all = existsSync(measurementsFile) ? JSON.parse(readFileSync(measurementsFile, "utf8")) : {};
  all[key] = value;
  writeFileSync(measurementsFile, JSON.stringify(all, null, 2) + "\n");
}

export async function failure(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (e) {
    const err = e as { message?: string; logs?: string[]; error?: { errorCode?: { code?: string } } };
    return [err.error?.errorCode?.code ?? "", err.message ?? String(e), ...(err.logs ?? [])].join("\n");
  }
  throw new Error("expected the transaction to fail, but it succeeded");
}

export async function shutdownProver(): Promise<void> {
  await (globalThis as { curve_bn128?: { terminate(): Promise<void> } }).curve_bn128?.terminate();
}
