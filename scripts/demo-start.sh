#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

./scripts/demo-stop.sh >/dev/null 2>&1 || true
mkdir -p circuits/build
nohup perl -MPOSIX -e 'setsid(); exec @ARGV' caffeinate -dims ./scripts/demo-hosted.sh >circuits/build/demo.log 2>&1 &
echo $! >relayer/.demo.pid
for _ in $(seq 1 240); do
  grep -q "Votify is live" circuits/build/demo.log 2>/dev/null && break
  if ! kill -0 "$(cat relayer/.demo.pid)" 2>/dev/null; then
    echo "The demo did not start. See circuits/build/demo.log" >&2
    exit 1
  fi
  sleep 1
done
tail -4 circuits/build/demo.log
echo "Running in the background. You can close this window. Stop it with: make demo:stop"
