import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadMockKey, makeDg1, makeSod, toPassportFile, type MockIdentity, type MockKey } from "@zk-election/passport";
import { repoRoot, vectorsDir } from "./paths.ts";

export const mockKeysDir = join(repoRoot, "tools", "mock-keys");
export const passportsDir = join(vectorsDir, "passports");

export function mockKey(name: "mock-dsc" | "untrusted-dsc"): MockKey {
  mkdirSync(mockKeysDir, { recursive: true });
  const path = join(mockKeysDir, `${name}.pem`);
  if (!existsSync(path)) {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, publicExponent: 65537 });
    writeFileSync(path, privateKey.export({ type: "pkcs8", format: "pem" }));
  }
  return loadMockKey(readFileSync(path, "utf8"));
}

function write(file: string, dg1: Uint8Array, sod: Uint8Array, description: string) {
  mkdirSync(passportsDir, { recursive: true });
  writeFileSync(join(passportsDir, file), JSON.stringify(toPassportFile(dg1, sod, description), null, 2) + "\n");
  console.log(`wrote test-vectors/passports/${file}`);
}

const args = process.argv.slice(2).filter((a) => a !== "--");
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

if (flag("out")) {
  const id: MockIdentity = {
    nationality: flag("nationality") ?? "USA",
    dateOfBirth: flag("dob") ?? "900115",
    expiry: flag("expiry") ?? "320115",
  };
  const dg1 = makeDg1(id);
  write(flag("out")!, dg1, makeSod(dg1, mockKey("mock-dsc")), `Custom mock passport ${JSON.stringify(id)}`);
} else {
  const trusted = mockKey("mock-dsc");
  const untrusted = mockKey("untrusted-dsc");
  const adult: MockIdentity = { nationality: "USA", dateOfBirth: "900115", expiry: "320115", documentNumber: "X00000001" };
  const make = (file: string, description: string, id: MockIdentity, key = trusted) => {
    const dg1 = makeDg1(id);
    write(file, dg1, makeSod(dg1, key), description);
  };

  make("valid-adult.mock.json", "Valid: adult US citizen, unexpired, trusted mock key", adult);
  make("valid-adult-2.mock.json", "Valid: a second adult, born in the 1900s", {
    nationality: "USA",
    dateOfBirth: "740812",
    expiry: "301231",
    documentNumber: "X00000002",
  });
  make("under-18.mock.json", "Invalid: born 2010, under 18", { ...adult, dateOfBirth: "100601", documentNumber: "X00000003" });
  make("expired.mock.json", "Invalid: expired in 2025", { ...adult, expiry: "250101", documentNumber: "X00000004" });
  make("non-us.mock.json", "Invalid: nationality is not USA", { ...adult, nationality: "UTO", documentNumber: "X00000005" });
  make("untrusted-key.mock.json", "Invalid: signed by a key outside the trusted-key tree", { ...adult, documentNumber: "X00000006" }, untrusted);

  const minor: MockIdentity = { ...adult, dateOfBirth: "100601", documentNumber: "X00000007" };
  const sod = makeSod(makeDg1(minor), trusted);
  write("tampered-dg1.mock.json", makeDg1({ ...minor, dateOfBirth: "900115" }), sod, "Invalid: DG1 edited after signing");
}
