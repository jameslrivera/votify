#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

RPC_URL=${RPC_URL:-https://api.devnet.solana.com}
RPC_WS_URL=${RPC_WS_URL:-wss://api.devnet.solana.com}
IDL=target/idl/zk_election.json
if [[ ! -f "$IDL" ]]; then
  echo "Program not built. Run: make program:build" >&2
  exit 1
fi
for f in circuits/build/vote/vote.zkey circuits/build/register/register.zkey; do
  if [[ ! -f "$f" ]]; then
    echo "Circuits not built. Run: make circuits:build" >&2
    exit 1
  fi
done

LAN_IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo 127.0.0.1)
PIDS=()

cleanup() {
  for pid in ${PIDS[@]:-}; do kill "$pid" 2>/dev/null || true; done
}
trap cleanup EXIT INT TERM

if command -v mkcert >/dev/null && [[ ! -f certs/lan.pem ]]; then
  mkdir -p certs
  mkcert -cert-file certs/lan.pem -key-file certs/lan-key.pem localhost 127.0.0.1 "$LAN_IP"
fi

DEMO_MODE=true RPC_URL="$RPC_URL" STATE_PATH="$PWD/relayer/.state.devnet.json" pnpm --filter @zk-election/relayer start &
PIDS+=($!)
for _ in $(seq 1 200); do
  curl -s http://127.0.0.1:8787/ballot >/dev/null && break
  sleep 0.3
done

RPC_URL="$RPC_URL" RPC_WS_URL="$RPC_WS_URL" pnpm --filter @zk-election/web dev &
PIDS+=($!)

SCHEME=http
[[ -f certs/lan.pem ]] && SCHEME=https
sleep 2
echo
echo "Demo is running on Solana devnet. Press Ctrl+C to stop."
echo "  Program:  $(node -e "console.log(require('./$IDL').address)")"
echo "  Results:  $SCHEME://localhost:5173/results"
echo "  Kiosk:    $SCHEME://$LAN_IP:5173/kiosk"
echo "  Add a mock voter: make demo:voter"
wait
