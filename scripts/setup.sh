#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

SOLANA_VERSION=4.1.2
ANCHOR_VERSION=1.2.2
CIRCOM_VERSION=v2.2.3
NODE_MAJOR_MIN=22

say() { printf '\n==> %s\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }

say "Checking prerequisites"
xcode-select -p >/dev/null 2>&1 || { echo "Install the Xcode command line tools: xcode-select --install"; exit 1; }
have node || { echo "Install Node.js >= $NODE_MAJOR_MIN (https://nodejs.org or nvm)"; exit 1; }
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge "$NODE_MAJOR_MIN" ] || { echo "Node.js >= $NODE_MAJOR_MIN required"; exit 1; }

if ! have rustup; then
  say "Installing Rust"
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
  . "$HOME/.cargo/env"
fi

if ! have solana || ! solana --version | grep -q " $SOLANA_VERSION "; then
  say "Installing Solana CLI $SOLANA_VERSION"
  if have agave-install; then agave-install init "$SOLANA_VERSION"
  else sh -c "$(curl -sSfL https://release.anza.xyz/v$SOLANA_VERSION/install)"; fi
  export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
fi

if ! have avm; then
  say "Installing avm (Anchor version manager)"
  cargo install --git https://github.com/solana-foundation/anchor avm --force
fi
if ! avm list 2>/dev/null | grep -q "^$ANCHOR_VERSION.*installed"; then
  say "Installing Anchor $ANCHOR_VERSION"
  current=$(avm list 2>/dev/null | awk '/current/ {print $1}' || true)
  avm install "$ANCHOR_VERSION"
  [ -n "${current:-}" ] && avm use "$current" >/dev/null
fi

if ! have circom; then
  say "Installing circom $CIRCOM_VERSION"
  cargo install --git https://github.com/iden3/circom.git --tag "$CIRCOM_VERSION" circom
fi

say "Enabling pnpm through corepack"
corepack --version >/dev/null 2>&1 || npm install -g corepack@latest
node -e 'const [a,b]=process.argv[1].split(".").map(Number); process.exit(a>0||b>=36?0:1)' "$(corepack --version)" \
  || npm install -g corepack@latest
corepack enable pnpm 2>/dev/null || true

[ -f "$HOME/.config/solana/id.json" ] || { say "Creating a local Solana keypair"; solana-keygen new --no-bip39-passphrase -s -o "$HOME/.config/solana/id.json"; }

say "Installing JavaScript dependencies"
COREPACK_ENABLE_DOWNLOAD_PROMPT=0 pnpm install --frozen-lockfile --config.strict-dep-builds=false

say "Building circuits (local demo trusted setup)"
pnpm circuits:build

say "Building the program"
pnpm program:build

say "Done. Next: make test && make program:test"
