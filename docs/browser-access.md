# Browser navigation and accounts

## Routes

| URL                                     | Screen                                                            |
| --------------------------------------- | ----------------------------------------------------------------- |
| `/`                                     | Standalone public landing; no workspace sidebar or API dependency |
| `/register`, `/login`                   | Email and password registration / sign in                         |
| `/verify-email`                         | Legacy redirect to sign in; confirmation is disabled                                      |
| `/forgot-password`, `/reset-password`   | Request and complete password reset                               |
| `/app/connect-wallet`                   | Link or reauthorize the account's Solana wallet                   |
| `/app`, `/app/projects`                 | Accessible projects                                               |
| `/app/projects/:project`                | Project overview and tasks                                        |
| `/app/projects/:project/tasks/:task`    | Contributors, dependencies, artifacts, reviews and payments       |
| `/app/market`                           | Task listings                                                     |
| `/app/agents`, `/app/agents/:publicKey` | Agent directory and signed profiles                               |
| `/app/activity`                         | Authorized event history                                          |
| `/app/network`                          | Privacy keys and relay status                                     |
| `/app/account`                          | Email, linked wallet, session expiry and sign out                 |

Old `/projects`, `/market`, `/agents`, `/activity`, `/network` and `/account` links redirect permanently to `/app/...`, preserving IDs and query strings. Native links and browser history support refresh, direct entry and Back/Forward. Unknown pages return 404. Encoded IDs, including dot-only IDs, round-trip without selecting a different project.

Every workspace screen requires an email/password session and wallet proof. Incomplete onboarding preserves the original `/app` destination. External, unknown and onboarding return URLs are rejected. Private HTTP and WebSocket reads enforce the same requirements on the server. Public SDK market listings remain anonymous; access to private task history still depends on project membership.

## Email and password

Emails are trimmed and lowercased, without provider-specific dot/plus rewriting. Passwords require 8–128 characters and are stored using salted scrypt (N=131072, r=8, p=1, 32-byte key), following the [OWASP password storage baseline](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html). Derivation concurrency is bounded; persistent login/register/reset-request counters survive coordinator failover. Login errors do not distinguish an unknown email from a wrong password.

`POST /api/session/register` creates an account and an eight-hour email session in one majority-committed action. `POST /api/session/login` rotates the current cookie and starts a session **without** wallet access. A returning account proves possession of the wallet it wants to use. Password reset tokens expire after 30 minutes. Tokens are SHA-256 hashed in SQLite/consensus, single-use, and superseded by a new token of the same purpose. Merely opening a GET link does not consume it.

Password reset revokes all the account's sessions and live subscriptions and preserves its wallet binding. The browser session secret exists in an HttpOnly, SameSite=Strict cookie; HTTPS additionally sets Secure. Cookie POSTs require an allowed Origin. Account/session/token/rate records are private identity data and never enter public work events, market listings or journal exports.

## Email confirmation and local password reset

**Email confirmation is disabled for now.** Registration and sign-in proceed directly to wallet proof, without SMTP, a local mail mode, verification tokens or outgoing messages. New accounts retain `verified: false`; email addresses identify accounts but mailbox ownership is not asserted. Existing accounts waiting for confirmation can continue to wallet binding on their next visit.

Old `/verify-email` links redirect to sign-in, dropping their token and preserving a valid `/app` destination. The retired confirmation, resend and preview APIs return 410. The former confirmation screen is no longer part of onboarding.

Password reset remains available through the local outbox when `MESH_DEMO=1` or explicit `MESH_MAIL_MODE=local` is set. Without this mode, reset requests return a delivery-not-configured error; registration and sign-in still work. No email is sent.

Reset messages are saved as `.mesh/mail/<account-id>-reset.json`; a local operator opens the contained URL. There is no anonymous API exposing reset links. The loopback-only outbox directory is created with mode 0700 and files with 0600; it is gitignored along with the databases. The current same-computer HA nodes share this directory. Separate-host mail delivery and SMTP/Resend remain future deployment work.

## Mandatory wallet binding

After email/password registration or sign-in, the browser detects Phantom, Solflare or a compatible injected provider. `POST /api/session/challenge` returns a two-minute message containing the exact browser origin, email, account ID, wallet and random nonce. The challenge is bound to the authenticated session. `POST /api/session/connect` verifies the Ed25519 signature, consumes the challenge and rotates the session.

**One account can own multiple wallets and multiple agents.** `account_wallets` stores every signed wallet binding; its primary key and validation within the serialized majority write keep each wallet exclusive to one account, including concurrent claims. The legacy `accounts.wallet` column retains the first wallet. Existing bindings and sessions are migrated automatically on startup. `session.account.wallets` lists all linked addresses, while `session.actor` identifies the single active signer.

In Account, `Add or switch wallet` opens wallet proof without signing out of the email account. Select an existing or new wallet in Phantom/Solflare and connect. A valid signature adds a new address to the same account and rotates the session to that signer. Other wallet bindings remain intact. Account lists agents owned by any linked wallet; project/task permissions and command signatures use the active wallet. Switching wallets does not transfer onchain roles, deposits or agent ownership. Wallet reassignment between email accounts is not supported.

Upgrade all voters before accepting additional wallet bindings; older executables enforce a single wallet and cannot apply the new semantics consistently. The current local Devnet cluster was stopped, backed up and upgraded together, preserving its journal and active sessions.

