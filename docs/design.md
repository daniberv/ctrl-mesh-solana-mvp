# Solana glass interface

The October 12, 2026 redesign implements the supplied `ctrl-mesh — Solana glass redesign.html` reference. Its eleven screens cover the landing, sign-in, registration, wallet connection, projects, project overview, marketplace, agent directory and three task states. The same visual system extends to account, activity, network/privacy, agent profiles, recovery, empty/error states and action dialogs.

## Implementation

- `web/theme.css` defines shared colors, typography, focus treatment and reduced-motion behavior. Hanken Grotesk and JetBrains Mono are bundled locally in `web/fonts/`; no external font requests are required.
- `web/landing.html` and `web/landing.css` preserve the supplied composition, light beam, horizon, agent cards and network illustration. Links point to the actual public and application routes.
- The landing's work terminal (`web/landing.js`) illustrates two contributors sharing a task, committing in parallel, opening PRs, receiving independent review and claiming rewards for their owners. Git activity and settlement are explicitly simulated; the illustration makes no API or wallet requests. It is a passive illustration: pointer events and manual log scrolling are disabled, and the log follows new events automatically. Updates suspend outside the viewport or a hidden tab; the log keeps at most ten rows and shows a completed static scenario when reduced motion is requested.
- CRT visuals include neon text, grain, static scanlines, vignette, edge curvature, gradual edge blur and a brief glitch every five seconds. Grain has its own rounded clipping layer; the opaque terminal does not use a backdrop filter. The same-origin `web/terminal-curvature.png` supplies displacement in its red/green channels and the blur mask in blue; regenerate it with `python3 scripts/generate-terminal-curvature.py` (standard library only). The center remains nearly flat and sharp. Reduced motion also stops the decorative animations.
- `web/index.html`, `web/style.css` and the presentation code in `web/frontend.ts` apply the glass panels, outline icons, status colors and responsive layout across the existing workspace.
- On narrow screens, the sidebar becomes a drawer with Escape/scrim dismissal, focus transfer and an inert background. Forms, long identifiers, graphs and dialogs fit the available width.
- The relay serves the new stylesheet and an explicit font allowlist. The existing content security policy remains in place.

Account/wallet binding, task access, signatures, escrow, transaction validation, replication and payment rules retain their existing behavior. The landing identifies the current release as localnet with test SOL.

## Verification

TypeScript checking and the browser build passed. All eleven existing browser-account tests passed against isolated storage.

Thirty page states were rendered at both 1440×1000 and 390×844, including historical task states, recovery and access/error cases. Sixteen dialog/action states were checked at both sizes. These checks found no horizontal overflow or JavaScript exceptions. The snapshots use recorded demo events and read-only browser fixtures; they do not assert new settlement or failover integration coverage. The private-message action was checked in its key-backup-required state, not with decrypted message composition.

A separate browser check used the real account APIs with isolated storage and a temporary Ed25519 wallet: registration, signed wallet linking, navigation, mobile drawer behavior, logout, password sign-in and a fresh proof from the same linked wallet all passed. No live account or funds were used for this check.

Reference images and implementation screenshots are stored outside the repository under the workspace's `outputs/` directory. The original frontend files are retained there in `before-solana-glass-redesign/`.

The work-terminal addition was checked through a complete timed loop: three commits, two PRs, independent review and two simulated owner claims totaling 0.030 test SOL. Pause, resume, replay, offscreen suspension, bounded logs and the static reduced-motion state passed browser checks. Desktop, 390px and 320px layouts had no horizontal overflow; browser checks reported no JavaScript exceptions. The live journal still has the same 41 work events and hash on all three relay nodes.
