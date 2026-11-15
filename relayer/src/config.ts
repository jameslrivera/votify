import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair } from "@solana/web3.js";

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export interface RaceConfig {
  office: string;
  district: string;
  candidates: string[];
}

export interface BallotConfig {
  title: string;
  area: string;
  note: string;
  races: RaceConfig[];
}

export interface RelayerConfig {
  rpcUrl: string;
  publicRpcUrl: string;
  port: number;
  demoMode: boolean;
  adminToken: string;
  proofConcurrency: number;
  seedVoters: number;
  seedPaceMs: number;
  spareBallots: number;
  freshBallot: boolean;
  ballot: BallotConfig;
  keyTreeConfig: "demo" | "strict";
  trustedKeyRoot: bigint;
  statePath: string;
  payer: Keypair;
  artifactsDir: string;
  idlPath: string;
}

function loadOrCreateKeypair(path: string): Keypair {
  if (existsSync(path)) {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8")) as number[]));
  }
  mkdirSync(dirname(path), { recursive: true });
  const keypair = Keypair.generate();
  writeFileSync(path, JSON.stringify(Array.from(keypair.secretKey)), { mode: 0o600 });
  return keypair;
}

function loadBallot(path: string): BallotConfig {
  const ballot = JSON.parse(readFileSync(path, "utf8")) as BallotConfig;
  if (!Array.isArray(ballot.races) || ballot.races.length < 1 || ballot.races.length > 12) {
    throw new Error("The ballot needs 1 to 12 races");
  }
  for (const race of ballot.races) {
    if (!race.office || !race.district || !Array.isArray(race.candidates) || race.candidates.length < 2 || race.candidates.length > 8) {
      throw new Error(`Race "${race.office}" needs an office, a district and 2 to 8 candidates`);
    }
  }
  return ballot;
}

export function freshMarker(env: NodeJS.ProcessEnv = process.env): string {
  return (env.STATE_PATH ?? join(repoRoot, "relayer", ".state.json")) + ".fresh";
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RelayerConfig {
  const keyTreeConfig = env.KEY_TREE === "strict" ? "strict" : "demo";
  const keyTree = JSON.parse(
    readFileSync(join(repoRoot, "test-vectors", `key-tree.${keyTreeConfig}.json`), "utf8"),
  ) as { root: string };
  const rpcUrl = env.RPC_URL ?? "http://127.0.0.1:8899";
  return {
    rpcUrl,
    publicRpcUrl: env.PUBLIC_RPC_URL ?? rpcUrl,
    port: Number(env.PORT ?? 8787),
    demoMode: env.DEMO_MODE === "true",
    adminToken: env.ADMIN_TOKEN ?? "",
    proofConcurrency: Math.max(1, Number(env.PROOF_CONCURRENCY ?? 3) || 3),
    seedVoters: Math.min(60, Math.max(0, Number(env.SEED_VOTERS ?? 0) || 0)),
    freshBallot: env.FRESH_BALLOT === "true" || existsSync(freshMarker(env)),
    seedPaceMs: Math.max(0, Number(env.SEED_PACE_MS ?? 2500) || 0),
    spareBallots: Math.min(5, Math.max(0, Number(env.SPARE_BALLOTS ?? 2) || 0)),
    ballot: loadBallot(env.BALLOT ?? join(repoRoot, "config", "ballot.emory.json")),
    keyTreeConfig,
    trustedKeyRoot: BigInt("0x" + keyTree.root),
    statePath: env.STATE_PATH ?? join(repoRoot, "relayer", ".state.json"),
    payer: loadOrCreateKeypair(env.RELAYER_KEYPAIR ?? join(repoRoot, "relayer", ".keys", "fee-payer.json")),
    artifactsDir: join(repoRoot, "circuits", "build"),
    idlPath: join(repoRoot, "target", "idl", "zk_election.json"),
  };
}
