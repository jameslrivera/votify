import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildKeyTree,
  buildRegisterInput,
  keyLeaf,
  loadMockKey,
  makeDg1,
  makeSod,
  mrzCheckDigit,
  parseSod,
  sha256,
  sha256Pad,
  toLimbs,
  yymmdd,
} from "../src/index.ts";

const pem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }) as string;
const key = loadMockKey(pem);
const dg1 = makeDg1({ nationality: "USA", dateOfBirth: "900115", expiry: "320115" });
const sod = makeSod(dg1, key);

describe("mock passport", () => {
  it("builds a 93-byte DG1 with fields at the expected offsets", () => {
    expect(dg1.length).toBe(93);
    const text = new TextDecoder().decode(dg1);
    expect(text.slice(59, 62)).toBe("USA");
    expect(text.slice(62, 68)).toBe("900115");
    expect(text.slice(70, 76)).toBe("320115");
  });

  it("computes ICAO check digits (specimen values)", () => {
    expect(mrzCheckDigit("L898902C3")).toBe("6");
    expect(mrzCheckDigit("740812")).toBe("2");
    expect(mrzCheckDigit("120415")).toBe("9");
  });

  it("matches the real passport's SOD layout from the M1 report", () => {
    const p = parseSod(sod);
    expect(p.eContent.length).toBe(180);
    expect(p.signedAttrs.length).toBe(104);
    expect(p.dg1HashOffset).toBe(31);
    expect(p.eContentHashOffset).toBe(72);
    expect(p.signature.length).toBe(256);
    expect([...p.dataGroupHashes.keys()]).toEqual([1, 2, 11, 12]);
    expect(p.exponent).toBe(65537n);
    expect(p.modulus).toBe(key.modulus);
  });

  it("chains hashes and carries a signature that verifies", () => {
    const p = parseSod(sod);
    expect(p.eContent.subarray(31, 63)).toEqual(sha256(dg1));
    expect(p.signedAttrs.subarray(72, 104)).toEqual(sha256(p.eContent));
    expect(verify("sha256", p.signedAttrs, createPublicKey(pem), p.signature)).toBe(true);
  });
});

describe("circuit inputs", () => {
  it("pads like SHA-256", () => {
    const { padded, paddedLen } = sha256Pad(new Uint8Array(180), 256);
    expect(paddedLen).toBe(192);
    expect(padded[180]).toBe(0x80);
    expect(padded[190]).toBe(0x05);
    expect(padded[191]).toBe(0xa0);
    expect(() => sha256Pad(new Uint8Array(250), 256)).toThrow();
  });

  it("splits numbers into little-endian limbs", () => {
    const limbs = toLimbs((5n << 121n) + 7n);
    expect(limbs.length).toBe(17);
    expect(limbs[0]).toBe(7n);
    expect(limbs[1]).toBe(5n);
  });

  it("builds inputs whose public signals follow the circuit order", () => {
    const tree = buildKeyTree([key.modulus]);
    const { input, publicSignals } = buildRegisterInput({
      dg1,
      sod,
      credential: { secret: 1n, nullifierKey: 2n },
      electionId: 99n,
      currentDate: 261112,
      keyTree: tree,
    });
    expect(publicSignals[2]).toBe("99");
    expect(publicSignals[3]).toBe("261112");
    expect(publicSignals[4]).toBe(tree.root.toString());
    expect(tree.indexOf(keyLeaf(key.modulus))).toBe(0);
    expect((input.econtent as string[]).length).toBe(256);
    expect((input.signed_attrs as string[]).length).toBe(128);
    expect((input.modulus as string[]).length).toBe(17);
  });

  it("formats dates as YYMMDD in UTC", () => {
    expect(yymmdd(new Date(Date.UTC(2026, 10, 12)))).toBe(261112);
  });
});
