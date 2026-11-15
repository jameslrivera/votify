import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TREE_DEPTH } from "@zk-election/constants";
import { IncrementalMerkleTree, commitment, randomCredential } from "@zk-election/merkle";
import { Chain } from "../../relayer/src/chain.ts";
import { loadConfig } from "../../relayer/src/config.ts";
import { createRelayer } from "../../relayer/src/server.ts";
import { mockPassport, proveRegistration, proveVote, shutdownProver } from "./client.ts";
import { RPC_URL } from "./env.ts";

let server: Server;
let base: string;
let dir: string;
const logged: unknown[][] = [];

async function call(path: string, body?: unknown) {
  const res = await fetch(base + path, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "zk-election-relayer-"));
  const config = loadConfig({
    RPC_URL,
    DEMO_MODE: "true",
    STATE_PATH: join(dir, "state.json"),
    RELAYER_KEYPAIR: join(dir, "fee-payer.json"),
  });
  const chain = new Chain(config);
  await chain.fundPayerIfLocal();
  await chain.ensureBallot();
  for (const method of ["log", "info", "warn", "error"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void logged.push(args));
  }
  server = createRelayer(config, chain);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
  await shutdownProver();
});

describe("relayer", () => {
  it("serves the ballot, routes proofs by election and explains rejections", async () => {
    const ballot = (await call("/ballot")).body;
    expect(ballot.phase).toBe("registration");
    expect(ballot.title).toBe("2026 Midterm Election");
    expect(ballot.area).toBe("DeKalb County, Georgia");
    expect(ballot.keyTree).toBe("demo");
    expect(ballot.races.map((r: any) => r.office)).toEqual([
      "Governor",
      "U.S. House",
      "County Commission",
    ]);
    expect(ballot.races[1].district).toBe("Georgia's 5th District");
    expect(new Set(ballot.races.map((r: any) => r.electionId)).size).toBe(3);

    const race = ballot.races[1];
    const electionId = BigInt(race.electionId);
    expect((await call(`/leaves?election=${race.electionId}`)).body.leaves).toEqual([]);
    expect((await call("/leaves")).status).toBe(400);
    expect((await call("/leaves?election=12345")).status).toBe(400);

    const passport = mockPassport();
    const cred = randomCredential();
    const registered = await call("/register", await proveRegistration(passport, cred, electionId));
    expect(registered.status).toBe(200);
    expect(registered.body.signature).toMatch(/^[1-9A-HJ-NP-Za-km-z]{80,90}$/);

    const again = await call("/register", await proveRegistration(passport, randomCredential(), electionId));
    expect(again.status).toBe(409);
    expect(again.body.error).toBe("AlreadyRegistered");
    expect(again.body.signature).toBeTruthy();

    const leaves = (await call(`/leaves?election=${race.electionId}`)).body.leaves as string[];
    const tree = new IncrementalMerkleTree(TREE_DEPTH, leaves.map((l) => BigInt("0x" + l)));
    expect(leaves.length).toBe(1);
    expect(tree.indexOf(commitment(cred, electionId))).toBe(0);
    expect((await call(`/leaves?election=${ballot.races[0].electionId}`)).body.leaves).toEqual([]);

    const early = await call("/vote", await proveVote(cred, tree, electionId, 1));
    expect(early.body.error).toBe("WrongPhase");

    const opened = await call("/demo/open-voting", {});
    expect(opened.status).toBe(200);
    expect(opened.body.signatures.length).toBe(3);

    expect((await call("/vote", await proveVote(cred, tree, electionId, 1))).status).toBe(200);
    const second = await call("/vote", await proveVote(cred, tree, electionId, 0));
    expect(second.status).toBe(409);
    expect(second.body.error).toBe("AlreadyVoted");
    expect(second.body.signature).toBeTruthy();

    const strangerElection = 987654321n;
    const strangerTree = new IncrementalMerkleTree(TREE_DEPTH, [commitment(cred, strangerElection)]);
    const unknown = await call("/vote", await proveVote(cred, strangerTree, strangerElection, 0));
    expect(unknown.status).toBe(400);

    const history = (await call(`/transactions?election=${race.electionId}`)).body.transactions as any[];
    expect(history.map((t) => t.kind)).toEqual(["double-vote", "vote", "rejected", "double-registration", "registered"]);
    expect(history[1].candidate).toBe(race.candidates[1]);
    expect(history[1].signature).toMatch(/^[1-9A-HJ-NP-Za-km-z]{80,90}$/);
    expect(typeof history[1].time).toBe("number");
    expect((await call(`/transactions?election=${ballot.races[0].electionId}`)).body.transactions).toEqual([]);
    expect((await call("/transactions")).status).toBe(400);

    const after = (await call("/ballot")).body;
    expect(after.phase).toBe("voting");
    expect(after.races[1].tally).toEqual([0, 1]);
    expect(after.races[0].tally).toEqual([0, 0, 0]);

    const reset = await call("/demo/reset", {});
    expect(reset.status).toBe(200);
    expect(reset.body.phase).toBe("registration");
    expect(reset.body.registered).toBe(0);
    expect(reset.body.races[1].electionId).not.toBe(race.electionId);
  });

  it("registers a phone credential in every race", async () => {
    const hex = { secretHex: "ab".repeat(31), nullifierKeyHex: "cd".repeat(31) };
    expect((await call("/demo/register-mock", { secretHex: "xyz", nullifierKeyHex: hex.nullifierKeyHex })).status).toBe(400);

    const result = await call("/demo/register-mock", hex);
    expect(result.status).toBe(200);
    expect(result.body.registrations.length).toBe(3);

    const phone = { secret: BigInt("0x" + hex.secretHex), nullifierKey: BigInt("0x" + hex.nullifierKeyHex) };
    const ballot = (await call("/ballot")).body;
    expect(ballot.registered).toBe(1);
    for (const race of ballot.races) {
      const leaves = (await call(`/leaves?election=${race.electionId}`)).body.leaves as string[];
      expect(leaves.length).toBe(1);
      expect(BigInt("0x" + leaves[0]!)).toBe(commitment(phone, BigInt(race.electionId)));
    }

    await call("/demo/open-voting", {});
    const closed = await call("/demo/register-mock", hex);
    expect(closed.status).toBe(409);
    expect(closed.body.error).toBe("WrongPhase");
  });

  it("rejects malformed requests and unknown paths", async () => {
    expect((await call("/vote", { proof: 1 })).status).toBe(400);
    expect((await call("/register", { proof: {}, publicSignals: ["x"] })).status).toBe(400);
    expect((await call("/nope")).status).toBe(404);
    expect((await fetch(base + "/artifacts/vote.wasm")).status).toBe(200);
    expect((await fetch(base + "/artifacts/..%2F..%2Fpackage.json")).status).toBe(404);
  });

  it("logs nothing about requests", () => {
    expect(logged).toEqual([]);
  });
});
