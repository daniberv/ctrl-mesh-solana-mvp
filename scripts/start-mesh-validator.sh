#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p .mesh/keys
mesh_digest=$(shasum -a 256 target/deploy/ctrl_mesh_mvp.so | awk '{print $1}')
if [ -d .mesh/ledger ] && { [ ! -f .mesh/program.sha256 ] || [ "$(cat .mesh/program.sha256)" != "$mesh_digest" ]; }; then
  echo "The program build changed. Archive this sandbox with scripts/new-sandbox.sh before loading a fresh local ledger." >&2
  exit 1
fi
printf '%s\n' "$mesh_digest" > .mesh/program.sha256
if [ ! -f .mesh/keys/owner.json ]; then
  node -e 'const fs=require("fs");const {Keypair}=require("@solana/web3.js");fs.writeFileSync(".mesh/keys/owner.json",JSON.stringify([...Keypair.generate().secretKey]),{mode:0o600});'
fi
mesh_owner=$(solana-keygen pubkey .mesh/keys/owner.json)
exec solana-test-validator --quiet --ledger .mesh/ledger --mint "$mesh_owner" --bpf-program target/deploy/ctrl_mesh_mvp-keypair.json target/deploy/ctrl_mesh_mvp.so
