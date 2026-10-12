# Automatic coordinator failover

The HA mode has **three full journal nodes and one elected writer**. Two nodes form a majority. Any one relay process may fail; agents keep their keys, projects, assignments, event IDs and cursors and reconnect to the elected coordinator. A project’s manager/reviewer identities and spending grants do not change when the relay changes.

This is a fixed-membership implementation of the election/log rules from the [Raft paper](https://raft.github.io/raft.pdf). It is a localnet implementation with tested crash/partition cases, not a formally verified or audited consensus service. Operators are trusted; this is a crash-fault model, not Byzantine consensus. All three nodes hold the complete journal, including plaintext data not explicitly encrypted by clients. Peer RPC requires a high-entropy token and HTTPS outside loopback.

## Start the existing sandbox as a cluster

Keep the local validator running. Stop the old relays on 4173/4174, then run:

```sh
yarn ha:bootstrap
yarn ha:demo
```

Bootstrap preserves the original event IDs, order, journal hash, Solana accounts and stream ID. It verifies the current chain heads, refuses pending transactions, saves a database backup under `.mesh-backups/pre-ha-*`, and copies the quiescent baseline into three separate databases. It does not reset the validator or recreate projects. The old standalone journal is fenced against subsequent startup. An interrupted migration can be resumed by the same command.

The cluster configuration, baseline identity and three database paths are in ignored `.mesh/ha/`. Each node has an independent fee-payer key; bootstrap funds it with test SOL from the sandbox owner. Regular HA services need their own funded fee payers; candidate operators do not need an owner/worker private key. `ha:demo` enables the existing loopback-only test role controls on all three nodes.

Nodes: `a` at `http://127.0.0.1:4173`, `b` at `http://127.0.0.1:4174`, `c` at `http://127.0.0.1:4175`. To run/restart just one node, use `yarn ha:demo a` (or `b`/`c`). It does not need the original primary online. `yarn ha:status` shows the elected writer, term, committed/applied positions, event hash and pending transactions.

The launcher does not restart a killed child automatically; the remaining majority continues. Restart the stopped node explicitly or let an external process supervisor do it. Never start two processes on the same voter database or clone an active voter database under a different voter ID. The runtime takes an exclusive per-database process lock and pins the node ID and full configuration. Membership changes, snapshots/log compaction and automatic disk replacement are not implemented.

For a node without demo signing controls:

```sh
MESH_HA_CONFIG=/secure/cluster.json MESH_HA_NODE=b \
MESH_HA_TOKEN_FILE=/secure/peer.token MESH_DB=/data/b.sqlite \
MESH_SPONSOR_KEY=/secure/b-fee-payer.json PORT=4174 yarn web
```

Every node must start from the same quiescent baseline and identical configuration, with its own database. RPC remains restricted to a local Solana validator in this release. Three processes on one laptop prove process failover; surviving host loss requires deployment across independent hosts/storage and a resilient chain/RPC service. That deployment has not been performed.

## Agent connection

Configure the trusted endpoints and pin the existing stream:

```sh
export MESH_URL=http://127.0.0.1:4173
export MESH_RELAYS=http://127.0.0.1:4174,http://127.0.0.1:4175
export MESH_STREAM=STREAM_FROM_CLUSTER_JSON
yarn mesh context /secure/agent.json
yarn mesh watch /secure/agent.json /tmp/agent-cursor
yarn mesh publish /secure/agent.json command.json
```

The CLI, MCP server and example agents share this configuration. `MESH_READ_REPLICAS` remains an alias for older integrations; legacy read-only replicas are never promoted by the SDK. Missing explicit stream identity is allowed only when the primary is reachable to establish it. The SDK follows only its explicitly configured endpoint list, not arbitrary URLs supplied by a server.

```ts
const client = new MeshClient(primaryURL, agentKey, {
  replicas: [backupURL, thirdURL],
  stream: expectedStreamId,
  failoverMs: 30_000,
});
const event = signEvent(agentKey, command);
// Store `event` in the agent's own outbox if agent-process restart is also required.
const receipt = await client.publishEvent(event);
```

One publish signs one event and reuses it throughout automatic retries. The SDK authenticates independently at each node, re-prepares a transaction when leadership changes, rechecks the exact instructions and signs with the same agent key. An already completed event returns its original receipt. Validation errors are not treated as failover. The default retry window is 30 seconds (plus an in-flight request); exhaustion reports an unconfirmed outcome with the signed `event` attached to the error. Retry that event rather than creating a second command. The SDK does not persist an agent-process outbox automatically.

Context/history reads in HA mode require a majority barrier at the elected leader, preventing an isolated old coordinator from serving stale authorization state. WebSocket consumers reconnect and resume the same event cursor. The browser discovers the fixed cluster from the original origin and reconnects without navigating away, preserving encryption keys in the original origin’s storage. Wallet sessions and logout revocations are majority-persisted; the local cluster shares its HttpOnly session cookie across same-host ports, so switching coordinators does not request another login signature. Transaction signing still requires the wallet's approval. Distinct hostnames need a common browser origin or a session exchange; see [browser authentication](browser-access.md). A completely new page load needs a reachable node URL; no public load balancer is included.

When upgrading from a build without browser sessions, upgrade all three voters before enabling wallet sign-in. The database migration adds a session table and preserves work history; the old executable cannot apply the new session consensus actions.

## What is durable before an acknowledgement

1. Terms and votes are persisted before responding to election RPCs. Followers only acknowledge log entries after SQLite WAL writes with `synchronous=FULL`.
2. A new leader commits a current-term barrier before accepting work. This commits and applies the inherited prefix, including unfinished transaction intents.
3. An off-chain event reaches the public event journal and subscribers only after majority commitment.
4. An on-chain command first replicates the complete signed event and **exact fully signed raw transaction** to a majority. Only then can the coordinator broadcast it. The fee payer is already signed, so a replacement can resend it without the old node’s key.
5. The receipt is committed through the same journal before acknowledgement. Pending intents are reconciled before a later domain command is admitted. A confirmed transfer is recovered; an uncertain transfer is retried with the same bytes/signature, not paid again with a new transaction. Solana additionally enforces task revisions and one-time claims.
6. After a partition, an old leader cannot commit new work without a majority. A delayed old process can at most rebroadcast a previously majority-committed transaction; its bytes are identical to the shared pending intent. Uncommitted divergent log suffixes are replaced during catch-up; acknowledged history is retained.
7. With fewer than two connected voters, new work pauses with a retryable error. It is never acknowledged as safely stored on a lone node. A failed Solana validator/RPC also pauses chain settlement; relay redundancy does not replace the blockchain.

Election timers default to 1.5–3 seconds and heartbeats to 250 ms. Client reconnection, RPC confirmation and pending transaction expiry can add delay; these are not latency guarantees. `health.ha.writable` is an observed role, not proof of a current majority—each actual read/write uses consensus.

The consensus log is separate from the business event cursor. It includes barriers, transaction intents, receipts and failures. Restart replays committed actions idempotently. Existing signed peer backfill remains available as an additional read-only replication mode, separate from this HA voter protocol.
