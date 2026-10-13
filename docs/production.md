# Production hosting with Solana Devnet

The public product lives at **https://1mesh.xyz**; the workspace is **https://1mesh.xyz/app**. Settlement still uses test SOL on the existing Devnet program `F6eKaEwArFVNWphDWbzawQmnboAVr8XWwDHY8FkzJ2Qi`. There is no Mainnet deployment or new contract deployment in this release.

## Runtime

- Ubuntu VPS `188.137.229.115`; existing applications have separate Nginx virtual hosts.
- Dedicated Node.js 24.21.0 under `/opt/ctrl-mesh/node`; the server's global Node installation is unchanged.
- Versioned source/build releases under `/opt/ctrl-mesh/releases`; `/opt/ctrl-mesh/current` selects the active release.
- Three unprivileged systemd voters: `ctrl-mesh@a`, `ctrl-mesh@b`, `ctrl-mesh@c`.
- Each voter retains its own original SQLite database, sponsor and relay identity under `/var/lib/ctrl-mesh/devnet`. Internal Raft membership and the stream ID are preserved.
- VPS timing uses a 10-second election base (randomized to 10–20 seconds), 5-second peer requests, 500-ms heartbeats and 20-second proposal waits. Unchanged hard state is not rewritten on empty heartbeats; changed terms, votes and watermarks still use FULL-synchronous SQLite persistence. These values accommodate the measured VPS disk latency.
- `ctrl-mesh-gateway` selects the leader for the stable public URL. It forwards HTTP and WebSockets and never automatically replays a mutation.
- Nginx handles TLS and exposes same-origin public voter paths. Browser and agent clients retain these path prefixes when reconnecting. Peer consensus RPC and replication batches are unavailable through the public proxy.
- Cloudflare's published IP ranges are trusted for its connecting-IP header; Nginx overwrites the application proxy IP header. Direct callers cannot override their rate-limit identity.
- Email/password, wallet ownership proofs, multiple wallets and multiple agents retain the existing behavior. Email confirmation remains disabled. Password reset output remains private local mail; no SMTP delivery is configured.

The three voters share **one VPS**. Process failures are recoverable through election and automatic restart; a failure of the whole VPS requires another host. Daily backups currently live on this same server.

## Agent endpoints

Use these explicit addresses with the SDK, CLI or MCP client:

```text
MESH_URL=https://1mesh.xyz/relays/a
MESH_RELAYS=https://1mesh.xyz/relays/b,https://1mesh.xyz/relays/c
MESH_STREAM=f885c45b-facd-4d31-8d72-06ff4435e16a
```

Each agent keeps its own signing key locally. Browser users sign in again on the new domain and prove ownership of a wallet already bound to their account. Existing accounts, wallet bindings, projects and tasks have been copied with the complete signed Devnet journal.

## Operations

```sh
systemctl status ctrl-mesh@a ctrl-mesh@b ctrl-mesh@c ctrl-mesh-gateway
journalctl -u ctrl-mesh@a -u ctrl-mesh@b -u ctrl-mesh@c -u ctrl-mesh-gateway --since '-10 minutes'
curl -fsS https://1mesh.xyz/api/health
systemctl restart ctrl-mesh@a  # restart one voter at a time
systemctl start ctrl-mesh-backup.service
systemctl list-timers ctrl-mesh-backup.timer certbot.timer
```

The backup timer retains the latest 14 private archives in `/var/backups/ctrl-mesh`. Every archive uses SQLite's online backup API for each voter's own database, validates integrity, and includes node keys, cluster configuration, public/proxy configuration and the release manifest. It does not contain the contract upgrade key. Let's Encrypt renews the origin certificate automatically; its deploy hook reloads Nginx after validation.

## Release and rollback

Build with `npm run typecheck`, `npm run build:web` and `npm run build:server`. Install the locked runtime dependencies on Linux with `yarn@1.22.22 install --frozen-lockfile --production --ignore-scripts`. Validate the source hashes in `manifest.json` before switching the current symlink. Preserve a prior release and make a data backup first. Stop/restart all voters when changing shared runtime code; never replace a live SQLite file.

To roll back compatible application code, stop the gateway and voters, point `/opt/ctrl-mesh/current` at the prior release, and restart the voters then gateway. Keep the current databases. Restore a database archive only for a deliberate recovery, with all voters stopped; restore each database to its own voter and restore its matching keys/configuration. Reconcile any transactions that happened after the backup rather than assuming a database rollback can undo Devnet transactions.

The original local voters are stopped. `.mesh/devnet/production-migration.json` fences `devnet:start` locally. **Do not run two independent copies of this same cluster.** Returning to local hosting requires stopping production and restoring the latest production state first. Localnet remains separate.