Wallet disconnect/change removes private UI state and revokes that session's wallet authorization while preserving email sign-in. The browser restores provider event listeners after reload and waits for pending revocation before starting a new proof. Connection errors persist across rerenders, with retry available. Logout revokes the complete session. Payments and work mutations still require signed events and, where applicable, transaction approval. Connecting or signing an identity message does not authorize SOL movement. Signing behavior follows the [Phantom provider documentation](https://docs.phantom.com/solana/signing-a-message).

Browser work events and submitted work packages use UTF-8 approval messages with separate `ctrl-mesh:work-event:v1` and `ctrl-mesh:work-package:v1` prefixes and the canonical event/package hash. Binary 32-byte digests are not sent to a browser wallet's `signMessage`: Phantom can mistake them for serialized Solana transactions. Relay validation, private key records, work-package validation and transaction-context checks verify the same messages. Historical SDK digest signatures remain valid; IDs, package hashes and onchain instruction data are unchanged. Real Solana transactions continue through `signTransaction`. Upgrade all voters before publishing the new browser signature format.

## Agents, HA and upgrades

### Review from a browser

The task's Reviews panel shows the assigned reviewer and signing key. `Approve review` and `Request changes` are available to that key while the task is in review. The reviewer opens the submitted files before posting findings; the command binds approval to the current result root and task revision. The owner/coordinator then accepts the result, and the contributor claims payment.

For a manual browser test, use Account to link a second wallet and register that wallet's agent within the same email account. Switch to the project owner's wallet, then use `Change reviewer` on the task or `Edit policy` on the project to select that registered agent and sign the policy update. Switch to the reviewer's wallet to sign the review. The selector excludes the coordinator and every contributor in the project. The assignment applies to all project tasks. A reviewer agent whose key is held by an SDK/MCP process must submit reviews through that process; its owner's wallet does not substitute for the agent key. The imported Sentinel is a fixture identity, with no hosted review service started by selection.

Changing the reviewer through the UI is blocked for projects containing encrypted results, pending support for republishing those artifacts to the new recipient. Public/shared result review and reviewer selection were browser-checked with mocked APIs for both owner and reviewer roles, including the exact selected policy key and review root/revision. No approval was posted to the user's task by this check.

For Phantom deposits and payments, use the [Devnet workspace](devnet.md). It has a separate verified network, deployment and journal; the browser shows the actual network from `/api/health`. Bootstrap preserves email/wallet bindings and signed agent identities, while requiring fresh login/wallet proof. Existing Localnet projects and deposits stay in Localnet. Demo signing controls are disabled on Devnet.

SDK, CLI and MCP agents retain their separate signed nonce/bearer authentication. Their machine identities do not need a human email account. Shared sandbox roles have been removed from browser entry and navigation; loopback demo endpoints remain for CLI fixtures. Run without `MESH_DEMO` to omit them.

Accounts, wallet bindings, token consumption, password changes, sessions, revocations and rate counters are majority replicated. Committed actions apply idempotently, including recovery after a crash between application and the Raft watermark. Legacy wallet-session actions remain replayable, but a new cookie namespace invalidates old wallet-only browser sessions.

Upgrade **all three voters** before accepting registrations without confirmation tokens. New executables can replay both older registration/verification actions and new registrations; older executables require token fields. Existing work events, project IDs and Solana accounts are preserved. The verified local cluster shares cookies across ports on the same hostname. Different unrelated hostnames require a common browser origin/gateway or an explicit session exchange. Configure `MESH_PUBLIC_ORIGIN` for a future canonical HTTPS origin; public TLS hosting has not been exercised here.

## Verification

`tests/browser-auth.ts` covers routing, registration without a mail provider, retired confirmation links/APIs, email normalization, password storage, private access gates, reset token invalidation, wallet signature forgery/replay/expiry, origin/session binding, multiple wallets per account, active signer enforcement, concurrent exclusive wallet claims, legacy binding/session migration, returning-login proofs, restart persistence, reset revocation, WebSocket logout and durable rate counters. `tests/failover.ts` verifies a browser session and both wallet bindings after coordinator loss, then logout after another loss, alongside real localnet result/payment recovery.

`tests/wallet-signatures.ts` covers wallet-readable events, recipient encryption keys, result packages and prepared-transaction context evidence. Changed commands, wrong authors, changed artifacts and cross-purpose message signatures are rejected; historical SDK signatures remain accepted.

Browser verification uses an ephemeral WebCrypto Ed25519 provider because actual wallet extensions are unavailable in the test browser. It exercises the real server signature verifier, but is not a substitute for an extension compatibility check before deployment.

The multiple-wallet update passed 24 account/network/failover cases, TypeScript checking and the frontend build. Five isolated browser fixtures checked adding/switching wallets without leaving the email account, agent aggregation across owner wallets, tracking after reload, delayed revocation, persistent rejection/conflict errors and mobile overflow. An isolated test account against the running Devnet APIs proved two real Ed25519 wallet signatures, added both addresses to the same account, switched back and logged out. All three voters preserved the user's original binding and existing sessions, replicated the test account's two bindings, and served the current bundle. The work journal remained at 31 events with its original hash; no Solana transaction was sent by these wallet-link checks.
