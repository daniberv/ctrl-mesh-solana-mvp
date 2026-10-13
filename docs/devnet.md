# Devnet workspace

Devnet uses the existing program ID `F6eKaEwArFVNWphDWbzawQmnboAVr8XWwDHY8FkzJ2Qi`, with a separate deployment, fee payers, relay identities, cluster, stream and journal under `.mesh/devnet/`. Localnet remains under `.mesh/ha/` and `.mesh/ledger/`.

## Prepare and deploy

```sh
yarn devnet:prepare
```

This creates private keys with mode 0600 in the gitignored directory and prints the public deployment address, actual RPC rent estimates and funding shortfall. Fund that address with **Devnet test SOL**. For the current 382,416-byte artifact, 4.2 test SOL covers the peak buffer/program allocation, deployment fees and 0.05 SOL for each relay. The deployment buffer rent returns to the deployer after successful deployment. `yarn devnet:status` recalculates the estimate and balances.

```sh
yarn devnet:deploy
yarn devnet:bootstrap
```

Deployment pins the RPC to Devnet's genesis, explicitly supplies the fee payer, upgrade authority and program keypair, uses the binary's exact allocation length, and saves a buffer keypair so interrupted uploads can resume. A loopback proxy spaces requests to the HTTPS upstream. The loader writes missing 900-byte chunks in confirmed batches of 16 with a fresh blockhash, compares the full buffer against the artifact, then finalizes through the Solana CLI. It compares the resulting ProgramData bytes against the local artifact and verifies the upgrade authority before funding all three relay fee payers. It preserves the default Solana CLI configuration. No user seed phrase or wallet private key is needed.

`SOLANA_RPC=https://your-devnet-rpc.example yarn devnet:prepare` configures a custom Devnet RPC on first preparation. The same variable can override the saved endpoint for subsequent commands; the genesis check still applies. Mainnet and Testnet are refused. Avoid sending user secrets in the RPC URL.

## Identity migration

Bootstrap takes a read transaction on `.mesh/ha/a.sqlite` and copies email/password hashes and all wallet bindings from `account_wallets`, with a fallback for legacy `accounts.wallet` sources. It verifies and replays only signed `agent.register` records into a new stream. `MESH_IDENTITY_SOURCE=/path/to/source.sqlite` selects a different identity source. Localnet projects, tasks, deposits, payments, pending commands, encryption publications, cookies, reset tokens and consensus logs are not imported. The original journal stays intact. Pending local commands must be reconciled before bootstrap.

All three new voters receive the same baseline journal and accounts. Bootstrap refuses to reset an existing Devnet cluster. After the switch, sign in with the existing email/password and prove possession of the linked wallet again. Re-enable the encryption identity in the Devnet workspace when private work is needed.

## Start

Stop the Localnet HA runner before starting Devnet, since both use ports 4173–4175:

```sh
yarn devnet:start
# In another terminal:
yarn devnet:ha-status
```

Open `http://127.0.0.1:4173/app`. In Phantom, enable **Settings → Developer Settings → Testnet Mode → Solana Devnet**. The app's sidebar displays the server's verified network; Privacy & network displays the program and genesis. `/api/health` supplies the same network metadata on every voter. Devnet balances are independent of Localnet and Mainnet.

Devnet starts without demo signing endpoints. Agents use the SDK/CLI/MCP with their own registered keys; the owner signs deposits in the browser. Each elected relay pays transaction fees and task-account creation costs from its own fee payer. Before an onchain transaction reaches the wallet, the relay checks fee funding and simulates the prepared transaction through its Devnet RPC. Real signing still uses `signTransaction`, followed by majority persistence and relay broadcast.

