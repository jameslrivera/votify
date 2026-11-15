#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

SO=target/deploy/zk_election.so
IDL=target/idl/zk_election.json
if [[ ! -f "$SO" || ! -f "$IDL" ]]; then
  echo "Program not built. Run: make program:build" >&2
  exit 1
fi
for f in circuits/build/vote/vote.zkey circuits/build/register/register.zkey; do
  if [[ ! -f "$f" ]]; then
    echo "Circuits not built. Run: make circuits:build" >&2
    exit 1
  fi
done

PROGRAM_ID=$(node -e "console.log(require('./$IDL').address)")
LAN_IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo 127.0.0.1)
LEDGER=$(mktemp -d -t zk-election-demo)
PIDS=()

cleanup() {
  for pid in ${PIDS[@]:-}; do kill "$pid" 2>/dev/null || true; done
  rm -rf "$LEDGER"
}
trap cleanup EXIT INT TERM

if command -v mkcert >/dev/null && [[ ! -f certs/lan.pem ]]; then
  mkdir -p certs
  mkcert -cert-file certs/lan.pem -key-file certs/lan-key.pem localhost 127.0.0.1 "$LAN_IP"
fi

solana-test-validator --reset --quiet --ledger "$LEDGER" --limit-ledger-size 500000000 --bpf-program "$PROGRAM_ID" "$SO" >/dev/null &
PIDS+=($!)
for _ in $(seq 1 100); do
  if curl -s -X POST -H 'content-type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' http://127.0.0.1:8899 | grep -q '"ok"'; then
    break
  fi
  sleep 0.3
done

rm -f relayer/.state.json
DEMO_MODE=true PUBLIC_RPC_URL="http://$LAN_IP:8899" pnpm --filter @zk-election/relayer start &
PIDS+=($!)
for _ in $(seq 1 100); do
  curl -s http://127.0.0.1:8787/election >/dev/null && break
  sleep 0.3
done

pnpm --filter @zk-election/web dev &
PIDS+=($!)

SCHEME=http
[[ -f certs/lan.pem ]] && SCHEME=https
sleep 2
echo
echo "Demo is running. Press Ctrl+C to stop."
echo "  Results:  $SCHEME://localhost:5173/results"
echo "  Kiosk:    $SCHEME://$LAN_IP:5173/kiosk"
echo "  Add a mock voter: make demo:voter"
wait
