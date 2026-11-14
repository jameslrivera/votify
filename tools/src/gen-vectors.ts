import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { poseidon2, poseidon3 } from "poseidon-lite";
import { TREE_DEPTH } from "@zk-election/constants";
import { IncrementalMerkleTree, commitment, voteNullifier, zeroValues } from "@zk-election/merkle";
import { vectorsDir, programSrc } from "./paths.ts";
import { toBytes32BE } from "@zk-election/proof-format";

const hex = (x: bigint) => Buffer.from(toBytes32BE(x)).toString("hex");
mkdirSync(vectorsDir, { recursive: true });

const poseidon = {
  note: "circomlib Poseidon over BN254 Fr. Inputs and outputs are 32-byte big-endian hex.",
  hash2: [
    [1n, 2n],
    [0n, 0n],
    [123456789n, 987654321n],
  ].map(([a, b]) => ({ inputs: [hex(a!), hex(b!)], output: hex(poseidon2([a!, b!])) })),
  hash3: [[1n, 2n, 3n]].map(([a, b, c]) => ({
    inputs: [hex(a!), hex(b!), hex(c!)],
    output: hex(poseidon3([a!, b!, c!])),
  })),
};
writeFileSync(join(vectorsDir, "poseidon.json"), JSON.stringify(poseidon, null, 2) + "\n");

const zeros = zeroValues(TREE_DEPTH);
const leaves = [11n, 22n, 33n, 44n, 55n];
const tree = new IncrementalMerkleTree(TREE_DEPTH);
const rootsAfterInsert: string[] = [];
for (const l of leaves) {
  tree.insert(l);
  rootsAfterInsert.push(hex(tree.root));
}
const proof = tree.proof(2);
const merkle = {
  note: "Incremental binary Poseidon tree. Empty leaf = 0. All values 32-byte big-endian hex.",
  depth: TREE_DEPTH,
  zeros: zeros.map(hex),
  emptyRoot: hex(zeros[TREE_DEPTH]!),
  leaves: leaves.map(hex),
  rootsAfterInsert,
  proofForIndex2: {
    leaf: hex(proof.leaf),
    pathElements: proof.pathElements.map(hex),
    pathIndex: proof.pathIndex,
    root: hex(proof.root),
  },
};
writeFileSync(join(vectorsDir, "merkle.json"), JSON.stringify(merkle, null, 2) + "\n");

const cred = { secret: 0x0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1fn, nullifierKey: 0x1f1e1d1c1b1a191817161514131211100f0e0d0c0b0a090807060504030201n };
const electionId = 0x1122334455667788n;
const credential = {
  note: "commitment = Poseidon(secret, nullifier_key, election_id); vote_nullifier = Poseidon(nullifier_key, election_id).",
  secret: hex(cred.secret),
  nullifierKey: hex(cred.nullifierKey),
  electionId: hex(electionId),
  commitment: hex(commitment(cred, electionId)),
  voteNullifier: hex(voteNullifier(cred.nullifierKey, electionId)),
};
writeFileSync(join(vectorsDir, "credential.json"), JSON.stringify(credential, null, 2) + "\n");

const rows = zeros
  .map((z) => `    [${[...toBytes32BE(z)].join(", ")}],`)
  .join("\n");
writeFileSync(
  join(programSrc, "zeros.rs"),
  `#![cfg_attr(rustfmt, rustfmt_skip)]

pub const ZEROS: [[u8; 32]; ${TREE_DEPTH + 1}] = [
${rows}
];
`,
);
console.log("wrote test vectors and zeros.rs");
