import { afterAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as snarkjs from "snarkjs";
import { TREE_DEPTH } from "@zk-election/constants";
import { IncrementalMerkleTree, commitment, randomCredential, voteNullifier } from "@zk-election/merkle";

const build = (f: string) => fileURLToPath(new URL(`../build/vote/${f}`, import.meta.url));
const wasm = build("vote.wasm");
const zkey = build("vote.zkey");
const vk = JSON.parse(readFileSync(build("verification_key.json"), "utf8"));

const electionId = 0xabcdef0123456789n;
const cred = randomCredential();
const tree = new IncrementalMerkleTree(TREE_DEPTH, [111n, commitment(cred, electionId), 333n]);
const path = tree.proof(1);

function input(over: Record<string, unknown> = {}) {
  return {
    root: path.root.toString(),
    vote_nullifier: voteNullifier(cred.nullifierKey, electionId).toString(),
    vote: "2",
    election_id: electionId.toString(),
    secret: cred.secret.toString(),
    nullifier_key: cred.nullifierKey.toString(),
    path_elements: path.pathElements.map(String),
    path_index: path.pathIndex.map(String),
    ...over,
  };
}
const prove = (over?: Record<string, unknown>) => snarkjs.groth16.fullProve(input(over), wasm, zkey);

afterAll(async () => {
  await (globalThis as { curve_bn128?: { terminate(): Promise<void> } }).curve_bn128?.terminate();
});

describe("vote circuit", () => {
  it("proves a valid vote with public inputs in the order [root, vote_nullifier, vote, election_id]", async () => {
    const { proof, publicSignals } = await prove();
    expect(publicSignals).toEqual([input().root, input().vote_nullifier, "2", input().election_id]);
    expect(await snarkjs.groth16.verify(vk, publicSignals, proof)).toBe(true);
  });

  it("binds vote: changing it after proving fails verification", async () => {
    const { proof, publicSignals } = await prove();
    const changed = [...publicSignals];
    changed[2] = "1";
    expect(await snarkjs.groth16.verify(vk, changed, proof)).toBe(false);
  });

  it("binds every other public input", async () => {
    const { proof, publicSignals } = await prove();
    for (const i of [0, 1, 3]) {
      const changed = [...publicSignals];
      changed[i] = (BigInt(changed[i]!) + 1n).toString();
      expect(await snarkjs.groth16.verify(vk, changed, proof)).toBe(false);
    }
  });

  it("constraint 1: rejects a wrong secret (commitment not in tree)", async () => {
    await expect(prove({ secret: (cred.secret + 1n).toString() })).rejects.toThrow();
  });

  it("constraint 1: rejects a credential registered for another election", async () => {
    const other = electionId + 1n;
    await expect(
      prove({ election_id: other.toString(), vote_nullifier: voteNullifier(cred.nullifierKey, other).toString() }),
    ).rejects.toThrow();
  });

  it("constraint 2: rejects a wrong root, sibling or path index", async () => {
    await expect(prove({ root: (path.root + 1n).toString() })).rejects.toThrow();
    const elems = path.pathElements.map(String);
    elems[3] = "42";
    await expect(prove({ path_elements: elems })).rejects.toThrow();
    const idx = path.pathIndex.map(String);
    idx[0] = idx[0] === "0" ? "1" : "0";
    await expect(prove({ path_index: idx })).rejects.toThrow();
  });

  it("constraint 2: rejects a path index that is not a bit", async () => {
    const idx = path.pathIndex.map(String);
    idx[5] = "2";
    await expect(prove({ path_index: idx })).rejects.toThrow();
  });

  it("constraint 3: rejects a wrong nullifier", async () => {
    await expect(prove({ vote_nullifier: "12345" })).rejects.toThrow();
    await expect(
      prove({
        nullifier_key: (cred.nullifierKey + 1n).toString(),
        vote_nullifier: voteNullifier(cred.nullifierKey + 1n, electionId).toString(),
      }),
    ).rejects.toThrow();
  });
});
