import { createPrivateKey, createPublicKey, sign, type KeyObject } from "node:crypto";
import { bitString, explicit, int, nullDer, octets, oid, seq, set, tlv, utcTime, utf8, concat } from "./der.ts";
import { OID } from "./sod.ts";
import { sha256 } from "./inputs.ts";

export interface MockKey {
  privateKey: KeyObject;
  certificate: Uint8Array;
  modulus: bigint;
}

const algSha256 = () => seq(oid(OID.sha256), nullDer());
const mockName = (cn: string) => seq(set(seq(oid(OID.commonName), utf8(cn))));

export function loadMockKey(pem: string, commonName = "ZK Election MOCK DSC (not a real passport key)"): MockKey {
  const privateKey = createPrivateKey(pem);
  const publicKey = createPublicKey(privateKey);
  const jwk = publicKey.export({ format: "jwk" });
  const modulus = BigInt("0x" + Buffer.from(jwk.n!, "base64url").toString("hex"));
  const spki = new Uint8Array(publicKey.export({ type: "spki", format: "der" }));
  const sigAlg = seq(oid(OID.sha256WithRsa), nullDer());
  const tbs = seq(
    explicit(0, int(2)),
    int(1),
    sigAlg,
    mockName(commonName),
    seq(utcTime("250101000000Z"), utcTime("350101000000Z")),
    mockName(commonName),
    spki,
  );
  const certificate = seq(tbs, sigAlg, bitString(new Uint8Array(sign("sha256", tbs, privateKey))));
  return { privateKey, certificate, modulus };
}

function mrzValue(ch: string): number {
  if (ch === "<") return 0;
  if (ch >= "0" && ch <= "9") return ch.charCodeAt(0) - 48;
  return ch.charCodeAt(0) - 55;
}

export function mrzCheckDigit(s: string): string {
  const weights = [7, 3, 1];
  let sum = 0;
  for (let i = 0; i < s.length; i++) sum += mrzValue(s[i]!) * weights[i % 3]!;
  return String(sum % 10);
}

export interface MockIdentity {
  nationality: string;
  dateOfBirth: string;
  expiry: string;
  documentNumber?: string;
}

export function makeDg1(id: MockIdentity): Uint8Array {
  const docNumber = (id.documentNumber ?? "X00000000").padEnd(9, "<");
  const personal = "<".repeat(14);
  const line1 = `P<${id.nationality}MOCK<<PASSPORT`.padEnd(44, "<");
  const doc = docNumber + mrzCheckDigit(docNumber);
  const dob = id.dateOfBirth + mrzCheckDigit(id.dateOfBirth);
  const exp = id.expiry + mrzCheckDigit(id.expiry);
  const pers = personal + mrzCheckDigit(personal);
  const composite = mrzCheckDigit(doc + dob + exp + pers);
  const line2 = `${doc}${id.nationality}${dob}X${exp}${pers}${composite}`;
  if (line1.length !== 44 || line2.length !== 44) throw new Error("Mock MRZ has the wrong length");
  const mrz = new TextEncoder().encode(line1 + line2);
  return concat(Uint8Array.from([0x61, 0x5b, 0x5f, 0x1f, 0x58]), mrz);
}

export function makeSod(dg1: Uint8Array, key: MockKey): Uint8Array {
  const placeholder = (n: number) => sha256(new TextEncoder().encode(`mock data group ${n}`));
  const dgHash = (n: number, h: Uint8Array) => seq(int(n), octets(h));
  const eContent = seq(
    int(0),
    algSha256(),
    seq(dgHash(1, sha256(dg1)), dgHash(2, placeholder(2)), dgHash(11, placeholder(11)), dgHash(12, placeholder(12))),
  );
  const attr = (type: string, value: Uint8Array) => seq(oid(type), set(value));
  const attrs = [
    attr(OID.contentType, oid(OID.ldsSecurityObject)),
    attr(OID.signingTime, utcTime("250101000000Z")),
    attr(OID.messageDigest, octets(sha256(eContent))),
  ];
  const signature = new Uint8Array(sign("sha256", set(...attrs), key.privateKey));
  const signerInfo = seq(
    int(1),
    seq(mockName("ZK Election MOCK DSC (not a real passport key)"), int(1)),
    algSha256(),
    tlv(0xa0, ...attrs),
    seq(oid(OID.rsaEncryption), nullDer()),
    octets(signature),
  );
  const signedData = seq(
    int(3),
    set(algSha256()),
    seq(oid(OID.ldsSecurityObject), explicit(0, octets(eContent))),
    tlv(0xa0, key.certificate),
    set(signerInfo),
  );
  return tlv(0x77, seq(oid(OID.signedData), explicit(0, signedData)));
}

export interface PassportFile {
  format: "zk-election-passport/1";
  mock: boolean;
  description?: string;
  dg1: string;
  sod: string;
}

export function toPassportFile(dg1: Uint8Array, sod: Uint8Array, description: string): PassportFile {
  return {
    format: "zk-election-passport/1",
    mock: true,
    description,
    dg1: Buffer.from(dg1).toString("base64"),
    sod: Buffer.from(sod).toString("base64"),
  };
}

export function fromPassportFile(file: PassportFile): { dg1: Uint8Array; sod: Uint8Array } {
  if (file.format !== "zk-election-passport/1") throw new Error("Unknown passport file format");
  return { dg1: new Uint8Array(Buffer.from(file.dg1, "base64")), sod: new Uint8Array(Buffer.from(file.sod, "base64")) };
}
