#!/usr/bin/env bash
set -uo pipefail
cd "$(dirname "$0")/.."

if [[ -f relayer/.demo.pid ]]; then
  kill -TERM -- "-$(cat relayer/.demo.pid)" 2>/dev/null || kill -TERM "$(cat relayer/.demo.pid)" 2>/dev/null
  rm -f relayer/.demo.pid
fi
pkill -f "scripts/demo-hosted.sh" 2>/dev/null
pkill -f "cloudflared tunnel --url http://127.0.0.1:8787" 2>/dev/null
pkill -f "caffeinate -dims ./scripts/demo-hosted.sh" 2>/dev/null
pkill -f "caffeinate -dims make demo:hosted" 2>/dev/null
lsof -tiTCP:8787 -sTCP:LISTEN | xargs kill 2>/dev/null
sleep 1
echo "Demo stopped."
