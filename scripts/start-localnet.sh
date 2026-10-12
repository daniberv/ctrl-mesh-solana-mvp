#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p .demo
if [ ! -f .demo/owner.json ]; then
  node -e 'const fs=require("fs"); const {Keypair}=require("@solana/web3.js"); fs.writeFileSync(".demo/owner.json", JSON.stringify(Array.from(Keypair.generate().secretKey)), {mode: 0o600});'
fi
owner_pubkey=$(solana-keygen pubkey .demo/owner.json)
echo "Local demo owner: $owner_pubkey"
echo "RPC: http://127.0.0.1:8899"
exec solana-test-validator --reset --quiet --ledger .demo/ledger \
  --mint "$owner_pubkey" \
  --bpf-program target/deploy/ctrl_mesh_mvp-keypair.json target/deploy/ctrl_mesh_mvp.so
