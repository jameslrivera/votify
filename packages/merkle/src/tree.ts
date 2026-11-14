import { poseidon2 } from "poseidon-lite";
import { TREE_DEPTH } from "@zk-election/constants";

export interface MerkleProof {
  leaf: bigint;
  index: number;
  pathElements: bigint[];
  pathIndex: number[];
  root: bigint;
}

export function zeroValues(depth: number = TREE_DEPTH): bigint[] {
  const zeros: bigint[] = [0n];
  for (let i = 0; i < depth; i++) {
    const z = zeros[i]!;
    zeros.push(poseidon2([z, z]));
  }
  return zeros;
}

export class IncrementalMerkleTree {
  readonly depth: number;
  readonly zeros: bigint[];
  private levels: bigint[][];

  constructor(depth: number = TREE_DEPTH, leaves: readonly bigint[] = []) {
    this.depth = depth;
    this.zeros = zeroValues(depth);
    this.levels = Array.from({ length: depth + 1 }, () => []);
    for (const leaf of leaves) this.insert(leaf);
  }

  get size(): number {
    return this.levels[0]!.length;
  }

  get leaves(): readonly bigint[] {
    return this.levels[0]!;
  }

  get root(): bigint {
    return this.levels[this.depth]![0] ?? this.zeros[this.depth]!;
  }

  insert(leaf: bigint): number {
    const index = this.size;
    if (index >= 2 ** this.depth) throw new Error("Merkle tree is full");
    this.levels[0]!.push(leaf);
    let i = index;
    for (let level = 0; level < this.depth; level++) {
      const parent = i >> 1;
      const left = this.levels[level]![parent * 2]!;
      const right = this.levels[level]![parent * 2 + 1] ?? this.zeros[level]!;
      this.levels[level + 1]![parent] = poseidon2([left, right]);
      i = parent;
    }
    return index;
  }

  indexOf(leaf: bigint): number {
    return this.levels[0]!.indexOf(leaf);
  }

  proof(index: number): MerkleProof {
    if (index < 0 || index >= this.size) throw new Error("Leaf index out of range");
    const pathElements: bigint[] = [];
    const pathIndex: number[] = [];
    let i = index;
    for (let level = 0; level < this.depth; level++) {
      pathIndex.push(i & 1);
      pathElements.push(this.levels[level]![i ^ 1] ?? this.zeros[level]!);
      i >>= 1;
    }
    return { leaf: this.levels[0]![index]!, index, pathElements, pathIndex, root: this.root };
  }
}

export function rootFromProof(p: Pick<MerkleProof, "leaf" | "pathElements" | "pathIndex">): bigint {
  let cur = p.leaf;
  for (let i = 0; i < p.pathElements.length; i++) {
    const sib = p.pathElements[i]!;
    cur = p.pathIndex[i] === 0 ? poseidon2([cur, sib]) : poseidon2([sib, cur]);
  }
  return cur;
}
