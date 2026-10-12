# Verification record

Latest local verification: **24 tests passed** on October 12, 2026 (46 seconds). TypeScript checks and browser bundle build also passed.

The integration suite runs against the compiled Anchor program on a real local Solana validator. It uses independently generated owner, coordinator, reviewer, two provider-owner and two worker keys, and an unauthorized outsider.

Covered behaviors:

1. Original settlement and expiry-refund regression cases.
2. Signed ownership binding; rejection of identity takeover and modified event signatures.
3. Two signed external-provider offers hired into one shared task, with separate recipients.
4. Delegated spending cap at both relay validation and direct program invocation.
5. Client and server rejection of substituted transactions, verification of signed provider quotes before hire, and rejection of stale task revisions.
6. Live subscriptions, missed-event replay and private task visibility.
7. Multi-author result roots, requested changes, invalidation of an earlier positive review after a new result, and rejection of self-review.
8. Exact provider-owner balance changes and prevention of duplicate claims.
9. Recovery when a transaction confirms before its event is appended.
10. Dependency gating and expiry refunds of unfinished collaboration.
11. Unused accepted-task reserve return and owner-only project withdrawal.
12. A separate MCP process discovering tools, retrieving its authorized context, sending a private message and decrypting notes/artifacts locally.
13. Journal replay after relay restart and delegation revocation.
14. Epoch report with an on-chain commitment to its signed event and cited evidence.
15. Ciphertext/scope/audience tampering, substituted or low-order recipient keys, isolated recipient decryption, key rotation and rejection of stale recipient-key versions.
16. Encrypted artifact commitment, reviewer decryption, acceptance, payment and reserve return; no plaintext message or private file name stored in the journal.
17. Pinned peer identity and feed authentication; verified backfill of all transitions against actual transactions; rejection of forged events, substituted transactions and altered receipt snapshots.
18. Replica restart, repair of an offline tail, no duplicate imports, context and WebSocket read fallback after coordinator shutdown, stream mismatch rejection, and persisted journal corruption detection.
19. Three-voter election, peer authentication and majority replication of work shared by two independent provider owners.
20. Primary failure after the signed submission is majority-persisted but before broadcast; a replacement broadcasts the same transaction and returns one event/receipt.
21. Network partition: isolated leader cannot acknowledge updates, majority continues, WebSocket consumers reconnect with the same cursor, and the old node catches up without its uncommitted divergent update.
22. Primary failure after a payment confirms but before its receipt is appended; replacement recovers the receipt, retries return that same receipt, and exact provider-owner balances prove no second payout.
23. Loss of majority blocks both mutation acknowledgements and stale private context reads; the same signed event completes once quorum returns.

The four-process demo separately exercises coordinator/provider/reviewer interaction over HTTP and WebSocket; no worker is passed another worker's private key. Its artifacts are deterministic fixtures, and its reviewer checks signatures, bytes and matching API/client contracts.

Browser checks additionally cover encryption-key publication, an owner-to-reviewer encrypted message decrypted in the reviewer browser, Privacy & network at 1440px/390px, and no plaintext in either live relay database. Browser checks cover project/task views, public marketplace, role switching, task creation through the form, artifact display, dependency graph, responsive layout and browser console errors. The injected-wallet path is implemented but cannot be end-to-end tested here without a browser wallet extension; the same transaction verification code is exercised by the SDK integration suite.

The live sandbox was migrated with its existing **23 events**, original stream ID, existing Solana accounts and browser encryption keys intact. A backup of the original database was saved before migration. Node `a` was then stopped with **SIGKILL** while the browser remained on its original 4173 origin. The loaded browser reauthenticated on node `b` and resumed its workspace automatically. With `a` still down, the four separate demo agent processes created and completed another multi-owner project; each provider owner received **0.015 test SOL**. No private signing key was transferred between agents. This check used real HTTP peer replication and the running local Solana validator, separately from the test harness's deterministic network partitions. Temporary connection errors during the deliberate outage are expected.

Restarted node `a` recovered its stale process lock, rejoined as a follower, and automatically caught up to **41 events**, with the same journal hash on all three nodes and zero pending transactions. A fresh browser load through follower `a` also selected the active coordinator while retaining its original origin and encryption storage.

This record describes tested localnet behavior. It does not assert a security audit, production throughput, public-network fork handling, deployed devnet availability or full MEP interoperability.

During verification of the older local sandbox, the validator had already pruned early transactions. The replica correctly stopped at the missing proof. That sandbox was archived, the validator launcher was changed to retain 10,000,000 shreds by default, and a new four-process project was run successfully with two synchronized relays. Retention is bounded; historical backfill still requires an archival RPC/ledger for long-lived deployments.
