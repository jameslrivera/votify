import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TREE_DEPTH } from "@zk-election/constants";
import { IncrementalMerkleTree, commitment, randomCredential } from "@zk-election/merkle";
import { fromPassportFile } from "@zk-election/passport";
import {
  type Ctx,
  castVote,
  createElection,
  failure,
  fetchElection,
  makeCtx,
  openVoting,
  proveRegistration,
  proveVote,
  register,
  shutdownProver,
} from "./client.ts";
import { repoRoot } from "./env.ts";

let ctx: Ctx;
beforeAll(async () => {
  ctx = await makeCtx();
});
afterAll(shutdownProver);

describe("end to end with a mock passport", () => {
  it("registers, votes, counts, and puts no passport field on chain", async () => {
    const passport = fromPassportFile(
      JSON.parse(readFileSync(join(repoRoot, "test-vectors", "passports", "valid-adult.mock.json"), "utf8")),
    );
    const cred = randomCredential();
    const { electionId, election } = await createElection(ctx, 3);

    const registerSig = await register(ctx, election, await proveRegistration(passport, cred, electionId));
    const second = await proveRegistration(passport, randomCredential(), electionId);
    expect(await failure(() => register(ctx, election, second))).toContain("already in use");

    const tree = new IncrementalMerkleTree(TREE_DEPTH, [commitment(cred, electionId)]);
    expect((await fetchElection(ctx, election)).root).toBe(tree.root);

    await openVoting(ctx, election);
    const voteSig = await castVote(ctx, election, await proveVote(cred, tree, electionId, 2));
    expect((await fetchElection(ctx, election)).tally).toEqual([0, 0, 1, 0, 0, 0, 0, 0]);

    const mrz = new TextDecoder().decode(passport.dg1.subarray(5));
    const fields = [
      mrz.slice(44, 53),
      mrz.slice(57, 63),
      mrz.slice(65, 71),
      "MOCK<<PASSPORT",
    ];
    for (const sig of [registerSig, voteSig]) {
      const tx = await ctx.connection.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      const raw = Buffer.from(tx!.transaction.message.serialize());
      const logs = (tx!.meta?.logMessages ?? []).join("\n");
      for (const f of fields) {
        expect(raw.includes(Buffer.from(f, "utf8"))).toBe(false);
        expect(raw.toString("hex").includes(Buffer.from(f, "utf8").toString("hex"))).toBe(false);
        expect(logs.includes(f)).toBe(false);
        expect(logs.includes(Buffer.from(f, "utf8").toString("base64"))).toBe(false);
      }
      expect(raw.includes(Buffer.from(passport.dg1.subarray(5, 37)))).toBe(false);
    }
  });
});