Transactions specify a 200,000-CU limit and a price of 1,000 micro-lamports per CU before simulation and wallet signing. The additional priority fee is 200 lamports, paid by the relay. [Phantom automatically adds priority fees](https://docs.phantom.com/developer-powertools/solana-priority-fees) when an unsigned transaction has no existing compute budget instructions; this previously caused `Transaction differs from prepared command`. Explicit preparation prevents that modification. The browser checks the returned message before publishing, and the relay still requires byte-for-byte equality and the actor's valid signature. Historical journal verification accepts the exact previous instruction format as well as the exact current format.

`yarn devnet:start a` runs one voter independently, allowing a stopped node to rejoin its own database. Two connected voters are required for writes. Never clone an active voter's database onto another node. The default configuration runs all three relays on one computer and uses the public Devnet RPC; separate-machine hosting and resilient RPC remain separate deployment work.

To return to the preserved Localnet workspace, stop the Devnet runner, keep/start its original validator, and run `yarn ha:demo`. Sign in again when changing workspaces.

## Verification status — October 12, 2026

**26 tests passed:** five network/bootstrap/preflight cases, eleven account cases, four browser-signature cases and six automatic failover cases. Failover result/payment recovery was tested on the existing local validator. TypeScript checking and browser build passed. A preview using the existing journal copied three accounts and nine signed registration records while preserving all 42 original local events and their hash.

The user funded the dedicated deployer with 4.2 Devnet SOL after the faucet returned HTTP 429. The program was deployed at [the existing program address](https://explorer.solana.com/address/F6eKaEwArFVNWphDWbzawQmnboAVr8XWwDHY8FkzJ2Qi?cluster=devnet); the binary and deployer upgrade authority matched. All three relay fee payers were funded and the runtime switched to Devnet.

The live test created project `devnet-check-1791837962952`, hired two agents from different owners, submitted both signed artifacts, independently reviewed and accepted the aggregate result, and paid exactly 3,000,000 and 2,000,000 lamports to those owners. The primary `a` stopped after the first submission; `b` accepted the second submission and completed review/payment. Remaining project funds were withdrawn by the test owner. The result is recorded in `.mesh/devnet/verification.json`, with all transaction signatures. The [job account](https://explorer.solana.com/address/2HSFsBQZQRHHR2LZFnFKX7hUSbbswD9hZbEvgCyPfkET?cluster=devnet) confirms both contributions were paid.

The first live failover exposed an SDK context-read error during election. Context reads with configured replicas now retry temporary failures within `failoverMs`; authentication and stream mismatch errors remain terminal. A fresh Devnet check stopped primary `b` and immediately requested context; the SDK returned through `a` after 1,862 ms with the accepted/paid task intact. The updated local failover suite also verifies immediate context reads during election.

`yarn devnet:verify --failover` performs this controlled integration check using the existing Localnet fixture-agent keys and test SOL from the deployer. It deliberately stops one live voter; restart that voter afterwards. `MESH_VERIFY_PROJECT=<id> MESH_VERIFY_FAILED_NODE=<node> yarn devnet:verify` continues an incomplete test with its existing task and records the prior failure. These actors generate deterministic test artifacts; they are not hosted production agent runtimes.

The three accounts and nine signed registration records were imported; Localnet's 42-event journal and hash were preserved. A browser check confirmed the protected-page login redirect and real Devnet health metadata, with no JavaScript errors or 390px overflow. Actual Phantom extension interaction remains a user-driven check.

## Wallet transaction fix verification — October 13, 2026

34 tests passed: four new wallet-transaction cases, four message-signature cases, five network cases, six failover cases and fifteen multi-owner integration cases. The new cases reproduce Phantom's documented fee insertion, confirm exact messages with explicit fees and a separate sponsor, reject modified fees/commands/payers/blockhashes/transfers and missing actor signatures, and verify older transactions without compute budget instructions. TypeScript checking and browser build passed.

The live browser form created `project-1791839520887` in Devnet with a controlled Ed25519 provider, wallet-as-coordinator and independent Sentinel reviewer. Its 0.01 test SOL deposit was then withdrawn through the form. Both transactions had valid actor/sponsor signatures, two explicit compute budget instructions and a 10,200-lamport sponsor-paid fee. The project vault retained only rent. The result is saved in `.mesh/devnet/browser-wallet-check-result.json`. All three updated nodes converged with no pending commands. This check did not automate the actual Phantom extension.
