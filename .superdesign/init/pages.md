# Page dependency trees
## / Landing (new target)
- web/landing.html
  - web/landing.css
## /login, /register, /verify-email, /forgot-password, /reset-password, /app/connect-wallet
- web/index.html
  - web/style.css
  - web/frontend.ts -> web/app.js (esbuild)
    - src/routes.ts
    - src/mesh/encryption.ts
      - src/mesh/events.ts (type only)
    - src/mesh/transaction.ts
      - src/mesh/events.ts (type only)
      - src/mesh/state.ts (type only)
      - target/idl/ctrl_mesh_mvp.json
    - src/mesh/accounts.ts (type only)
## /app, /app/projects/:id, /app/projects/:id/tasks/:id
Same shell and complete dependency tree as account routes; render() + renderDetail() branches in frontend.ts.
## /app/market, /app/agents, /app/agents/:key
Same shell and dependency tree; render() market and agent branches.
## /app/activity, /app/network, /app/account
Same shell and dependency tree; render() activity, privacy and account branches.
No other local runtime imports touch the UI. Server modules are not sent to design generation.
