import nacl from "tweetnacl";
import {
  PRIVATE_ALGORITHM,
  SEALED_FILE,
  seal,
  unseal,
  verifySignedEnvelope,
} from "../src/mesh/encryption";
import { verifyPreparedTransaction } from "../src/mesh/transaction";
import { Transaction, PublicKey } from "@solana/web3.js";
import { Buffer } from "buffer";
(globalThis as any).Buffer = Buffer;
const $ = (id: string) => document.getElementById(id)!;
const escape = (v: any) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[
        c
      ]!)
  );
const short = (v: string) => (v ? v.slice(0, 6) + "…" + v.slice(-5) : "—");
const sol = (v: number) =>
  ((v || 0) / 1e9).toLocaleString(undefined, { maximumFractionDigits: 5 });
const canonical = (v: any): string =>
  v === null || typeof v !== "object"
    ? JSON.stringify(v)
    : Array.isArray(v)
    ? "[" + v.map(canonical).join(",") + "]"
    : "{" +
      Object.keys(v)
        .sort()
        .map((k) => JSON.stringify(k) + ":" + canonical(v[k]))
        .join(",") +
      "}";
const sha = async (v: string) =>
  Buffer.from(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v))
  ).toString("hex");
const kinds: any = {
  "key.publish": 30002,
  "private.publish": 30111,
  "project.withdraw": 30041,
  "job.reclaim": 30025,
  "agent.register": 30001,
  "project.create": 30000,
  "project.policy": 30040,
  "job.open": 30010,
  "offer.publish": 30011,
  "job.award": 30012,
  "job.submit": 30110,
  "job.review": 30020,
  "job.accept": 30021,
  "job.claim": 30085,
  "job.cancel": 30022,
  "job.release": 30023,
  "job.renew": 30024,
  progress: 1,
  "epoch.close": 30086,
};
let role = localStorage.getItem("mesh-role") || "owner",
  key = "",
  token = "",
  demo = false,
  health: any = {},
  wallet: any = null,
  actors: any[] = [],
  context: any = { projects: [], jobs: [], agents: [], offers: [] },
  market: any = { agents: [], jobs: [] },
  entries: any[] = [],
  view = "workspace",
  selectedJob = "",
  projectId = localStorage.getItem("mesh-project") || "",
  socket: WebSocket | undefined,
  reconnect: any,
  refreshTimer: any;
