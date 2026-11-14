import { BN254_FQ, BN254_FR } from "@zk-election/constants";

export interface SnarkjsProof {
  pi_a: string[];
  pi_b: string[][];
  pi_c: string[];
  protocol?: string;
  curve?: string;
}

export interface SolanaProof {
  a: Uint8Array;
  b: Uint8Array;
  c: Uint8Array;
}

export function toBytes32BE(value: bigint | string | number): Uint8Array {
  let v = BigInt(value);
  if (v < 0n) throw new Error("Negative value");
  const out = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  if (v !== 0n) throw new Error("Value does not fit in 32 bytes");
  return out;
}

export function fromBytes32BE(bytes: Uint8Array): bigint {
  if (bytes.length !== 32) throw new Error("Expected 32 bytes");
  let x = 0n;
  for (const b of bytes) x = (x << 8n) | BigInt(b);
  return x;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function coord(s: string | undefined): bigint {
  if (s === undefined) throw new Error("Malformed proof");
  const v = BigInt(s);
  if (v < 0n || v >= BN254_FQ) throw new Error("Proof coordinate out of range");
  return v;
}

export function proofToSolana(proof: SnarkjsProof): SolanaProof {
  const ax = coord(proof.pi_a[0]);
  const ay = coord(proof.pi_a[1]);
  const negAy = ay === 0n ? 0n : BN254_FQ - ay;
  const [bx, by] = [proof.pi_b[0], proof.pi_b[1]];
  if (!bx || !by) throw new Error("Malformed proof");
  return {
    a: concat([toBytes32BE(ax), toBytes32BE(negAy)]),
    b: concat([
      toBytes32BE(coord(bx[1])),
      toBytes32BE(coord(bx[0])),
      toBytes32BE(coord(by[1])),
      toBytes32BE(coord(by[0])),
    ]),
    c: concat([toBytes32BE(coord(proof.pi_c[0])), toBytes32BE(coord(proof.pi_c[1]))]),
  };
}

export function publicSignalsToBytes(signals: readonly (string | bigint)[]): Uint8Array[] {
  return signals.map((s) => {
    const v = BigInt(s);
    if (v >= BN254_FR) throw new Error("Public input is not a field element");
    return toBytes32BE(v);
  });
}

export const VOTE_INPUT = { root: 0, voteNullifier: 1, vote: 2, electionId: 3 } as const;
export const REGISTER_INPUT = {
  passportNullifier: 0,
  commitment: 1,
  electionId: 2,
  currentDate: 3,
  trustedKeyRoot: 4,
} as const;
