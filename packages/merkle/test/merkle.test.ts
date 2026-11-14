import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { TREE_DEPTH } from "@zk-election/constants";
import {
  IncrementalMerkleTree,
  commitment,
  decodeCredential,
  encodeCredential,
  randomCredential,
  rootFromProof,
  voteNullifier,
  zeroValues,
} from "../src/index.ts";

const load = (name: string) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../../test-vectors/${name}`, import.meta.url)), "utf8"));
const h = (s: string) => BigInt("0x" + s);

describe("IncrementalMerkleTree", () => {
  const vec = load("merkle.json");

  it("matches the cross-language vectors", () => {
    expect(vec.depth).toBe(TREE_DEPTH);
    expect(zeroValues().map((z) => z)).toEqual(vec.zeros.map(h));
    const tree = new IncrementalMerkleTree();
    expect(tree.root).toBe(h(vec.emptyRoot));
    vec.leaves.forEach((leaf: string, i: number) => {
      tree.insert(h(leaf));
      expect(tree.root).toBe(h(vec.rootsAfterInsert[i]));
    });
    const p = tree.proof(2);
    expect(p.pathElements).toEqual(vec.proofForIndex2.pathElements.map(h));
    expect(p.pathIndex).toEqual(vec.proofForIndex2.pathIndex);
  });

  it("produces proofs that recompute the root for every leaf", () => {
    const tree = new IncrementalMerkleTree(TREE_DEPTH, [5n, 6n, 7n, 8n, 9n, 10n, 11n]);
    for (let i = 0; i < tree.size; i++) expect(rootFromProof(tree.proof(i))).toBe(tree.root);
    expect(tree.indexOf(9n)).toBe(4);
    expect(tree.indexOf(99n)).toBe(-1);
    expect(() => tree.proof(7)).toThrow();
  });

  it("refuses to overflow", () => {
    const tiny = new IncrementalMerkleTree(1, [1n, 2n]);
    expect(() => tiny.insert(3n)).toThrow("full");
  });
});

describe("credential", () => {
  it("matches the cross-language vector", () => {
    const v = load("credential.json");
    const cred = { secret: h(v.secret), nullifierKey: h(v.nullifierKey) };
    expect(commitment(cred, h(v.electionId))).toBe(h(v.commitment));
    expect(voteNullifier(cred.nullifierKey, h(v.electionId))).toBe(h(v.voteNullifier));
  });

  it("round-trips through the QR payload", () => {
    const cred = randomCredential();
    expect(cred.secret < 1n << 248n && cred.nullifierKey < 1n << 248n).toBe(true);
    const payload = encodeCredential(cred);
    expect(payload).toMatch(/^zkv1:[A-Za-z0-9_-]+$/);
    expect(decodeCredential(payload)).toEqual(cred);
  });

  it("rejects malformed payloads", () => {
    expect(() => decodeCredential("hello")).toThrow();
    expect(() => decodeCredential("zkv1:AAAA")).toThrow("length");
    expect(() => decodeCredential("zkv2:" + encodeCredential(randomCredential()).slice(5))).toThrow();
  });

  it("binds the election into commitment and nullifier", () => {
    const cred = randomCredential();
    expect(commitment(cred, 1n)).not.toBe(commitment(cred, 2n));
    expect(voteNullifier(cred.nullifierKey, 1n)).not.toBe(voteNullifier(cred.nullifierKey, 2n));
  });
});
