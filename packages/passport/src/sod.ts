import { child, children, content, readNode, readOid, readUnsigned, whole, type DerNode } from "./der.ts";

export const OID = {
  signedData: "1.2.840.113549.1.7.2",
  ldsSecurityObject: "2.23.136.1.1.1",
  sha256: "2.16.840.1.101.3.4.2.1",
  rsaEncryption: "1.2.840.113549.1.1.1",
  sha256WithRsa: "1.2.840.113549.1.1.11",
  contentType: "1.2.840.113549.1.9.3",
  messageDigest: "1.2.840.113549.1.9.4",
  signingTime: "1.2.840.113549.1.9.5",
  commonName: "2.5.4.3",
} as const;

export interface ParsedSod {
  eContent: Uint8Array;
  signedAttrs: Uint8Array;
  signature: Uint8Array;
  modulus: bigint;
  exponent: bigint;
  dataGroupHashes: Map<number, Uint8Array>;
  dg1HashOffset: number;
  eContentHashOffset: number;
}

export class UnsupportedPassportError extends Error {}

function expectOid(buf: Uint8Array, node: DerNode, allowed: string[], what: string): string {
  const got = readOid(buf, node);
  if (!allowed.includes(got)) throw new UnsupportedPassportError(`${what}: unsupported algorithm ${got}`);
  return got;
}

export function parseSod(sod: Uint8Array): ParsedSod {
  let root = readNode(sod, 0);
  if (root.tag === 0x77) root = readNode(sod, root.contentStart, root.end);
  if (root.tag !== 0x30) throw new Error("SOD: not a ContentInfo");
  if (readOid(sod, child(sod, root, 0, 0x06)) !== OID.signedData) throw new Error("SOD: not SignedData");
  const signedData = child(sod, child(sod, root, 1, 0xa0), 0, 0x30);
  const parts = children(sod, signedData);

  const encap = parts[2];
  if (!encap || encap.tag !== 0x30) throw new Error("SOD: missing encapContentInfo");
  const eContentNode = child(sod, child(sod, encap, 1, 0xa0), 0, 0x04);
  const eContent = content(sod, eContentNode).slice();

  const lds = readNode(eContent, 0);
  expectOid(eContent, child(eContent, child(eContent, lds, 1, 0x30), 0, 0x06), [OID.sha256], "data-group hash");
  const dataGroupHashes = new Map<number, Uint8Array>();
  let dg1HashOffset = -1;
  for (const entry of children(eContent, child(eContent, lds, 2, 0x30))) {
    const number = Number(readUnsigned(eContent, child(eContent, entry, 0, 0x02)));
    const hashNode = child(eContent, entry, 1, 0x04);
    dataGroupHashes.set(number, content(eContent, hashNode).slice());
    if (number === 1) dg1HashOffset = hashNode.contentStart;
  }
  if (dg1HashOffset < 0) throw new Error("SOD: no hash for DG1");

  const certs = parts.find((p) => p.tag === 0xa0);
  if (!certs) throw new Error("SOD: no certificate");
  const cert = child(sod, certs, 0, 0x30);
  const tbs = child(sod, cert, 0, 0x30);
  const spki = children(sod, tbs).filter((n) => n.tag === 0x30)[4];
  if (!spki) throw new Error("SOD: certificate has no public key");
  expectOid(sod, child(sod, child(sod, spki, 0, 0x30), 0, 0x06), [OID.rsaEncryption], "DSC key");
  const keyBits = content(sod, child(sod, spki, 1, 0x03)).subarray(1);
  const rsaKey = readNode(keyBits, 0);
  const modulus = readUnsigned(keyBits, child(keyBits, rsaKey, 0, 0x02));
  const exponent = readUnsigned(keyBits, child(keyBits, rsaKey, 1, 0x02));

  const signerInfos = parts[parts.length - 1];
  if (!signerInfos || signerInfos.tag !== 0x31) throw new Error("SOD: missing signerInfos");
  const signer = children(sod, child(sod, signerInfos, 0, 0x30));
  const attrsNode = signer.find((n) => n.tag === 0xa0);
  if (!attrsNode) throw new Error("SOD: no signedAttributes");
  const attrsIndex = signer.indexOf(attrsNode);
  const digestAlg = signer[attrsIndex - 1]!;
  const sigAlg = signer[attrsIndex + 1]!;
  const sigNode = signer[attrsIndex + 2]!;
  expectOid(sod, child(sod, digestAlg, 0, 0x06), [OID.sha256], "signer digest");
  expectOid(sod, child(sod, sigAlg, 0, 0x06), [OID.rsaEncryption, OID.sha256WithRsa], "signature");
  if (sigNode.tag !== 0x04) throw new Error("SOD: missing signature");

  const signedAttrs = whole(sod, attrsNode).slice();
  signedAttrs[0] = 0x31;
  let eContentHashOffset = -1;
  const attrsRoot = readNode(signedAttrs, 0);
  for (const attr of children(signedAttrs, attrsRoot)) {
    if (readOid(signedAttrs, child(signedAttrs, attr, 0, 0x06)) === OID.messageDigest) {
      eContentHashOffset = child(signedAttrs, child(signedAttrs, attr, 1, 0x31), 0, 0x04).contentStart;
    }
  }
  if (eContentHashOffset < 0) throw new Error("SOD: no messageDigest attribute");

  return {
    eContent,
    signedAttrs,
    signature: content(sod, sigNode).slice(),
    modulus,
    exponent,
    dataGroupHashes,
    dg1HashOffset,
    eContentHashOffset,
  };
}
