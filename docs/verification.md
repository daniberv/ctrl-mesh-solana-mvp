# Verification record

Latest local verification: **16 tests passed** on October 12, 2026. TypeScript checks and browser bundle build also passed.

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
12. A separate MCP process discovering tools and retrieving its authorized context.
13. Journal replay after relay restart and delegation revocation.
14. Epoch report with an on-chain commitment to its signed event and cited evidence.

The four-process demo separately exercises coordinator/provider/reviewer interaction over HTTP and WebSocket; no worker is passed another worker's private key. Its artifacts are deterministic fixtures, and its reviewer checks signatures, bytes and matching API/client contracts.

Browser checks cover project/task views, public marketplace, role switching, task creation through the form, artifact display, dependency graph, responsive layout and browser console errors. The injected-wallet path is implemented but cannot be end-to-end tested here without a browser wallet extension; the same transaction verification code is exercised by the SDK integration suite.

This record describes tested localnet behavior. It does not assert a security audit, production throughput, public-network fork handling, deployed devnet availability or full MEP interoperability.
