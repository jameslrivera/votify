#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

PROJECT=${PAGES_PROJECT:-votify}
PUBLIC_RPC=https://api.devnet.solana.com
RPC_KEY_FILE=relayer/.keys/rpc-url
if [[ -z "${RPC_URL:-}" && -s "$RPC_KEY_FILE" ]]; then
  RPC_URL=$(tr -d '[:space:]' <"$RPC_KEY_FILE")
  RPC_SPACING_MS=${RPC_SPACING_MS:-40}
fi
RPC_URL=${RPC_URL:-$PUBLIC_RPC}
export RPC_SPACING_MS=${RPC_SPACING_MS:-220}
RELAYER_LOG=circuits/build/relayer.log
LOG=$(mktemp -t votify-tunnel)
PIDS=()

cleanup() {
  for pid in ${PIDS[@]:-}; do kill "$pid" 2>/dev/null || true; done
  lsof -tiTCP:8787 -sTCP:LISTEN | xargs kill 2>/dev/null || true
  rm -f "$LOG"
}
trap cleanup EXIT INT TERM

STATE_PATH="$PWD/relayer/.state.devnet.json"
touch "$STATE_PATH.fresh"

run_relayer() {
  while true; do
    DEMO_MODE=true SEED_VOTERS="${SEED_VOTERS:-15}" SPARE_BALLOTS="${SPARE_BALLOTS:-2}" SEED_PACE_MS="${SEED_PACE_MS:-1000}" RPC_URL="$RPC_URL" PUBLIC_RPC_URL="$PUBLIC_RPC" ADMIN_TOKEN="${ADMIN_TOKEN:-}" \
      STATE_PATH="$STATE_PATH" pnpm --filter @zk-election/relayer start >>"$RELAYER_LOG" 2>&1 || true
    echo "The relayer stopped. Starting it again." >>"$RELAYER_LOG"
    sleep 2
  done
}

watch_code() {
  local stamp
  stamp=$(mktemp -t votify-stamp)
  while true; do
    sleep 3
    if [[ -n "$(find relayer/src packages/*/src config -newer "$stamp" -type f 2>/dev/null | head -1)" ]]; then
      touch "$stamp"
      echo "Code changed. Reloading the relayer." >>"$RELAYER_LOG"
      lsof -tiTCP:8787 -sTCP:LISTEN | xargs kill 2>/dev/null || true
    fi
  done
}

run_relayer &
PIDS+=($!)
watch_code &
PIDS+=($!)
for _ in $(seq 1 200); do
  curl -s http://127.0.0.1:8787/ballot >/dev/null && break
  sleep 0.3
done

cloudflared tunnel --url http://127.0.0.1:8787 --no-autoupdate >"$LOG" 2>&1 &
PIDS+=($!)
UPSTREAM=""
for _ in $(seq 1 100); do
  UPSTREAM=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG" | head -1 || true)
  [[ -n "$UPSTREAM" ]] && break
  sleep 0.3
done
if [[ -z "$UPSTREAM" ]]; then
  echo "The tunnel did not start" >&2
  exit 1
fi

VITE_RPC_URL="$PUBLIC_RPC" pnpm --filter @zk-election/web build
cd web
npx --yes wrangler pages project create "$PROJECT" --production-branch main >/dev/null 2>&1 || true
printf '%s' "$UPSTREAM" | npx --yes wrangler pages secret put UPSTREAM --project-name "$PROJECT"
DEPLOY=$(npx --yes wrangler pages deploy dist --project-name "$PROJECT" --branch main --commit-dirty=true | tee /dev/stderr)
SITE=$(printf '%s' "$DEPLOY" | grep -oE 'https://[a-z0-9]+\.[a-z0-9-]+\.pages\.dev' | head -1 | sed -E 's#https://[a-z0-9]+\.#https://#')
SITE=${SITE:-https://$PROJECT.pages.dev}
cd ..

echo
echo "Votify is live."
echo "  Kiosk:    $SITE/kiosk"
echo "  Results:  $SITE/results"
echo "  App server address: $SITE/api"
wait
