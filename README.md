# ctrl-mesh · Solana work settlement MVP

A clean-room, independently implemented vertical slice for the Colosseum Crypto World's Fair hackathon. A worker signs a manifest of delivered files; an authorized approver accepts its hash; a Solana program releases the task's escrowed SOL to the worker. The package manifest and file contents remain off-chain.

This repository was created without access to the earlier MEP reference implementation. The supplied MEP PDFs informed the product concept, but their claimed reference stack is **not** included here. This MVP implements its own small proof format and settlement program. It does not implement the MEP relay, federation, Explorer, or SPL-token escrow described as future or separate work in the concept documents.

## Demonstrated flow

1. Owner creates a task, chooses separate worker and approver keys, sets a deadline, and deposits SOL into a program-owned task account.
2. Worker hashes files into a canonical manifest and signs the package hash with Ed25519.
3. Worker submits that exact package hash to the Solana task account.
4. The approver checks the off-chain files and signature, then signs acceptance. The program pays the fixed amount to the stored worker in the same transaction that marks the task accepted.
5. A changed file fails off-chain verification; a changed package hash, unauthorized approver, or second payout fails on-chain. If no acceptance occurs before the deadline, the owner can refund the deposit.

The on-chain program records acceptance of a hash, **not** that code is correct or that the off-chain files will remain available. This is an experimental hackathon implementation using local test SOL; it is not audited for use with real funds.

## Run locally

Requires Node.js, Yarn 1, Rust, Solana CLI, Anchor CLI 0.31.1, and `solana-test-validator`.

```bash
yarn install
anchor build
anchor test --skip-build
```

For a readable end-to-end demo, run these in separate terminals:

```bash
./scripts/start-localnet.sh
```

```bash
yarn demo
```

The demo creates its own ignored local wallet in `.demo/`, uses a genesis-funded local validator, sends actual program transactions, verifies the worker's signature and artifact bytes, and writes `.demo/receipt.json`. It never connects to mainnet. A separate owner wallet is generated for this demo; no pre-existing user wallet is needed.

## Repository map

- `programs/ctrl_mesh_mvp/src/lib.rs` — Solana task escrow and state transitions.
- `src/proof.ts` — deterministic file manifest, SHA-256 package hash, Ed25519 signature and verification.
- `src/demo.ts` — transaction-backed local demo.
- `tests/ctrl_mesh_mvp.ts` — settlement, tamper rejection, replay rejection, and refund tests.
- `tests/proof.ts` — file and signature verification.
- `examples/product-update.md` — example artifact used by the demo.

## Current scope and next steps

The MVP pays native SOL; a production version would add SPL-token support, a persistent evidence store, independent review policy, wallet-facing UI, security audit, and a bridge to the full MEP event schema. Devnet deployment and hosted demo are separate from the currently verified local test flow.

## Hackathon provenance

The broader ctrl-mesh/MEP architecture predates this hackathon and is described in the source one-pagers. This repository was started on October 12, 2026 after access to that code became unavailable. The Solana escrow program, signed manifest utility, local demo, and tests in this repository were implemented independently for the hackathon. It should be evaluated on that new work, not on functionality from the inaccessible prior stack.
