import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as snarkjs from "snarkjs";
import { buildKeyTree, buildRegisterInput, loadMockKey, makeDg1, makeSod, yymmdd } from "@zk-election/passport";
import type { SnarkjsProof } from "@zk-election/proof-format";
import { RelayError, type ProofBody } from "./chain.ts";
import { repoRoot, type RelayerConfig } from "./config.ts";

const HEX_31_BYTES = /^[0-9a-f]{62}$/;

export interface DemoCredential {
  secretHex: string;
  nullifierKeyHex: string;
}

export function parseDemoCredential(value: unknown): DemoCredential {
  const body = value as Partial<DemoCredential> | null;
  if (
    !body ||
    typeof body.secretHex !== "string" ||
    typeof body.nullifierKeyHex !== "string" ||
    !HEX_31_BYTES.test(body.secretHex) ||
    !HEX_31_BYTES.test(body.nullifierKeyHex)
  ) {
    throw new RelayError("BadRequest", "Expected { secretHex, nullifierKeyHex }");
  }
  return { secretHex: body.secretHex, nullifierKeyHex: body.nullifierKeyHex };
}

let queue: Promise<unknown> = Promise.resolve();
let foreground = 0;
const prepared = new Map<string, { ids: string; proofs: Promise<ProofBody[]> }>();
const PREPARED_TTL_MS = 15 * 60 * 1000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const keyOf = (credential: DemoCredential): string => credential.secretHex + credential.nullifierKeyHex;

export function proveMockRegistrations(
  config: RelayerConfig,
  credential: DemoCredential,
  electionIds: bigint[],
): Promise<ProofBody[]> {
  const ids = electionIds.join(",");
  const ready = prepared.get(keyOf(credential));
  prepared.delete(keyOf(credential));
  if (ready && ready.ids === ids) return ready.proofs;
  foreground++;
  const run = queue.then(() => proveAll(config, credential, electionIds));
  queue = run.catch(() => undefined);
  void run.finally(() => foreground--).catch(() => undefined);
  return run;
}

export function prepareMockRegistrations(
  config: RelayerConfig,
  credential: DemoCredential,
  electionIds: bigint[],
): void {
  const key = keyOf(credential);
  if (prepared.has(key)) return;
  foreground++;
  const run = queue.then(() => proveAll(config, credential, electionIds));
  queue = run.catch(() => undefined);
  void run.finally(() => foreground--).catch(() => undefined);
  run.catch(() => prepared.delete(key));
  prepared.set(key, { ids: electionIds.join(","), proofs: run });
  setTimeout(() => prepared.delete(key), PREPARED_TTL_MS).unref();
}

export function proveMockRegistrationsInBackground(
  config: RelayerConfig,
  credential: DemoCredential,
  electionIds: bigint[],
  concurrency = 1,
): Promise<ProofBody[]> {
  return proveAll({ ...config, proofConcurrency: concurrency }, credential, electionIds, true);
}

async function proveAll(
  config: RelayerConfig,
  credential: DemoCredential,
  electionIds: bigint[],
  yieldToPhones = false,
): Promise<ProofBody[]> {
  if (config.keyTreeConfig !== "demo") {
    throw new RelayError("BadRequest", "Mock registration needs the demo key list");
  }
  const key = loadMockKey(readFileSync(join(repoRoot, "tools", "mock-keys", "mock-dsc.pem"), "utf8"));
  const dg1 = makeDg1({
    nationality: "USA",
    dateOfBirth: "900115",
    expiry: "991231",
    documentNumber: "P" + randomBytes(4).toString("hex").toUpperCase(),
  });
  const sod = makeSod(dg1, key);
  const keyTree = buildKeyTree([key.modulus]);
  const parsed = {
    secret: BigInt("0x" + credential.secretHex),
    nullifierKey: BigInt("0x" + credential.nullifierKeyHex),
  };
  const proveOne = async (electionId: bigint): Promise<ProofBody> => {
    while (yieldToPhones && foreground > 0) await sleep(250);
    const { input } = buildRegisterInput({
      dg1,
      sod,
      credential: parsed,
      electionId,
      currentDate: yymmdd(new Date()),
      keyTree,
    });
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(
      input,
      join(config.artifactsDir, "register", "register.wasm"),
      join(config.artifactsDir, "register", "register.zkey"),
    );
    return { proof: proof as SnarkjsProof, publicSignals };
  };
  const proofs: ProofBody[] = [];
  for (let i = 0; i < electionIds.length; i += config.proofConcurrency) {
    proofs.push(...(await Promise.all(electionIds.slice(i, i + config.proofConcurrency).map(proveOne))));
  }
  return proofs;
}