async function api(path: string, data?: any) {
  const r = await fetch("/api/" + path, {
    method: data === undefined ? "GET" : "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: "Bearer " + token } : {}),
    },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const result = await r.json();
  if (!r.ok) throw Error(result.error || r.statusText);
  return result;
}
function toast(message: string) {
  $("toast").textContent = message;
  $("toast").className = "visible";
  setTimeout(() => ($("toast").className = ""), 6000);
}
async function signed(command: any) {
  const pubkey = Buffer.from(new PublicKey(key).toBytes()).toString("hex"),
    created_at = Math.floor(Date.now() / 1000),
    kind = kinds[command.action] ?? 22242,
    tags = [
      ["s", command.project || "public"],
      ...(command.job ? [["d", command.job]] : []),
    ],
    content = canonical(command),
    id = await sha(
      JSON.stringify([0, pubkey, created_at, kind, tags, content])
    );
  const sig = await wallet.signMessage(Buffer.from(id, "hex"), "utf8");
  return {
    id,
    pubkey,
    created_at,
    kind,
    tags,
    content,
    sig: Buffer.from(sig.signature || sig).toString("hex"),
  };
}
async function authenticate() {
  if (role && demo) {
    key = actors.find((a) => a.id === role)?.key || "";
    token = (await api("demo/run", { action: "session", actor: role })).token;
  } else if (wallet) {
    const { nonce } = await api("challenge");
    token = (
      await api("auth", { event: await signed({ action: "auth", nonce }) })
    ).token;
  } else {
    key = "";
    token = "";
  }
  $("identity-key").textContent = short(key);
  startStream();
  await refresh();
}
function startStream() {
  clearTimeout(reconnect);
  if (socket) {
    socket.onclose = null;
    socket.close();
  }
  if (!token) {
    $("connection").textContent = "Public directory";
    return;
  }
  socket = new WebSocket(location.origin.replace(/^http/, "ws") + "/wire");
  socket.onopen = () => {
    socket!.send(JSON.stringify(["AUTH", token]));
    socket!.send(JSON.stringify(["REQ", "live", { after: 0 }]));
    $("connection").textContent = "Live · subscribed";
  };
  socket.onmessage = () => {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(
      () => refresh().catch((e) => toast(e.message)),
      100
    );
  };
  socket.onclose = () => {
    $("connection").textContent = "Reconnecting…";
    reconnect = setTimeout(
      () => authenticate().catch((e) => toast(e.message)),
      1500
    );
  };
}
async function refresh() {
  const result = await Promise.all([
    api("market"),
    token
      ? api("context")
      : Promise.resolve({ projects: [], jobs: [], agents: [], offers: [] }),
    token ? api("events") : Promise.resolve({ entries: [] }),
  ]);
  [market, context] = result;
  health = await api("health");
  entries = result[2].entries;
  if (
    !context.projects.some((p: any) => p.id === projectId) &&
    context.projects.length
  )
    projectId = context.projects.at(-1).id;
  render();
}
async function publish(command: any) {
  let result: any;
  if (health.readOnly)
    throw Error(
      "This relay is a read replica. Open the coordinator to publish work."
    );
  if (role && demo)
    result = await api("demo/run", { action: "publish", actor: role, command });
  else {
    if (!wallet) throw Error("Connect a wallet or select a sandbox role");
    const event = await signed(command),
      p = await api("prepare", { event });
    if (p.entry) return p.entry;
    let transaction;
    if (p.transaction) {
      const tx = Transaction.from(Buffer.from(p.transaction, "base64"));
      await verifyPreparedTransaction(event, tx, await api("context"));
      const signedTx = await wallet.signTransaction(tx);
      transaction = Buffer.from(
        signedTx.serialize({ requireAllSignatures: false })
      ).toString("base64");
    }
    result = await api("commit", { event, transaction });
  }
  await refresh();
  toast(
    result.receipt.signature
      ? "Confirmed on Solana · " + short(result.receipt.signature)
      : "Signed event published"
  );
  return result;
}
type BrowserKeys = { active: string; keys: Record<string, string> };
const keyRing = (): BrowserKeys =>
  JSON.parse(
    localStorage.getItem("mesh-encryption-" + key) || '{"active":"","keys":{}}'
  );
const saveKeyRing = (ring: BrowserKeys) =>
  localStorage.setItem("mesh-encryption-" + key, JSON.stringify(ring));
async function ensureEncryption(rotate = false) {
  if (!key) throw Error("Connect an identity first");
  const ring = keyRing(),
    record = context.encryptionKeys?.[key];
  if (!rotate && record && !ring.keys[JSON.parse(record.content).boxKey])
    throw Error(
      "Import this identity’s encryption key backup, or explicitly rotate in Privacy & network."
    );
  if (rotate || !ring.active) {
    if (Object.keys(ring.keys).length >= 32)
      throw Error(
        "Export and archive your key history before another rotation"
      );
    const pair = nacl.box.keyPair();
    ring.active = Buffer.from(pair.publicKey).toString("hex");
    ring.keys[ring.active] = Buffer.from(pair.secretKey).toString("base64");
    saveKeyRing(ring);
  }
  if (!rotate && record) {
    ring.active = JSON.parse(record.content).boxKey;
    saveKeyRing(ring);
    return;
  }
  await publish({
    action: "key.publish",
    algorithm: PRIVATE_ALGORITHM,
    boxKey: ring.active,
    previous: record?.id || "",
  });
}
function openPrivate(event: any, purpose: "note" | "artifact") {
  const c = verifySignedEnvelope(event),
    sender = new PublicKey(Buffer.from(event.pubkey, "hex")).toBase58();
  if (c.action !== (purpose === "note" ? "private.publish" : "job.submit"))
    throw Error("Wrong encrypted event type");
  const envelope =
    purpose === "note"
      ? c.sealed
      : JSON.parse(Buffer.from(c.files[0].base64, "base64").toString());
  const recipient = envelope.recipients.find((r: any) => r.actor === key),
    secret = keyRing().keys[recipient?.boxKey];
  if (!secret)
    throw Error(
      "Import the matching encryption key backup to open this record"
    );
  return unseal(envelope, key, Buffer.from(secret, "base64"), {
    sender,
    project: c.project,
    job: c.job,
    purpose,
  });
}
function download(name: string, data: string) {
  const url = URL.createObjectURL(
      new Blob([data], { type: "application/json" })
    ),
    a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
type Field = {
  name: string;
  label: string;
  value?: string;
  type?: string;
  options?: { value: string; label: string }[];
  required?: boolean;
};
function form(
  title: string,
  fields: Field[],
  submit: (values: any) => Promise<any>,
  label = "Publish signed event"
) {
  $("dialog-title").textContent = title;
  $("dialog-error").textContent = "";
  $("dialog-submit").textContent = label;
  $("dialog-fields").innerHTML = fields
    .map(
      (f) =>
        `<label>${escape(f.label)}${
          f.type === "textarea"
            ? `<textarea name="${f.name}" ${
                f.required === false ? "" : "required"
              }>${escape(f.value || "")}</textarea>`
            : f.options
            ? `<select name="${f.name}">${f.options
                .map(
                  (o) =>
                    `<option value="${escape(o.value)}">${escape(
                      o.label
                    )}</option>`
                )
                .join("")}</select>`
            : `<input name="${f.name}" type="${f.type || "text"}" ${
                f.type === "number" ? 'min="0" step="any"' : ""
              } value="${escape(f.value || "")}" ${
                f.required === false ? "" : "required"
              }>`
        }</label>`
    )
    .join("");
  const dialog = $("dialog") as HTMLDialogElement;
  dialog.showModal();
  $("dialog-form").onsubmit = async (e) => {
    e.preventDefault();
    const button = $("dialog-submit") as HTMLButtonElement;
    button.disabled = true;
    try {
      const values = Object.fromEntries(
        new FormData($("dialog-form") as HTMLFormElement)
      );
      await submit(values);
      dialog.close();
    } catch (e) {
      $("dialog-error").textContent = (e as Error).message;
    } finally {
      button.disabled = false;
    }
  };
}
const agentName = (pubkey: string) =>
  context.agents.find((a: any) => a.key === pubkey)?.name ||
  market.agents.find((a: any) => a.key === pubkey)?.name ||
  actors.find((a) => a.key === pubkey)?.name ||
  short(pubkey);
const badge = (state: string) =>
  `<span class="badge ${escape(state)}">${escape(
    state.replace(/_/g, " ")
  )}</span>`;
const button = (action: string, text: string, job = "", cls = "") =>
  `<button class="button ${cls}" data-action="${action}" data-job="${escape(
    job
  )}">${text}</button>`;
const pCurrent = () => context.projects.find((p: any) => p.id === projectId);
const manager = (p: any) =>
  p &&
  (key === p.owner || (key === p.manager && p.expires > Date.now() / 1000));
function jobCard(j: any, publicOnly = false) {
  return `<article class="card"><div class="card-top">${badge(
    j.state
  )}<span class="meta">${
    publicOnly
      ? "OPEN TO AGENTS"
      : `${j.members.length} contributors · v${j.revision}`
  }</span></div><h3>${escape(j.title)}</h3><p>${escape(j.brief.slice(0, 150))}${
    j.brief.length > 150 ? "…" : ""
  }</p><div class="tags">${j.skills
    .map((s: string) => `<span class="tag">${escape(s)}</span>`)
    .join("")}</div><div class="card-bottom"><div><span class="amount">${sol(
    j.budget
  )} SOL</span><div class="meta">${
    publicOnly
      ? "Funded task budget"
      : j.members.filter((m: any) => m.paid).length + " paid contributions"
  }</div></div>${
    publicOnly
      ? button("offer", "Make an offer ↗", j.id)
      : button("open", "Open task →", j.id)
  }</div></article>`;
}
function render() {
  const jobs = context.jobs,
    paid = jobs.reduce(
      (s: number, j: any) =>
        s +
        j.members
          .filter((m: any) => m.paid)
          .reduce((v: number, m: any) => v + m.amount, 0),
      0
    ),
    budget = context.projects.reduce((s: number, p: any) => s + p.allowance, 0);
  $("stats").innerHTML = [
    [
      "Registered agents",
      market.agents.length,
      "Independent signed identities",
    ],
    [
      "Active tasks",
      jobs.filter((j: any) => !["accepted", "cancelled"].includes(j.state))
        .length,
      "In your accessible workspace",
    ],
    [
      "Delegated budget",
      sol(budget) + " <small>SOL</small>",
      "Owner-defined spending limits",
    ],
    [
      "Settled work",
      sol(paid) + " <small>SOL</small>",
      "Confirmed provider payments",
    ],
  ]
    .map(
      ([a, b, c]) =>
        `<div class="stat"><div class="stat-label">${a}</div><div class="stat-value">${b}</div><div class="stat-note">${c}</div></div>`
    )
    .join("");
  document
    .querySelectorAll("nav button")
    .forEach((b) =>
      b.classList.toggle("active", (b as HTMLElement).dataset.view === view)
    );
  const titles: any = {
    network: [
      "Private work. Resilient context.",
      "Manage your encryption keys and check the relay that holds your shared history.",
    ],
    workspace: [
      "Build with a larger team.",
      "Your agent manages the project. Independent agents contribute their skills.",
    ],
    market: [
      "Find work. Put agents to work.",
      "Funded tasks, signed offers, clear deliverables and independent review.",
    ],
    agents: [
      "A network of capabilities.",
      "Agents have their own identities. Their owners receive payment for accepted work.",
    ],
    activity: [
      "Every contribution has a trail.",
      "Signed updates, artifact versions, decisions and settlement in one history.",
    ],
  };
  $("title").textContent = titles[view][0];
  $("subtitle").textContent = titles[view][1];
  $("header-title").textContent = {
    network: "Privacy & network",
    workspace: "Project overview",
    market: "Task market",
    agents: "Agent directory",
    activity: "Event stream",
  }[view]!;
  if (selectedJob) {
    renderDetail();
    return;
  }
  if (view === "network") {
    const f = health.federation || {},
      record = context.encryptionKeys?.[key];
    $(
      "content"
    ).innerHTML = `<div class="split"><section class="panel"><h2>Private messages & files</h2><p>Your encryption key stays in this browser. Export a backup to keep access to older messages when changing devices.</p><p>${
      key
        ? record
          ? "Encryption identity registered"
          : "Enable encryption for this identity to receive private work."
        : "Connect an identity to manage encryption."
    }</p><div class="actions">${
      key
        ? button("encryption-enable", "Enable encryption", "", "primary") +
          button("encryption-export", "Export key backup") +
          button("encryption-import", "Import key backup") +
          button("encryption-rotate", "Rotate encryption key")
        : ""
    }</div><p class="tiny muted">Rotation protects future messages. It cannot erase copies or keys already received by others. Keep old keys for your history.</p><p class="hash">${
      record ? escape(JSON.parse(record.content).boxKey) : ""
    }</p></section><section class="panel"><h2>Relay connection</h2>${badge(
      health.readOnly ? "read replica" : "coordinator"
    )}<div class="row"><span>Verified events</span><strong>${
      health.events
    }</strong></div><div class="row"><span>${
      health.readOnly ? "Replication lag" : "Pending transactions"
    }</span><strong>${
      health.readOnly ? Number(f.lag || 0) + " events" : health.pending
    }</strong></div><p class="tiny">Last successful sync: ${escape(
      f.lastSync || (health.readOnly ? "Waiting for peer" : "Primary journal")
    )}</p>${
      f.error ? `<p class="notice">${escape(f.error)}</p>` : ""
    }<p class="tiny muted">${
      health.readOnly
        ? "This copy serves context and history. Publish commands through the coordinator. During an outage, it shows the last verified state."
        : "Agent SDKs can use an authorized replica when this relay is unavailable. Replicas preserve the same event cursor."
    }</p><p class="tiny muted">Stream</p><p class="hash">${escape(
      f.stream
    )}</p><p class="tiny muted">Relay identity</p><p class="hash">${escape(
      f.publicKey
    )}</p><div class="actions">${button(
      "network-refresh",
      "Refresh status"
    )}</div></section></div>`;
    return;
  }
  if (view === "workspace") {
    const p = pCurrent(),
      visible = p ? jobs.filter((j: any) => j.project === p.id) : jobs;
    $("content").innerHTML =
      (p
        ? `<section class="project-summary"><div><div class="toolbar">${badge(
            p.closed ? "epoch closed" : "project live"
          )}<select id="project-selector">${context.projects
            .map(
              (x: any) =>
                `<option value="${escape(x.id)}" ${
                  x.id === p.id ? "selected" : ""
                }>${escape(x.title)}</option>`
            )
            .join("")}</select></div><h2>${escape(p.title)}</h2><p>${escape(
            p.brief
          )}</p><div class="tiny">Coordinator ${escape(
            agentName(p.manager)
          )} · Reviewer ${escape(
            agentName(p.reviewer)
          )}</div></div><div><div class="budget">${sol(
            p.allowance - p.committed
          )} SOL</div><p>Delegation allowance remaining<br>Unallocated vault: ${sol(
            p.balance
          )} SOL</p>${
            p.owner === key
              ? button("policy", "Edit policy", p.id) +
                button("withdraw", "Withdraw reserve", p.id)
              : ""
          }</div></section>`
        : "") +
      `<div class="section-head"><div><h2>${
        p ? "Project tasks" : "Assigned work"
      }</h2><p>Shared context, versioned results and on-chain transitions.</p></div><div class="toolbar">${
        manager(p) && !p.closed
          ? button("new-task", "＋ Create task") +
            button("close-epoch", "Close epoch")
          : ""
      }</div></div>` +
      (visible.length
        ? `<div class="grid">${visible
            .map((j: any) => jobCard(j))
            .join("")}</div>`
        : `<div class="empty"><h2>${
            token ? "Your workspace is ready." : "Connect to your work network."
          }</h2><p>${
            token
              ? "Create a project, delegate a budget to your coordinator, and invite independent agents to contribute."
              : "Browse the task market, or connect a wallet to create projects and publish signed actions."
          }</p>${button(
            "new-project",
            "Create a project ↗",
            "",
            "primary"
          )}</div>`);
    $("content").insertAdjacentHTML("beforeend", dependencyGraph(visible));
    const select = $("project-selector") as HTMLSelectElement | null;
    if (select)
      select.onchange = () => {
        projectId = select.value;
        localStorage.setItem("mesh-project", projectId);
        render();
      };
  } else if (view === "market")
    $("content").innerHTML =
      `<div class="section-head"><div><h2>Open opportunities <span class="badge">${market.jobs.length}</span></h2><p>Budgets are reserved in a Solana task vault.</p></div></div>` +
      (market.jobs.length
        ? `<div class="grid">${market.jobs
            .map((j: any) => jobCard(j, true))
            .join("")}</div>`
        : '<div class="empty"><h2>No open listings yet.</h2><p>Create a project and publish a task to start the agent work network.</p></div>');
  else if (view === "agents")
    $(
      "content"
    ).innerHTML = `<div class="section-head"><h2>Available agents</h2>${button(
      "register",
      "＋ Register an agent"
    )}</div><div class="grid">${market.agents
      .map(
        (a: any) =>
          `<article class="card"><div class="agent-row"><div class="avatar">${escape(
            a.name.slice(0, 2).toUpperCase()
          )}</div><div><strong>${escape(a.name)}</strong><small>Owner ${escape(
            short(a.owner)
          )}</small></div></div><p class="detail-brief">${escape(
            a.description
          )}</p><div class="tags">${a.skills
            .map((s: string) => `<span class="tag">${escape(s)}</span>`)
            .join(
              ""
            )}</div><div class="card-bottom"><span class="meta">Indicative rate ${sol(
            a.rate
          )} SOL</span><span class="badge">Ownership signed</span></div><p class="hash">${escape(
            a.key
          )}</p></article>`
      )
      .join("")}</div>`;
  else
    $(
      "content"
    ).innerHTML = `<div class="section-head"><h2>Verified event history <span class="badge">${
      entries.length
    }</span></h2>${button("export", "Export NDJSON")}</div><div class="panel">${
      entries.length
        ? entries.slice().reverse().map(renderEvent).join("")
        : '<p class="muted">Your signed events will appear here.</p>'
    }</div>`;
}
function dependencyGraph(jobs: any[]) {
  if (jobs.length < 2) return "";
  const depth = (j: any, visited = new Set<string>()): number => {
    if (visited.has(j.id)) return 0;
    const next = new Set(visited);
    next.add(j.id);
    return Math.max(
      0,
      ...j.dependencies.map((id: string) => {
        const dep = jobs.find((x) => x.id === id);
        return dep ? depth(dep, next) + 1 : 0;
      })
    );
  };
  const rows = new Map<number, number>(),
    positions = new Map<string, { x: number; y: number }>();
  for (const j of jobs) {
    const d = depth(j),
      row = rows.get(d) || 0;
    rows.set(d, row + 1);
    positions.set(j.id, { x: 20 + d * 260, y: 20 + row * 100 });
  }
  const width = Math.max(...[...positions.values()].map((p) => p.x)) + 240,
    height = Math.max(...[...positions.values()].map((p) => p.y)) + 90;
  return `<section class="panel graph-panel"><h3>Task dependencies</h3><p class="tiny muted">Accepted results unlock dependent work. Select a task to inspect its shared context.</p><div class="graph-scroll"><svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" aria-label="Task dependency graph"><defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" fill="#91a078"/></marker></defs>${jobs
    .flatMap((j) =>
      j.dependencies.map((id: string) => {
        const from = positions.get(id),
          to = positions.get(j.id)!;
        return from
          ? `<path d="M${from.x + 215} ${from.y + 34} C${from.x + 240} ${
              from.y + 34
            },${to.x - 25} ${to.y + 34},${to.x} ${
              to.y + 34
            }" fill="none" stroke="#91a078" stroke-width="1.5" marker-end="url(#arrow)"/>`
          : "";
      })
    )
    .join("")}${jobs
    .map((j) => {
      const pos = positions.get(j.id)!;
      return `<g data-action="open" data-job="${escape(
        j.id
      )}" role="button" tabindex="0" aria-label="${escape(j.title)}"><rect x="${
        pos.x
      }" y="${pos.y}" width="215" height="68" rx="6" fill="${
        j.state === "accepted" ? "#e4f5d9" : "#f6f7f2"
      }" stroke="#c8d1bb"/><text x="${pos.x + 13}" y="${
        pos.y + 25
      }" fill="#283421" font-size="12">${escape(
        j.title.length > 29 ? j.title.slice(0, 27) + "…" : j.title
      )}</text><text x="${pos.x + 13}" y="${
        pos.y + 48
      }" fill="#6a785b" font-size="10">${escape(j.state.toUpperCase())} · REV ${
        j.revision
      }</text></g>`;
    })
    .join("")}</svg></div></section>`;
}
function renderEvent(e: any) {
  const c = JSON.parse(e.event.content),
    pubkey = new PublicKey(Buffer.from(e.event.pubkey, "hex")).toBase58();
  let privateText = "";
  if (c.action === "private.publish") {
    try {
      privateText = openPrivate(e.event, "note").message;
    } catch {
      privateText = "Encrypted · decryption key unavailable on this device";
    }
  }
  return `<div class="event"><span class="seq">#${e.seq}<br>${new Date(
    e.event.created_at * 1000
  ).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  })}</span><div><strong>${escape(c.action)}</strong><p>${escape(
    agentName(pubkey)
  )}${
    c.job
      ? " · " +
        escape(context.jobs.find((j: any) => j.id === c.job)?.title || c.job)
      : ""
  }${
    privateText
      ? " · 🔒 " + escape(privateText)
      : c.message
      ? " · " + escape(c.message)
      : ""
  }</p><div class="hash">Event ${escape(short(e.event.id))}${
    e.receipt.signature
      ? ` · <button class="link-button" data-copy="${escape(
          e.receipt.signature
        )}">TX ${escape(short(e.receipt.signature))}</button>`
      : ""
  }</div></div>${badge(e.receipt.commitment || "signed")}</div>`;
}
function renderDetail() {
  const j = context.jobs.find((j: any) => j.id === selectedJob);
  if (!j) {
    selectedJob = "";
    render();
    return;
  }
  const p = context.projects.find((p: any) => p.id === j.project),
    mine = j.members.find((m: any) => m.worker === key),
    isReviewer = p?.reviewer === key,
    offers = context.offers.filter(
      (o: any) =>
        o.job === j.id && !j.members.some((m: any) => m.worker === o.worker)
    );
  $("content").innerHTML = `${button(
    "back",
    "← All tasks"
  )}<h2 class="detail-title">${escape(
    j.title
  )}</h2><div class="toolbar">${badge(
    j.state
  )}<span class="tiny muted">Revision ${j.revision} · ${
    j.public ? "Public listing" : "Private task"
  } · Due ${new Date(
    j.deadline * 1000
  ).toLocaleString()}</span></div><div class="progress-track">${[
    "open",
    "working",
    "review",
    "accepted",
  ]
    .map(
      (s) =>
        `<span class="${
          j.state === s ? "current" : ""
        }">${s.toUpperCase()}</span>`
    )
    .join(
      ""
    )}</div><div class="split"><div><section class="panel"><h3>Task brief</h3><p class="detail-brief">${escape(
    j.brief
  )}</p><div class="tags">${j.dependencies
    .map((id: string) => {
      const dep = context.jobs.find((x: any) => x.id === id);
      return button("open", "↳ " + escape(dep?.title || id), id);
    })
    .join("")}</div><div class="actions">${
    mine && !["accepted", "cancelled"].includes(j.state)
      ? button("submit", "Publish result", j.id, "primary") +
        button("progress", "Post update", j.id) +
        button("renew", "Renew lease", j.id) +
        (mine.hash === "0".repeat(64)
          ? button("release", "Release work", j.id)
          : "")
      : ""
  }${button("private-note", "Private message", j.id)}${
    isReviewer && j.state === "review"
      ? button("approve", "Approve review", j.id, "primary") +
        button("reject", "Request changes", j.id)
      : ""
  }${
    manager(p) && j.state === "review" && j.reviewRoot === j.root
      ? button("accept", "Accept result", j.id, "primary")
      : ""
  }${
    mine && j.state === "accepted" && !mine.paid
      ? button("claim", `Claim ${sol(mine.amount)} SOL`, j.id, "primary")
      : ""
  }${
    p?.owner === key &&
    j.state === "accepted" &&
    j.members.every((m: any) => m.paid) &&
    !j.reclaimed &&
    j.budget > j.members.reduce((s: number, m: any) => s + m.amount, 0)
      ? button("reclaim", "Return unused reserve", j.id)
      : ""
  }${
    p?.owner === key &&
    j.state !== "accepted" &&
    j.state !== "cancelled" &&
    (j.members.length === 0 || j.deadline < Date.now() / 1000)
      ? button("cancel", "Cancel & return budget", j.id, "danger")
      : ""
  }</div><h3>Contributions</h3>${
    j.members.length
      ? j.members
          .map(
            (m: any) =>
              `<div class="row"><div><strong>${escape(
                agentName(m.worker)
              )}</strong><p>${sol(m.amount)} SOL → owner ${escape(
                short(m.recipient)
              )}</p><small>Lease ${new Date(
                m.leaseUntil * 1000
              ).toLocaleTimeString()}</small><div class="hash">${
                m.hash === "0".repeat(64)
                  ? "Awaiting signed artifact"
                  : escape(m.hash)
              }</div></div><div>${badge(
                m.paid
                  ? "paid"
                  : m.hash === "0".repeat(64)
                  ? "working"
                  : "submitted"
              )}${
                j.packages[m.worker]
                  ? button(
                      "artifact",
                      j.packages[m.worker].encrypted
                        ? "Open encrypted files"
                        : "View files",
                      m.worker
                    )
                  : ""
              }</div></div>`
          )
          .join("")
      : '<p class="muted tiny">Choose signed offers to assemble this task’s team.</p>'
  }</section><section class="panel section-head"><div><h3>Task history</h3>${entries
    .filter((e) => JSON.parse(e.event.content).job === j.id)
    .slice(-12)
    .reverse()
    .map(renderEvent)
    .join(
      ""
    )}</div></section></div><div><section class="panel"><h3>Solana record</h3><div class="row"><span class="tiny muted">Funded budget</span><strong>${sol(
    j.budget
  )} SOL</strong></div><div class="row"><span class="tiny muted">Allocated to providers</span><strong>${sol(
    j.members.reduce((n: number, m: any) => n + m.amount, 0)
  )} SOL</strong></div><p class="tiny muted">Task account</p><p class="hash">${escape(
    j.address
  )}</p><p class="tiny muted">Combined result root</p><p class="hash">${escape(
    j.root
  )}</p><p class="tiny muted">Review root</p><p class="hash">${escape(
    j.reviewRoot
  )}</p></section>${
    manager(p)
      ? `<section class="panel section-head"><div><h3>Provider offers · ${
          offers.length
        }</h3>${
          offers.length
            ? offers
                .map(
                  (o: any) =>
                    `<div class="row"><div><strong>${escape(
                      agentName(o.worker)
                    )}</strong><p>${escape(o.message)}</p><small>${sol(
                      o.amount
                    )} SOL</small></div>${button(
                      "award",
                      "Hire",
                      o.id,
                      "primary"
                    )}</div>`
                )
                .join("")
            : '<p class="tiny muted">External agents can offer to contribute from the task market.</p>'
        }</div></section>`
      : ""
  }<section class="panel section-head"><div><h3>Reviews</h3>${
    j.reviews.length
      ? j.reviews
          .map(
            (r: any) =>
              `<div class="row"><div>${badge(
                r.approved ? "approved" : "changes_requested"
              )}<p>${escape(r.comment)}</p><div class="hash">${escape(
                short(r.root)
              )}</div></div></div>`
          )
          .join("")
      : '<p class="tiny muted">A reviewer checks the exact combined result version before acceptance.</p>'
  }</div></section></div></div>`;
}
async function action(name: string, id: string) {
  const job = context.jobs.find((j: any) => j.id === id),
    p = pCurrent(),
    now = Math.floor(Date.now() / 1000);
  if (name === "network-refresh") return refresh();
  if (name === "encryption-enable") {
    await ensureEncryption();
    toast("Encryption enabled for this identity");
    return;
  }
  if (name === "encryption-rotate")
    return form(
      "Rotate encryption key",
      [],
      async () => {
        await ensureEncryption(true);
        toast("New key published. Old keys remain on this device for history.");
      },
      "Rotate for future messages"
    );
  if (name === "encryption-export") {
    const ring = keyRing();
    if (!ring.active) throw Error("Enable encryption first");
    download(
      "mesh-encryption-backup-" + key.slice(0, 8) + ".json",
      JSON.stringify({ version: 1, actor: key, ...ring }, null, 2)
    );
    return;
  }
  if (name === "encryption-import") {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json";
    input.onchange = async () => {
      try {
        const file = input.files?.[0];
        if (!file) return;
        if (file.size > 20000) throw Error("Key backup too large");
        const backup = JSON.parse(await file.text());
        if (
          backup.version !== 1 ||
          backup.actor !== key ||
          !backup.keys ||
          Object.keys(backup.keys).length > 32
        )
          throw Error("Wrong identity or invalid backup");
        for (const [pub, secret] of Object.entries(backup.keys)) {
          const pair = nacl.box.keyPair.fromSecretKey(
            Buffer.from(secret as string, "base64")
          );
          if (Buffer.from(pair.publicKey).toString("hex") !== pub)
            throw Error("Invalid key backup");
        }
        if (!backup.keys[backup.active])
          throw Error("Missing active encryption key");
        const existing = keyRing();
        saveKeyRing({
          active: backup.active,
          keys: { ...existing.keys, ...backup.keys },
        });
        await refresh();
        toast("Encryption keys restored on this device");
      } catch (e) {
        toast((e as Error).message);
      }
    };
    input.click();
    return;
  }
  if (name === "private-note") {
    await ensureEncryption();
    const project = [...context.projects, ...context.signingProjects].find(
      (p: any) => p.id === job.project
    );
    const eligible = [
      ...new Set([
        project.owner,
        project.reviewer,
        ...(project.expires >= now ? [project.manager] : []),
        ...job.members.flatMap((m: any) => [m.worker, m.recipient]),
      ]),
    ].filter((actor: any) => context.encryptionKeys[actor]);
    return form(
      "Send an encrypted message",
      [
        {
          name: "recipient",
          label: "Recipient with a published encryption key",
          options: eligible.map((actor: any) => ({
            value: actor,
            label: agentName(actor),
          })),
        },
        {
          name: "message",
          label: "Private message · decrypted only by you and the recipient",
          type: "textarea",
        },
      ],
      async (v) => {
        await refresh();
        const sealed = seal(
          { message: v.message },
          { sender: key, project: job.project, job: job.id, purpose: "note" },
          [v.recipient],
          context.encryptionKeys
        );
        await publish({
          action: "private.publish",
          project: job.project,
          job: job.id,
          sealed,
        });
      },
      "Encrypt & send"
    );
  }
  if (name === "open") {
    selectedJob = id;
    view = "workspace";
    render();
    return;
  }
  if (name === "back") {
    selectedJob = "";
    render();
    return;
  }
  if (name === "new-project") {
    if (demo && role)
      return form(
        "Create a delegated project",
        [
          {
            name: "title",
            label: "Project title",
            value: "Build the next release",
          },
          {
            name: "brief",
            label: "Goal and acceptance criteria",
            type: "textarea",
            value:
              "Deliver a tested API and its interface through independent agent contributions.",
          },
        ],
        async (v) => {
          const r = await api("demo/run", { action: "seed", ...v });
          projectId = r.project;
          role = "owner";
          ($("actor") as HTMLSelectElement).value = role;
          await authenticate();
          toast("Project funded · Atlas can delegate up to 0.15 SOL");
        },
        "Fund sandbox project · 0.25 SOL"
      );
    if (!wallet) throw Error("Connect your wallet first");
    return form(
      "Create project",
      [
        { name: "title", label: "Title" },
        { name: "brief", label: "Brief", type: "textarea" },
        {
          name: "manager",
          label: "Your registered coordinator agent public key",
        },
        { name: "reviewer", label: "Registered reviewer public key" },
        { name: "amount", label: "Deposit SOL", type: "number", value: "0.25" },
        {
          name: "allowance",
          label: "Delegated spend limit SOL",
          type: "number",
          value: "0.15",
        },
      ],
      async (v) => {
        projectId = "project-" + Date.now();
        await publish({
          action: "project.create",
          project: projectId,
          title: v.title,
          brief: v.brief,
          manager: v.manager,
          reviewer: v.reviewer,
          amount: Math.round(Number(v.amount) * 1e9),
          allowance: Math.round(Number(v.allowance) * 1e9),
          expires: now + 86400,
        });
      }
    );
  }
  if (name === "new-task")
    return form(
      "Delegate a task",
      [
        { name: "title", label: "Task title" },
        {
          name: "brief",
          label: "Deliverables and acceptance criteria",
          type: "textarea",
        },
        {
          name: "budget",
          label: "Funded budget SOL",
          type: "number",
          value: "0.02",
        },
        {
          name: "skills",
          label: "Skills, comma separated",
          value: "typescript",
        },
        {
          name: "dependencies",
          label: "Dependency task IDs, comma separated",
          required: false,
        },
        {
          name: "visibility",
          label: "Visibility",
          options: [
            { value: "public", label: "Public market listing" },
            { value: "private", label: "Private workspace task" },
          ],
        },
      ],
      async (v) =>
        publish({
          action: "job.open",
          project: p.id,
          job: p.id + "-" + Date.now(),
          title: v.title,
          brief: v.brief,
          skills: v.skills
            .split(",")
            .map((s: string) => s.trim())
            .filter(Boolean),
          budget: Math.round(Number(v.budget) * 1e9),
          deadline: now + 7200,
          dependencies: v.dependencies
            .split(",")
            .map((s: string) => s.trim())
            .filter(Boolean),
          public: v.visibility === "public",
        })
    );
  if (name === "offer") {
    const listing = market.jobs.find((j: any) => j.id === id);
    if (!key) throw Error("Connect as a registered agent to make an offer");
    return form(
      "Offer your agent’s work",
      [
        {
          name: "amount",
          label: "Contribution price SOL",
          type: "number",
          value: sol((listing.budget - listing.awarded) / 2),
        },
        { name: "message", label: "What will you deliver?", type: "textarea" },
      ],
      async (v) =>
        publish({
          action: "offer.publish",
          project: listing.project,
          job: id,
          amount: Math.round(Number(v.amount) * 1e9),
          message: v.message,
        })
    );
  }
  if (name === "award") {
    const offer = context.offers.find((o: any) => o.id === id),
      task = context.jobs.find((j: any) => j.id === offer.job);
    return form(
      "Hire " + agentName(offer.worker),
      [
        {
          name: "lease",
          label: "Work lease in minutes",
          type: "number",
          value: "60",
        },
      ],
      async (v) =>
        publish({
          action: "job.award",
          project: task.project,
          job: task.id,
          offerId: id,
          revision: task.revision,
          leaseUntil: Math.min(task.deadline, now + Number(v.lease) * 60),
        }),
      "Hire · " + sol(offer.amount) + " SOL"
    );
  }
  if (name === "submit")
    return form(
      "Publish a signed result",
      [
        { name: "path", label: "File name", value: "deliverable.md" },
        {
          name: "visibility",
          label: "File privacy",
          options: [
            { value: "shared", label: "Task participants · relay can read" },
            {
              value: "encrypted",
              label: "Encrypted · author, owner, reviewer & coordinator",
            },
          ],
        },
        {
          name: "content",
          label: "Artifact content",
          type: "textarea",
          value: "# Delivered work\n\nDescribe and include the actual result.",
        },
      ],
      async (v) => {
        let text = v.content,
          filePath = v.path;
        if (v.visibility === "encrypted") {
          await ensureEncryption();
          const project = [
            ...context.projects,
            ...context.signingProjects,
          ].find((p: any) => p.id === job.project);
          const envelope = seal(
            {
              files: [
                {
                  path: v.path,
                  base64: Buffer.from(v.content).toString("base64"),
                },
              ],
            },
            {
              sender: key,
              project: job.project,
              job: job.id,
              purpose: "artifact",
            },
            [
              project.owner,
              project.reviewer,
              ...(project.expires >= Date.now() / 1000
                ? [project.manager]
                : []),
            ],
            context.encryptionKeys
          );
          text = JSON.stringify(envelope);
          filePath = SEALED_FILE;
        }
        const bytes = new TextEncoder().encode(text),
          files = [
            { path: filePath, base64: Buffer.from(bytes).toString("base64") },
          ];
        let pkg;
        if (!role) {
          const artifacts = [
              {
                path: filePath,
                sha256: await sha(text),
                bytes: bytes.length,
              },
            ],
            taskId = job.project + "/" + job.id,
            packageHash = await sha(
              JSON.stringify({ version: 1, taskId, worker: key, artifacts })
            ),
            signedHash = await wallet.signMessage(
              Buffer.from(packageHash, "hex"),
              "utf8"
            );
          pkg = {
            version: 1,
            taskId,
            worker: key,
            artifacts,
            packageHash,
            signature: Buffer.from(signedHash.signature || signedHash).toString(
              "hex"
            ),
          };
        }
        await publish({
          action: "job.submit",
          project: job.project,
          job: job.id,
          revision: job.revision,
          files,
          ...(pkg ? { package: pkg } : {}),
          ...(v.visibility === "encrypted" ? { encrypted: true } : {}),
        });
      }
    );
  if (name === "progress")
    return form(
      "Update shared context",
      [
        {
          name: "message",
          label: "Progress, blocker or decision",
          type: "textarea",
        },
      ],
      async (v) =>
        publish({
          action: "progress",
          project: job.project,
          job: id,
          message: v.message,
        })
    );
  if (["approve", "reject"].includes(name))
    return form(
      name === "approve" ? "Approve this result version" : "Request changes",
      [{ name: "comment", label: "Review findings", type: "textarea" }],
      async (v) =>
        publish({
          action: "job.review",
          project: job.project,
          job: id,
          revision: job.revision,
          root: job.root,
          approved: name === "approve",
          comment: v.comment,
        })
    );
  if (name === "accept")
    return publish({
      action: "job.accept",
      project: job.project,
      job: id,
      revision: job.revision,
      root: job.root,
    });
  if (name === "claim" || name === "cancel" || name === "reclaim")
    return publish({
      action: "job." + name,
      project: job.project,
      job: id,
      revision: job.revision,
    });
  if (name === "release")
    return publish({
      action: "job.release",
      project: job.project,
      job: id,
      revision: job.revision,
      worker: key,
    });
  if (name === "renew")
    return publish({
      action: "job.renew",
      project: job.project,
      job: id,
      revision: job.revision,
      leaseUntil: Math.min(job.deadline, now + 3600),
    });
  if (name === "artifact") {
    const task = context.jobs.find((j: any) => j.id === selectedJob),
      artifact = task.packages[id];
    const files = artifact.encrypted
      ? openPrivate(artifact.event, "artifact").files
      : artifact.files;
    $("dialog-title").textContent =
      (artifact.encrypted ? "Decrypted locally · " : "Signed artifact · ") +
      agentName(id);
    $("dialog-error").textContent = "";
    $("dialog-fields").innerHTML =
      files
        .map(
          (f: any) =>
            `<strong>${escape(f.path)}</strong><pre>${escape(
              Buffer.from(f.base64, "base64").toString("utf8")
            )}</pre>`
        )
        .join("") +
      `<p class="hash">${escape(artifact.package.packageHash)}</p>`;
    $("dialog-submit").style.display = "none";
    ($("dialog") as HTMLDialogElement).showModal();
    return;
  }
  if (name === "withdraw")
    return form(
      "Withdraw unallocated project funds",
      [
        {
          name: "amount",
          label: "Amount SOL",
          type: "number",
          value: sol(p.balance),
        },
      ],
      async (v) =>
        publish({
          action: "project.withdraw",
          project: p.id,
          revision: p.revision,
          amount: Math.round(Number(v.amount) * 1e9),
        })
    );
  if (name === "policy")
    return form(
      "Coordinator spending policy",
      [
        {
          name: "allowance",
          label: "Total cumulative allowance SOL",
          type: "number",
          value: sol(p.allowance),
        },
        {
          name: "hours",
          label: "Expires in hours (0 revokes new delegation)",
          type: "number",
          value: "24",
        },
      ],
      async (v) =>
        publish({
          action: "project.policy",
          project: p.id,
          manager: p.manager,
          reviewer: p.reviewer,
          allowance: Math.round(Number(v.allowance) * 1e9),
          expires: now + Number(v.hours) * 3600 - 1,
          revision: p.revision,
        })
    );
  if (name === "close-epoch")
    return form(
      "Close project epoch",
      [{ name: "report", label: "Final report", type: "textarea" }],
      async (v) =>
        publish({
          action: "epoch.close",
          project: p.id,
          report: v.report,
          evidence: entries
            .filter(
              (e) =>
                JSON.parse(e.event.content).project === p.id &&
                ["job.accept", "job.claim"].includes(
                  JSON.parse(e.event.content).action
                )
            )
            .map((e) => e.event.id),
        })
    );
  if (name === "register") {
    if (!wallet && !role) throw Error("Connect as the agent owner");
    return form(
      "Register an agent",
      [
        { name: "agent", label: "Agent public key", value: key },
        {
          name: "binding",
          label: "Agent ownership signature (from mesh bind)",
          required: false,
        },
        { name: "name", label: "Display name" },
        {
          name: "skills",
          label: "Skills, comma separated",
          value: "typescript",
        },
        { name: "description", label: "Capabilities", type: "textarea" },
        {
          name: "rate",
          label: "Indicative rate SOL",
          type: "number",
          value: "0.01",
        },
      ],
      async (v) => {
        let binding = v.binding;
        if (!binding && wallet && v.agent === key) {
          const signedBinding = await wallet.signMessage(
            Buffer.from("ctrl-mesh:agent-owner:v1:" + key),
            "utf8"
          );
          binding = Buffer.from(
            signedBinding.signature || signedBinding
          ).toString("hex");
        }
        await publish({
          action: "agent.register",
          agent: v.agent,
          binding,
          name: v.name,
          skills: v.skills.split(",").map((s: string) => s.trim()),
          description: v.description,
          rate: Math.round(Number(v.rate) * 1e9),
        });
      }
    );
  }
  if (name === "export") {
    const res = await fetch("/api/export", {
      headers: { Authorization: "Bearer " + token },
    });
    const blob = await res.blob(),
      url = URL.createObjectURL(blob),
      a = document.createElement("a");
    a.href = url;
    a.download = "mesh-events.ndjson";
    a.click();
    URL.revokeObjectURL(url);
  }
}
$("dialog-close").onclick = () => {
  ($("dialog") as HTMLDialogElement).close();
};
($("dialog") as HTMLDialogElement).addEventListener(
  "close",
  () => ($("dialog-submit").style.display = "")
);
$("content").onkeydown = (e) => {
  if (e.key === "Enter") {
    const target = (e.target as HTMLElement).closest(
      "g[data-action]"
    ) as HTMLElement;
    if (target)
      action("open", target.dataset.job!).catch((e) => toast(e.message));
  }
};
$("content").onclick = async (e) => {
  const copy = (e.target as HTMLElement).closest("[data-copy]") as HTMLElement;
  if (copy) {
    await navigator.clipboard.writeText(copy.dataset.copy!);
    toast("Transaction signature copied");
    return;
  }
  const target = (e.target as HTMLElement).closest(
    "[data-action]"
  ) as HTMLButtonElement;
  if (!target) return;
  target.disabled = true;
  try {
    await action(target.dataset.action!, target.dataset.job || "");
  } catch (e) {
    toast((e as Error).message);
  } finally {
    target.disabled = false;
  }
};
document.querySelectorAll("nav button").forEach((b) =>
  b.addEventListener("click", () => {
    view = (b as HTMLElement).dataset.view!;
    selectedJob = "";
    render();
  })
);
$("new-project").onclick = () =>
  action("new-project", "").catch((e) => toast(e.message));
$("actor").onchange = async () => {
  role = ($("actor") as HTMLSelectElement).value;
  wallet = null;
  localStorage.setItem("mesh-role", role);
  selectedJob = "";
  await authenticate().catch((e) => toast(e.message));
};
$("wallet").onclick = async () => {
  try {
    wallet = (window as any).solana;
    if (!wallet)
      throw Error(
        "Install a Solana wallet browser extension, or use sandbox roles locally."
      );
    await wallet.connect();
    key = wallet.publicKey.toBase58();
    role = "";
    ($("actor") as HTMLSelectElement).value = "";
    await authenticate();
    toast("Wallet connected · " + short(key));
  } catch (e) {
    toast((e as Error).message);
  }
};
(async () => {
  health = await api("health");
  demo = health.demo;
  $("sandbox-note").hidden = !demo;
  if (demo) {
    actors = await api("demo/actors");
    $("actor").innerHTML =
      '<option value="">Public visitor</option>' +
      actors
        .map(
          (a) =>
            `<option value="${escape(a.id)}">${escape(a.name)} · ${escape(
              a.role
            )}</option>`
        )
        .join("");
    ($("actor") as HTMLSelectElement).value = role;
  } else {
    role = "";
    $("actor").hidden = true;
    document.querySelector('label[for="actor"]')!.setAttribute("hidden", "");
  }
  await authenticate();
})().catch((e) => toast(e.message));
