import { createHash } from "node:crypto";
import { poseidon9 } from "poseidon-lite";
import {
  DG1_LENGTH,
  KEY_TREE_DEPTH,
  MAX_ECONTENT_PADDED,
  MAX_SIGNED_ATTRS_PADDED,
  RSA_LIMB_BITS,
  RSA_LIMBS,
} from "@zk-election/constants";
import {
  IncrementalMerkleTree,
  bytesToBigIntBE,
  commitment,
  passportNullifier,
  type Credential,
} from "@zk-election/merkle";
import { parseSod, UnsupportedPassportError, type ParsedSod } from "./sod.ts";

export const sha256 = (b: Uint8Array): Uint8Array => new Uint8Array(createHash("sha256").update(b).digest());

export function sha256Pad(message: Uint8Array, maxLen: number): { padded: Uint8Array; paddedLen: number } {
  const paddedLen = Math.ceil((message.length + 9) / 64) * 64;
  if (paddedLen > maxLen) throw new UnsupportedPassportError(`Data of ${message.length} bytes does not fit the circuit`);
  const padded = new Uint8Array(maxLen);
  padded.set(message);
  padded[message.length] = 0x80;
  new DataView(padded.buffer).setBigUint64(paddedLen - 8, BigInt(message.length) * 8n);
  return { padded, paddedLen };
}

export function toLimbs(x: bigint, bits: number = RSA_LIMB_BITS, count: number = RSA_LIMBS): bigint[] {
  const mask = (1n << BigInt(bits)) - 1n;
  const out: bigint[] = [];
  let v = x;
  for (let i = 0; i < count; i++) {
    out.push(v & mask);
    v >>= BigInt(bits);
  }
  if (v !== 0n) throw new UnsupportedPassportError("RSA key is larger than the circuit supports");
  return out;
}

export function keyLeaf(modulus: bigint): bigint {
  const limbs = toLimbs(modulus);
  const merged: bigint[] = [];
  for (let i = 0; i < limbs.length; i += 2) {
    merged.push(limbs[i]! + ((limbs[i + 1] ?? 0n) << BigInt(RSA_LIMB_BITS)));
  }
  return poseidon9(merged);
}

export interface RsaWitness {
  quotients: bigint[];
  remainders: bigint[];
}

export function rsaWitness(signature: bigint, modulus: bigint): RsaWitness {
  const quotients: bigint[] = [];
  const remainders: bigint[] = [];
  let x = signature;
  for (let i = 0; i < 16; i++) {
    const product = x * x;
    quotients.push(product / modulus);
    x = product % modulus;
    remainders.push(x);
  }
  quotients.push((x * signature) / modulus);
  return { quotients, remainders };
}

export function buildKeyTree(moduli: readonly bigint[]): IncrementalMerkleTree {
  return new IncrementalMerkleTree(KEY_TREE_DEPTH, moduli.map(keyLeaf));
}

export function sodDigestHalves(signedAttrs: Uint8Array): { hi: bigint; lo: bigint } {
  const d = sha256(signedAttrs);
  return { hi: bytesToBigIntBE(d.subarray(0, 16)), lo: bytesToBigIntBE(d.subarray(16)) };
}

export interface RegisterArgs {
  dg1: Uint8Array;
  sod: Uint8Array;
  credential: Credential;
  electionId: bigint;
  currentDate: number;
  keyTree: IncrementalMerkleTree;
}

export interface RegisterInput {
  input: Record<string, string | string[] | string[][]>;
  publicSignals: string[];
  parsed: ParsedSod;
}

export function yymmdd(date: Date): number {
  return (date.getUTCFullYear() % 100) * 10000 + (date.getUTCMonth() + 1) * 100 + date.getUTCDate();
}

export function buildRegisterInput(args: RegisterArgs): RegisterInput {
  if (args.dg1.length !== DG1_LENGTH) throw new UnsupportedPassportError("DG1 is not a 93-byte passport MRZ");
  const parsed = parseSod(args.sod);
  if (parsed.exponent !== 65537n) throw new UnsupportedPassportError("DSC exponent is not 65537");
  const ec = sha256Pad(parsed.eContent, MAX_ECONTENT_PADDED);
  const sa = sha256Pad(parsed.signedAttrs, MAX_SIGNED_ATTRS_PADDED);
  const { hi, lo } = sodDigestHalves(parsed.signedAttrs);
  const rsa = rsaWitness(bytesToBigIntBE(parsed.signature), parsed.modulus);

  const leafIndex = args.keyTree.indexOf(keyLeaf(parsed.modulus));
  const keyPath = args.keyTree.size > 0 ? args.keyTree.proof(Math.max(leafIndex, 0)) : undefined;
  const zeros = args.keyTree.zeros;

  const publicSignals = [
    passportNullifier(hi, lo, args.electionId),
    commitment(args.credential, args.electionId),
    args.electionId,
    BigInt(args.currentDate),
    args.keyTree.root,
  ].map(String);

  const bytes = (b: Uint8Array) => Array.from(b, String);
  return {
    parsed,
    publicSignals,
    input: {
      passport_nullifier: publicSignals[0]!,
      commitment: publicSignals[1]!,
      election_id: publicSignals[2]!,
      current_date: publicSignals[3]!,
      trusted_key_root: publicSignals[4]!,
      dg1: bytes(args.dg1),
      econtent: bytes(ec.padded),
      econtent_blocks: String(ec.paddedLen / 64),
      dg1_hash_offset: String(parsed.dg1HashOffset),
      signed_attrs: bytes(sa.padded),
      signed_attrs_blocks: String(sa.paddedLen / 64),
      econtent_hash_offset: String(parsed.eContentHashOffset),
      signature: toLimbs(bytesToBigIntBE(parsed.signature)).map(String),
      modulus: toLimbs(parsed.modulus).map(String),
      rsa_quotients: rsa.quotients.map((q) => toLimbs(q).map(String)),
      rsa_remainders: rsa.remainders.map((r) => toLimbs(r).map(String)),
      key_path_elements: (keyPath?.pathElements ?? zeros.slice(0, KEY_TREE_DEPTH)).map(String),
      key_path_index: (keyPath?.pathIndex ?? new Array<number>(KEY_TREE_DEPTH).fill(0)).map(String),
      secret: args.credential.secret.toString(),
      nullifier_key: args.credential.nullifierKey.toString(),
    },
  };
}
