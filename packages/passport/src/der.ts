export interface DerNode {
  tag: number;
  start: number;
  contentStart: number;
  end: number;
}

export function readNode(buf: Uint8Array, offset: number, limit: number = buf.length): DerNode {
  if (offset + 2 > limit) throw new Error("DER: truncated header");
  const tag = buf[offset]!;
  if ((tag & 0x1f) === 0x1f) throw new Error("DER: multi-byte tags are not supported");
  let length = buf[offset + 1]!;
  let contentStart = offset + 2;
  if (length & 0x80) {
    const n = length & 0x7f;
    if (n === 0 || n > 4) throw new Error("DER: unsupported length form");
    if (contentStart + n > limit) throw new Error("DER: truncated length");
    length = 0;
    for (let i = 0; i < n; i++) length = length * 256 + buf[contentStart + i]!;
    contentStart += n;
  }
  const end = contentStart + length;
  if (end > limit) throw new Error("DER: content runs past the end");
  return { tag, start: offset, contentStart, end };
}

export function children(buf: Uint8Array, node: DerNode): DerNode[] {
  const out: DerNode[] = [];
  let p = node.contentStart;
  while (p < node.end) {
    const c = readNode(buf, p, node.end);
    out.push(c);
    p = c.end;
  }
  return out;
}

export const content = (buf: Uint8Array, node: DerNode): Uint8Array => buf.subarray(node.contentStart, node.end);
export const whole = (buf: Uint8Array, node: DerNode): Uint8Array => buf.subarray(node.start, node.end);

export function child(buf: Uint8Array, node: DerNode, index: number, tag?: number): DerNode {
  const c = children(buf, node)[index];
  if (!c) throw new Error(`DER: missing child ${index}`);
  if (tag !== undefined && c.tag !== tag) {
    throw new Error(`DER: expected tag 0x${tag.toString(16)}, found 0x${c.tag.toString(16)}`);
  }
  return c;
}

export function readOid(buf: Uint8Array, node: DerNode): string {
  if (node.tag !== 0x06) throw new Error("DER: not an OID");
  const bytes = content(buf, node);
  const parts: number[] = [Math.floor(bytes[0]! / 40), bytes[0]! % 40];
  let v = 0;
  for (let i = 1; i < bytes.length; i++) {
    v = v * 128 + (bytes[i]! & 0x7f);
    if (!(bytes[i]! & 0x80)) {
      parts.push(v);
      v = 0;
    }
  }
  return parts.join(".");
}

export function readUnsigned(buf: Uint8Array, node: DerNode): bigint {
  if (node.tag !== 0x02) throw new Error("DER: not an INTEGER");
  let x = 0n;
  for (const b of content(buf, node)) x = (x << 8n) | BigInt(b);
  return x;
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function tlv(tag: number, ...parts: Uint8Array[]): Uint8Array {
  const body = concat(...parts);
  const n = body.length;
  let header: number[];
  if (n < 0x80) header = [tag, n];
  else if (n < 0x100) header = [tag, 0x81, n];
  else if (n < 0x10000) header = [tag, 0x82, n >> 8, n & 0xff];
  else throw new Error("DER: value too long");
  return concat(Uint8Array.from(header), body);
}

export const seq = (...p: Uint8Array[]) => tlv(0x30, ...p);
export const set = (...p: Uint8Array[]) => tlv(0x31, ...p);
export const octets = (b: Uint8Array) => tlv(0x04, b);
export const nullDer = () => Uint8Array.from([0x05, 0x00]);
export const explicit = (n: number, ...p: Uint8Array[]) => tlv(0xa0 | n, ...p);
export const bitString = (b: Uint8Array) => tlv(0x03, Uint8Array.from([0]), b);
export const utf8 = (s: string) => tlv(0x0c, new TextEncoder().encode(s));
export const utcTime = (s: string) => tlv(0x17, new TextEncoder().encode(s));

export function int(x: number | bigint): Uint8Array {
  let v = BigInt(x);
  if (v < 0n) throw new Error("DER: negative integers are not supported");
  const bytes: number[] = [];
  do {
    bytes.unshift(Number(v & 0xffn));
    v >>= 8n;
  } while (v > 0n);
  if (bytes[0]! & 0x80) bytes.unshift(0);
  return tlv(0x02, Uint8Array.from(bytes));
}

export function oid(dotted: string): Uint8Array {
  const parts = dotted.split(".").map(Number);
  const bytes: number[] = [parts[0]! * 40 + parts[1]!];
  for (const part of parts.slice(2)) {
    const chunk: number[] = [part & 0x7f];
    let v = part >> 7;
    while (v > 0) {
      chunk.unshift((v & 0x7f) | 0x80);
      v >>= 7;
    }
    bytes.push(...chunk);
  }
  return tlv(0x06, Uint8Array.from(bytes));
}
