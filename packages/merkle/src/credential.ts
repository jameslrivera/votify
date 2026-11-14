import { poseidon2, poseidon3 } from "poseidon-lite";
import { CREDENTIAL_PREFIX, SECRET_BYTES } from "@zk-election/constants";

export interface Credential {
  secret: bigint;
  nullifierKey: bigint;
}

export function commitment(c: Credential, electionId: bigint): bigint {
  return poseidon3([c.secret, c.nullifierKey, electionId]);
}

export function voteNullifier(nullifierKey: bigint, electionId: bigint): bigint {
  return poseidon2([nullifierKey, electionId]);
}

export function passportNullifier(sodHi: bigint, sodLo: bigint, electionId: bigint): bigint {
  return poseidon3([sodHi, sodLo, electionId]);
}

export function bytesToBigIntBE(bytes: Uint8Array): bigint {
  let x = 0n;
  for (const b of bytes) x = (x << 8n) | BigInt(b);
  return x;
}

export function bigIntToBytesBE(x: bigint, length: number): Uint8Array {
  const out = new Uint8Array(length);
  let v = x;
  for (let i = length - 1; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  if (v !== 0n) throw new Error(`Value does not fit in ${length} bytes`);
  return out;
}

export function randomCredential(): Credential {
  const buf = new Uint8Array(SECRET_BYTES * 2);
  globalThis.crypto.getRandomValues(buf);
  const c = {
    secret: bytesToBigIntBE(buf.subarray(0, SECRET_BYTES)),
    nullifierKey: bytesToBigIntBE(buf.subarray(SECRET_BYTES)),
  };
  buf.fill(0);
  return c;
}

function toBase64Url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
}

export function encodeCredential(c: Credential): string {
  const buf = new Uint8Array(SECRET_BYTES * 2);
  buf.set(bigIntToBytesBE(c.secret, SECRET_BYTES), 0);
  buf.set(bigIntToBytesBE(c.nullifierKey, SECRET_BYTES), SECRET_BYTES);
  return CREDENTIAL_PREFIX + toBase64Url(buf);
}

export function decodeCredential(payload: string): Credential {
  if (!payload.startsWith(CREDENTIAL_PREFIX)) throw new Error("Not a voting code");
  let bytes: Uint8Array;
  try {
    bytes = fromBase64Url(payload.slice(CREDENTIAL_PREFIX.length));
  } catch {
    throw new Error("Voting code is malformed");
  }
  if (bytes.length !== SECRET_BYTES * 2) throw new Error("Voting code has the wrong length");
  return {
    secret: bytesToBigIntBE(bytes.subarray(0, SECRET_BYTES)),
    nullifierKey: bytesToBigIntBE(bytes.subarray(SECRET_BYTES)),
  };
}
