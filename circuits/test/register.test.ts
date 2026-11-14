import { afterAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as snarkjs from "snarkjs";
import {
  buildKeyTree,
  buildRegisterInput,
  fromPassportFile,
  loadMockKey,
  makeDg1,
  makeSod,
  rsaWitness,
  sha256,
  toLimbs,
  type MockIdentity,
} from "@zk-election/passport";

const build = (f: string) => fileURLToPath(new URL(`../build/register/${f}`, import.meta.url));
const repo = (f: string) => fileURLToPath(new URL(`../../${f}`, import.meta.url));
const wasm = process.env.REGISTER_WASM ?? build("register.wasm");
const zkey = build("register.zkey");

const mockKey = loadMockKey(readFileSync(repo("tools/mock-keys/mock-dsc.pem"), "utf8"));
const keyTree = buildKeyTree([mockKey.modulus]);
const credential = { secret: 123456789n, nullifierKey: 987654321n };
const electionId = 0xabcdef0123456789n;
const TODAY = 261112;

const fixture = (name: string) =>
  fromPassportFile(JSON.parse(readFileSync(repo(`test-vectors/passports/${name}.mock.json`), "utf8")));

function inputFor(passport: { dg1: Uint8Array; sod: Uint8Array }, currentDate = TODAY) {
  return buildRegisterInput({ ...passport, credential, electionId, currentDate, keyTree });
}
const mock = (id: MockIdentity) => {
  const dg1 = makeDg1(id);
  return { dg1, sod: makeSod(dg1, mockKey) };
};

type Input = Record<string, string | string[] | string[][]>;
const witness = (input: Input) => snarkjs.wtns.calculate(input, wasm, { type: "mem" });
const accepts = (input: Input) => expect(witness(input)).resolves.toBeUndefined();
const rejects = (input: Input) => expect(witness(input)).rejects.toThrow();
const withChange = (input: Input, key: string, index: number, to: string): Input => {
  const copy = [...(input[key] as string[])];
  copy[index] = to;
  return { ...input, [key]: copy };
};

afterAll(async () => {
  await (globalThis as { curve_bn128?: { terminate(): Promise<void> } }).curve_bn128?.terminate();
});

const valid = inputFor(fixture("valid-adult"));

describe("register circuit: valid passports", () => {
  it("accepts the valid adult fixture", () => accepts(valid.input));
  it("accepts an adult born in the 1900s", () => accepts(inputFor(fixture("valid-adult-2")).input));
  it("accepts someone who turns 18 today", () =>
    accepts(inputFor(mock({ nationality: "USA", dateOfBirth: "081112", expiry: "320115" })).input));
  it("accepts a passport that expires today", () =>
    accepts(inputFor(mock({ nationality: "USA", dateOfBirth: "900115", expiry: "261112" })).input));

  it.skipIf(!existsSync(zkey))(
    "proves and verifies, with public inputs in the expected order",
    async () => {
      const vk = JSON.parse(readFileSync(build("verification_key.json"), "utf8"));
      const started = Date.now();
      const { proof, publicSignals } = await snarkjs.groth16.fullProve(valid.input, wasm, zkey);
      const seconds = (Date.now() - started) / 1000;
      expect(publicSignals).toEqual(valid.publicSignals);
      expect(await snarkjs.groth16.verify(vk, publicSignals, proof)).toBe(true);
      for (let i = 0; i < publicSignals.length; i++) {
        const changed = [...publicSignals];
        changed[i] = (BigInt(changed[i]!) + 1n).toString();
        expect(await snarkjs.groth16.verify(vk, changed, proof)).toBe(false);
      }
      mkdirSync(build(""), { recursive: true });
      writeFileSync(build("prove-time.json"), JSON.stringify({ laptopProveSeconds: seconds }, null, 2));
    },
    600_000,
  );
});

describe("register circuit: invalid fixtures", () => {
  for (const name of ["under-18", "expired", "non-us", "untrusted-key", "tampered-dg1"]) {
    it(`rejects ${name}`, () => rejects(inputFor(fixture(name)).input));
  }
});

describe("register circuit: one negative test per constraint", () => {
  it("1. data integrity: a wrong DG1 hash offset", () => rejects({ ...valid.input, dg1_hash_offset: "30" }));

  it("1. data integrity: an edited eContent byte", () => rejects(withChange(valid.input, "econtent", 100, "7")));

  it("1. data integrity: a wrong eContent hash offset", () => rejects({ ...valid.input, econtent_hash_offset: "71" }));

  it("1. data integrity: a hash planted after the padding, outside the hashed bytes", () => {
    const fake = makeDg1({ nationality: "USA", dateOfBirth: "850101", expiry: "350101" });
    const econtent = [...(valid.input.econtent as string[])];
    sha256(fake).forEach((b, i) => (econtent[200 + i] = String(b)));
    return rejects({ ...valid.input, dg1: Array.from(fake, String), econtent, dg1_hash_offset: "200" });
  });

  it("1. data integrity: a wrong padded length", () => rejects({ ...valid.input, econtent_blocks: "2" }));

  it("2. signature: an edited signature", () => {
    const limb = BigInt((valid.input.signature as string[])[0]!) ^ 1n;
    return rejects(withChange(valid.input, "signature", 0, limb.toString()));
  });

  it("2. signature: a forged signature with a consistent multiplication witness", () => {
    const limbs = valid.input.signature as string[];
    const modulus = (valid.input.modulus as string[]).reduce((acc, l, i) => acc + (BigInt(l) << BigInt(121 * i)), 0n);
    const forged = limbs.reduce((acc, l, i) => acc + (BigInt(l) << BigInt(121 * i)), 0n) ^ 2n;
    const witness = rsaWitness(forged, modulus);
    return rejects({
      ...valid.input,
      signature: toLimbs(forged).map(String),
      rsa_quotients: witness.quotients.map((q) => toLimbs(q).map(String)),
      rsa_remainders: witness.remainders.map((r) => toLimbs(r).map(String)),
    });
  });

  it("2. signature: an edited quotient or remainder in the RSA witness", async () => {
    const edit = (key: "rsa_quotients" | "rsa_remainders", row: number) => {
      const rows = (valid.input[key] as string[][]).map((r) => [...r]);
      rows[row]![3] = (BigInt(rows[row]![3]!) + 1n).toString();
      return { ...valid.input, [key]: rows };
    };
    await rejects(edit("rsa_quotients", 0));
    await rejects(edit("rsa_quotients", 16));
    await rejects(edit("rsa_remainders", 7));
    await rejects(edit("rsa_remainders", 15));
  });

  it("2. signature: edited signedAttributes", () => rejects(withChange(valid.input, "signed_attrs", 40, "9")));

  it("3. trusted key: a different trusted_key_root", () =>
    rejects({ ...valid.input, trusted_key_root: (BigInt(valid.input.trusted_key_root as string) + 1n).toString() }));

  it("3. trusted key: a wrong Merkle path", () => rejects(withChange(valid.input, "key_path_elements", 0, "5")));

  it("4. nationality: covered by the non-us fixture, and by editing DG1", () =>
    rejects(withChange(valid.input, "dg1", 59, "88")));

  it("5. not expired: a current_date after the expiry date", () => rejects(inputFor(fixture("valid-adult"), 320116).input));

  it("6. adult: one day short of 18", () =>
    rejects(inputFor(mock({ nationality: "USA", dateOfBirth: "081113", expiry: "320115" })).input));

  it("6. adult: a non-digit in the birth date", () => rejects(withChange(valid.input, "dg1", 62, "60")));

  it("7. outputs: a wrong passport_nullifier", () => rejects({ ...valid.input, passport_nullifier: "1" }));

  it("7. outputs: a wrong commitment", () => rejects({ ...valid.input, commitment: "1" }));

  it("7. outputs: a different election_id", () => rejects({ ...valid.input, election_id: "42" }));

  it("7. outputs: the nullifier does not depend on the credential", () => {
    const other = buildRegisterInput({
      ...fixture("valid-adult"),
      credential: { secret: 5n, nullifierKey: 6n },
      electionId,
      currentDate: TODAY,
      keyTree,
    });
    expect(other.publicSignals[0]).toBe(valid.publicSignals[0]);
    expect(other.publicSignals[1]).not.toBe(valid.publicSignals[1]);
  });
});
