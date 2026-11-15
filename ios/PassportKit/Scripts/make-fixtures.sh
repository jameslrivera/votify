#!/usr/bin/env bash
set -euo pipefail
out="$(cd "$(dirname "$0")/.." && pwd)/Tests/PassportKitTests/Fixtures"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
mkdir -p "$out"

python3 - "$tmp" "$out" <<'PY'
import hashlib, os, sys
tmp, out = sys.argv[1], sys.argv[2]
line1 = "P<USAERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<"
line2 = "L898902C36USA7408122F1204159ZE184226B<<<<<10"
assert len(line1) == 44 and len(line2) == 44
mrz = (line1 + line2).encode()
dg1 = bytes([0x61, 0x5B, 0x5F, 0x1F, 0x58]) + mrz
assert len(dg1) == 93
open(os.path.join(out, "mock_dg1.bin"), "wb").write(dg1)

def tlv(tag, body):
    n = len(body)
    if n < 0x80: head = bytes([n])
    elif n < 0x100: head = bytes([0x81, n])
    else: head = bytes([0x82, n >> 8, n & 0xFF])
    return bytes([tag]) + head + body

sha256_oid = bytes.fromhex("0609608648016503040201")
alg = tlv(0x30, sha256_oid + bytes([0x05, 0x00]))
entries = b"".join(
    tlv(0x30, tlv(0x02, bytes([n])) + tlv(0x04, h))
    for n, h in [(1, hashlib.sha256(dg1).digest()), (2, hashlib.sha256(b"mock dg2").digest())]
)
lds = tlv(0x30, tlv(0x02, b"\x00") + alg + tlv(0x30, entries))
open(os.path.join(tmp, "econtent.der"), "wb").write(lds)
PY

sign() {
  local name="$1"; shift
  openssl req -x509 -newkey "$@" -nodes -keyout "$tmp/$name.key" -out "$tmp/$name.pem" \
    -subj "/C=US/O=zk-election MOCK/CN=Mock DSC $name" -days 3650 -sha256 2>/dev/null
  openssl cms -sign -binary -nodetach -nosmimecap -md sha256 -econtent_type 2.23.136.1.1.1 \
    -signer "$tmp/$name.pem" -inkey "$tmp/$name.key" -in "$tmp/econtent.der" -outform DER -out "$tmp/$name.cms"
  python3 - "$tmp/$name.cms" "$out/mock_sod_$name.bin" <<'PY'
import sys
cms = open(sys.argv[1], "rb").read()
n = len(cms)
head = bytes([0x82, n >> 8, n & 0xFF]) if n > 0xFF else bytes([0x81, n])
open(sys.argv[2], "wb").write(bytes([0x77]) + head + cms)
PY
}
sign rsa rsa:2048
sign ecdsa ec -pkeyopt ec_paramgen_curve:P-256
ls -l "$out"
