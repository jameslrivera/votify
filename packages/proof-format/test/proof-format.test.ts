import { describe, expect, it } from "vitest";
import { BN254_FQ, BN254_FR } from "@zk-election/constants";
import { fromBytes32BE, proofToSolana, publicSignalsToBytes, toBytes32BE } from "../src/index.ts";

const hex = (u: Uint8Array) => Buffer.from(u).toString("hex");

describe("proof-format", () => {
  it("encodes 32-byte big-endian values", () => {
    expect(hex(toBytes32BE(1n))).toBe("00".repeat(31) + "01");
    expect(hex(toBytes32BE(0x0102n))).toBe("00".repeat(30) + "0102");
    expect(fromBytes32BE(toBytes32BE(BN254_FR - 1n))).toBe(BN254_FR - 1n);
    expect(() => toBytes32BE(1n << 256n)).toThrow();
    expect(() => toBytes32BE(-1n)).toThrow();
  });

  it("converts a snarkjs proof to the groth16-solana layout", () => {
    const p = proofToSolana({
      pi_a: ["1", "2", "1"],
      pi_b: [
        ["3", "4"],
        ["5", "6"],
        ["1", "0"],
      ],
      pi_c: ["7", "8", "1"],
    });
    const w = (n: bigint) => hex(toBytes32BE(n));
    expect(hex(p.a)).toBe(w(1n) + w(BN254_FQ - 2n));
    expect(hex(p.b)).toBe(w(4n) + w(3n) + w(6n) + w(5n));
    expect(hex(p.c)).toBe(w(7n) + w(8n));
    expect([p.a.length, p.b.length, p.c.length]).toEqual([64, 128, 64]);
  });

  it("rejects out-of-range values", () => {
    expect(() => publicSignalsToBytes([BN254_FR.toString()])).toThrow();
    expect(() =>
      proofToSolana({ pi_a: [BN254_FQ.toString(), "2"], pi_b: [["1", "1"], ["1", "1"]], pi_c: ["1", "1"] }),
    ).toThrow();
    expect(publicSignalsToBytes(["5", 6n]).map(hex)).toEqual([hex(toBytes32BE(5n)), hex(toBytes32BE(6n))]);
  });
});
