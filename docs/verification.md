# Verification record

## Devnet deployment — October 12, 2026

TypeScript checking and the browser bundle build passed. **26 focused tests passed**: five network/bootstrap/preflight cases, eleven account cases, four browser-signature cases and six automatic failover cases. These checks reject an incorrect genesis, a missing program and cross-network database reuse; verify that account/wallet bindings and signed agent registrations carry to all three new voters; exclude chain receipts, sessions and intents; preserve the source; and catch funding/simulation errors before a wallet transaction signature. Failover checks exercised real local result/payment recovery without duplicate payouts.

A preview migration copied three accounts and nine registration records without changing Localnet's 42 events, hash or genesis. After the user funded the dedicated wallet, the program deployed to Devnet, its binary/upgrade authority were verified, and all three relay fee payers were funded. The application now runs on Devnet at the original three URLs.

Live Devnet verification covered a project, a public task, two external-provider offers/awards, two signed result packages, independent review, acceptance, owner payments of exactly 3,000,000 and 2,000,000 lamports, and withdrawal of unused project funds. Primary `a` stopped after the first result; `b` completed the remaining work and payments. The test exposed an election-time SDK context-read error, which was fixed with bounded automatic read retries. A fresh live check stopped `b` and immediately read the intact accepted/paid task through `a` in 1,862 ms. All six local failover tests passed again, including the added immediate-read check. [Devnet setup and chain evidence](devnet.md) records program/job addresses and the repeatable commands; `.mesh/devnet/verification.json` retains every transaction signature.

Browser verification confirmed real Devnet health/genesis/program metadata, a fresh email/password login gate, disabled demo signing endpoints, and no JavaScript errors or 390px overflow. The actual Phantom extension was not automated.

## Solana glass redesign — October 12, 2026

TypeScript checking, the browser bundle build and all **11 browser-account tests** passed. The supplied design was implemented across the landing, account entry, workspace sections and action forms. **30 page states and 16 dialog/action states** were inspected at both desktop and mobile sizes with no horizontal overflow or JavaScript exceptions. A separate browser flow against isolated real account APIs checked registration, wallet signatures, mobile navigation, logout and sign-in with the uniquely linked wallet. This redesign did not rerun the complete protocol or settlement suite. See [implementation and verification details](design.md).

## Email confirmation disabled — October 12, 2026

**17 focused tests passed** (19 seconds): all 11 browser-account cases and all six automatic failover cases, using the existing local Solana validator. TypeScript checks and the browser bundle build passed. This correction did not rerun the complete platform suite.

Registration works with no mail provider or local mail mode. Accounts remain `verified: false` and proceed from email/password straight to signed wallet binding. The checks retain unique email/wallet claims, forged/replayed/expired signature rejection, session/origin binding, logout/reset revocation, durable rate limits, registration/session replication, coordinator failure, and result/payment recovery without duplicate payouts. Retired confirmation APIs return 410 and old confirmation links preserve only a validated return path.

Browser check: direct `/app/market` → sign-in → registration → wallet connection → `/app/market`, with **zero confirmation requests**, `verified: false`, and private context HTTP 200 after the wallet proof. Account details display **WALLET LINKED**. Opening an old confirmation link drops its token and returns to the intended workspace; the session and live stream survive the reload with no wallet provider present. Logout returns to sign-in. The two-step account/wallet form was checked at 390px, with no console errors. The signature used an ephemeral WebCrypto Ed25519 adapter, not an installed wallet extension.

All three live nodes were upgraded. Existing work history remains **41 events** with matching hashes and zero pending transactions. Historical account and confirmation actions replay successfully alongside new token-free registrations.

## Previous email-account release — October 12, 2026

The complete suite passed **36 cases** in 55 seconds before this correction. That release added normalized unique email accounts, salted password hashing, one-account/one-wallet enforcement, session-bound signatures, password reset with full session/socket revocation, persistent rate limits, and account/session failover. Routes were separated into public `/`, account entry and protected `/app/...` pages. Its local email confirmation step has now been removed.

Earlier browser checks covered all six navigation sections, 390px mobile layout, rejected/accepted signatures, refresh restoration, logout/Back, and bad-password rejection followed by sign-in requiring the original wallet. Actual Phantom/Solflare extensions were unavailable.

## Earlier platform verification

The following records describe prior platform and wallet-only checks; demo-role UI references below are historical.

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
24. Deep HTTP routes, encoded identifiers, invalid paths and restricted post-login return URLs.
25. Browser nonce binding, wallet signature verification, expiry/replay rejection, wrong-origin denial, HttpOnly cookies, persistent and rotated sessions, actor binding, logout and live-subscription revocation.
26. Wallet session recognition after coordinator failure and persisted logout revocation after another coordinator failure.

The four-process demo separately exercises coordinator/provider/reviewer interaction over HTTP and WebSocket; no worker is passed another worker's private key. Its artifacts are deterministic fixtures, and its reviewer checks signatures, bytes and matching API/client contracts.

Browser checks additionally cover encryption-key publication, an owner-to-reviewer encrypted message decrypted in the reviewer browser, Privacy & network at 1440px/390px, and no plaintext in either live relay database. Browser checks cover project/task views, public marketplace, role switching, task creation through the form, artifact display, dependency graph, responsive layout and browser console errors. New checks covered all section URLs, task and agent profile deep links, refresh/back/forward, guest access, explicit demo entry/exit, and wallet sign-in using an ephemeral WebCrypto Ed25519 provider. Rejected signatures left the visitor anonymous; accepted signatures restored the original destination while denying that new identity access to another owner's private task. Actual Phantom/Solflare extensions were not available for this check; transaction verification is exercised by the SDK integration suite.

The browser's authenticated wallet session survived a live **SIGKILL of node a**, automatically resumed its subscription through node c without another signature, and survived a complete page reload after a rejoined. The ephemeral provider was absent after reload, proving cookie-session restoration. Sign out returned the private context API to 401, and browser Back returned protected routes to login. A fresh account page had zero browser console errors before the intentional unauthorized request. Existing work history remained at **41 events**, unchanged.

The live sandbox was migrated with its existing **23 events**, original stream ID, existing Solana accounts and browser encryption keys intact. A backup of the original database was saved before migration. Node `a` was then stopped with **SIGKILL** while the browser remained on its original 4173 origin. The loaded browser reauthenticated on node `b` and resumed its workspace automatically. With `a` still down, the four separate demo agent processes created and completed another multi-owner project; each provider owner received **0.015 test SOL**. No private signing key was transferred between agents. This check used real HTTP peer replication and the running local Solana validator, separately from the test harness's deterministic network partitions. Temporary connection errors during the deliberate outage are expected.

Restarted node `a` recovered its stale process lock, rejoined as a follower, and automatically caught up to **41 events**, with the same journal hash on all three nodes and zero pending transactions. A fresh browser load through follower `a` also selected the active coordinator while retaining its original origin and encryption storage.

This record describes tested localnet behavior. It does not assert a security audit, production throughput, public-network fork handling, deployed devnet availability or full MEP interoperability.

During verification of the older local sandbox, the validator had already pruned early transactions. The replica correctly stopped at the missing proof. That sandbox was archived, the validator launcher was changed to retain 10,000,000 shreds by default, and a new four-process project was run successfully with two synchronized relays. Retention is bounded; historical backfill still requires an archival RPC/ledger for long-lived deployments.
