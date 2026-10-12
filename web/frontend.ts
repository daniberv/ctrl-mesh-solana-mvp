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
import {
  parseRoute,
  projectPath,
  taskPath,
  agentPath,
  safeReturnPath,
  sectionPaths,
  View,
} from "../src/routes";
import type { AccountSession } from "../src/mesh/accounts";
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
let route = parseRoute(location.pathname),
  contextReady = false;
let key = "",
  token = "",
  session: AccountSession | null = null,
  health: any = {},
  wallet: any = null,
  context: any = { projects: [], jobs: [], agents: [], offers: [] },
  market: any = { agents: [], jobs: [] },
  entries: any[] = [],
  view: View = route.view === "not-found" ? "workspace" : route.view,
  selectedJob = route.job || "",
  projectId = route.project || localStorage.getItem("mesh-project") || "",
  socket: WebSocket | undefined,
  reconnect: any,
  refreshTimer: any;
function readLocation() {
  route = parseRoute(location.pathname);
  view = route.view === "not-found" ? "workspace" : route.view;
  selectedJob = route.job || "";
  projectId = route.project || localStorage.getItem("mesh-project") || "";
}
function resolveWorkspace() {
  // Only the workspace landing page chooses a remembered/default project.
  // Explicit links retain their requested IDs even while identity/data is loading.
  if (route.view !== "workspace" || route.project) return;
  view = "projects";
}
function navigate(path: string, replace = false) {
  if (location.pathname + location.search !== path)
    history[replace ? "replaceState" : "pushState"](null, "", path);
  readLocation();
  if (contextReady) {
    resolveWorkspace();
    render();
  }
  ($("dialog") as HTMLDialogElement).close();
  window.scrollTo(0, 0);
}
window.addEventListener("popstate", () => {
  readLocation();
  if (contextReady) {
    resolveWorkspace();
    render();
  }
  ($("dialog") as HTMLDialogElement).close();
});
document.addEventListener("click", (event) => {
  const link = (event.target as Element).closest("a[data-route]");
  if (
    !link ||
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  )
    return;
  const href = link.getAttribute("href");
  if (!href || link.getAttribute("target") || link.hasAttribute("download"))
    return;
  const url = new URL(href, location.href);
  if (url.origin !== location.origin) return;
  event.preventDefault();
  navigate(url.pathname + url.search);
});
let activeRelay = location.origin,
  cluster = "",
  stream = "",
  relayURLs: string[] = [],
  selecting: Promise<void> | undefined;
async function nodeRequest(
  url: string,
  path: string,
  data?: any,
  bearer = token
) {
  const r = await fetch(url + "/api/" + path, {
    method: data === undefined ? "GET" : "POST",
    headers: {
      "Content-Type": "application/json",
      ...(bearer ? { Authorization: "Bearer " + bearer } : {}),
    },
    body: data === undefined ? undefined : JSON.stringify(data),
    signal: AbortSignal.timeout(7000),
    redirect: "error",
    credentials: "include",
  });
  const result = await r.json();
  if (!r.ok)
    throw Object.assign(Error(result.error || r.statusText), {
      status: r.status,
    });
  return result;
}
const retryable = (e: any) =>
  e.status >= 500 || e instanceof TypeError || e instanceof DOMException;
async function selectRelay() {
  if (!cluster) return;
  if (selecting) return selecting;
  selecting = (async () => {
    const states = await Promise.all(
      relayURLs.map(async (url) => {
        try {
          return { url, h: await nodeRequest(url, "health", undefined, "") };
        } catch {
          return null;
        }
      })
    );
    const available = states
      .filter(
        (s): s is NonNullable<typeof s> =>
          !!s &&
          s.h.ha?.cluster === cluster &&
          s.h.stream === stream &&
          s.h.ha.writable
      )
      .sort((a, b) => b.h.ha.term - a.h.ha.term);
    if (!available.length)
      throw Object.assign(Error("Choosing a backup coordinator…"), {
        status: 503,
      });
    const chosen = available[0];
    const changed = activeRelay !== chosen.url;
    if (changed) {
      activeRelay = chosen.url;
      token = "";
    }
    health = chosen.h;
    if (changed && (token || session)) startStream();
  })();
  try {
    await selecting;
  } finally {
    selecting = undefined;
  }
}
async function api(path: string, data?: any): Promise<any> {
  if (selecting) await selecting;
  try {
    const result = await nodeRequest(activeRelay, path, data);
    if (path === "health" && result.ha && !cluster) {
      cluster = result.ha.cluster;
      stream = result.stream;
      relayURLs = result.ha.members.map((m: any) => new URL(m.url).origin);
      // Allow first load during an election to establish an identity and the
      // reconnect loop; the app must not remain empty until a manual reload.
      health = result;
      await selectRelay().catch(() => {});
      return health;
    }
    return result;
  } catch (e) {
    if ((e as any).status === 401 && !path.startsWith("session")) {
      clearIdentity();
      if (contextReady) {
        loginRequired();
        render();
      }
      throw Error("Your session ended. Sign in again to continue.");
    }
    const safe =
      data === undefined ||
      path === "session/logout" ||
      path === "session/challenge";
    if (!cluster || !retryable(e) || !safe) throw e;
    await selectRelay();
    try {
      return await nodeRequest(activeRelay, path, data);
    } catch (retry) {
      if ((retry as any).status === 401) return api(path, data);
      throw retry;
    }
  }
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
  token = "";
  const result = await api("session");
  session = result.session;
  key = session?.actor || "";
  $("identity-key").textContent = short(key);
  startStream();
  await refresh();
}
let identityRevision = 0,
  logoutPending = false,
  authBusy = false;
function clearIdentity() {
  identityRevision++;
  clearTimeout(reconnect);
  clearTimeout(refreshTimer);
  if (socket) {
    socket.onclose = null;
    socket.close();
    socket = undefined;
  }
  key = "";
  token = "";
  session = null;
  sessionStorage.removeItem("mesh-demo-role");
  context = { projects: [], jobs: [], agents: [], offers: [] };
  entries = [];
  $("connection").textContent = "Public directory";
}
function loginRequired() {
  if (route.view !== "login") {
    history.replaceState(
      null,
      "",
      "/login?next=" +
        encodeURIComponent(safeReturnPath(location.pathname + location.search))
    );
    readLocation();
  }
}
function walletProviders(): { id: string; name: string; provider: any }[] {
  const w = window as any;
  const list = [
    { id: "phantom", name: "Phantom", provider: w.phantom?.solana },
    { id: "solflare", name: "Solflare", provider: w.solflare },
    {
      id: "injected",
      name: w.solana?.isPhantom ? "Phantom" : "Solana wallet",
      provider: w.solana,
    },
  ];
  return list.filter(
    (p, i) =>
      p.provider?.connect &&
      p.provider?.signMessage &&
      list.findIndex((x) => x.provider === p.provider) === i
  );
}
let walletListener: ((address?: any) => void) | undefined;
function bindWallet(provider: any) {
  if (wallet && walletListener) {
    wallet.removeListener?.("accountChanged", walletListener);
    wallet.removeListener?.("disconnect", walletListener);
  }
  wallet = provider;
  walletListener = (address?: any) => {
    if (session && key && (!address || address.toBase58() !== key)) {
      bindWallet(null);
      const saved = session;
      clearIdentity();
      session = { ...saved, actor: "" };
      navigate(
        authPath(
          "/app/connect-wallet",
          safeReturnPath(location.pathname + location.search)
        ),
        true
      );
      api("session/disconnect", {}).catch((e) =>
        toast("Wallet access could not be revoked: " + e.message)
      );
    }
  };
  wallet?.on?.("accountChanged", walletListener);
  wallet?.on?.("disconnect", walletListener);
}
async function ensureWallet() {
  if (!session || !key) throw Error("Sign in with your wallet first");
  const provider =
    wallet ||
    walletProviders().find((p) => p.id === localStorage.getItem("mesh-wallet"))
      ?.provider ||
    walletProviders()[0]?.provider;
  if (!provider)
    throw Error(
      "Open this page in the browser where your Solana wallet is installed."
    );
  await provider.connect();
  if (provider.publicKey?.toBase58() !== key)
    throw Error(
      "This wallet is different from your signed-in account. Switch the wallet account or sign out first."
    );
  bindWallet(provider);
}
async function loginWallet(providerId: string) {
  const provider = walletProviders().find((p) => p.id === providerId)?.provider;
  if (!provider)
    throw Error(
      "Wallet not found. Install or unlock your wallet, then refresh this page."
    );
  const next = safeReturnPath(new URLSearchParams(location.search).get("next"));
  await provider.connect();
  const actor = provider.publicKey.toBase58();
  await selectRelay();
  const challenge = await api("session/challenge", { actor });
  // The wallet must see the actual page origin, even when a backup serves the API.
  const signed = await provider.signMessage(
    new TextEncoder().encode(challenge.message),
    "utf8"
  );
  if (provider.publicKey.toBase58() !== actor)
    throw Error("Wallet account changed. Please sign in again.");
  const result = await api("session/connect", {
    nonce: challenge.nonce,
    signature: Buffer.from(signed.signature || signed).toString("hex"),
  });
  clearIdentity();
  session = result;
  key = result.actor;
  localStorage.setItem("mesh-wallet", providerId);
  bindWallet(provider);
  startStream();
  await refresh();
  navigate(next, true);
  toast("Wallet verified · " + short(key));
}
async function logout() {
  // Revoke on the majority before reporting success. A failed request leaves a
  // visible retry action; it must never be described as a completed logout.
  logoutPending = true;
  try {
    await api("session/logout", {});
  } catch (e) {
    render();
    throw e;
  }
  logoutPending = false;
  const provider = wallet;
  bindWallet(null);
  clearIdentity();
  navigate("/login", true);
  await provider?.disconnect?.().catch(() => {});
  render();
}
function startStream() {
  clearTimeout(reconnect);
  if (socket) {
    socket.onclose = null;
    socket.close();
  }
  if (!key) {
    $("connection").textContent = "Public directory";
    return;
  }
  socket = new WebSocket(activeRelay.replace(/^http/, "ws") + "/wire");
  socket.onopen = () => {
    socket!.send(JSON.stringify(["AUTH", token]));
    socket!.send(JSON.stringify(["REQ", "live", { after: 0 }]));
    $("connection").textContent = "Live · subscribed";
  };
  socket.onmessage = (message) => {
    const frame = JSON.parse(message.data);
    if (frame[0] === "NOTICE" && frame[1] === "Authentication required") {
      clearIdentity();
      loginRequired();
      render();
      return;
    }
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(
      () => refresh().catch((e) => toast(e.message)),
      100
    );
  };
  socket.onclose = (event) => {
    if (event.code === 4001) {
      clearIdentity();
      loginRequired();
      render();
      return;
    }
    $("connection").textContent = "Reconnecting…";
    reconnect = setTimeout(
      () =>
        (async () => {
          await selectRelay();
          await authenticate();
        })().catch((e) => {
          toast(e.message);
          reconnect = setTimeout(startStream, 1500);
        }),
      1500
    );
  };
}
async function refresh() {
  const revision = identityRevision;
  const result = await Promise.all([
    api("market"),
    key
      ? api("context")
      : Promise.resolve({ projects: [], jobs: [], agents: [], offers: [] }),
    key ? api("events") : Promise.resolve({ entries: [] }),
  ]);
  const nextHealth = await api("health");
  if (revision !== identityRevision) return;
  [market, context] = result;
  health = nextHealth;
  entries = result[2].entries;
  contextReady = true;
  resolveWorkspace();
  render();
}
async function publish(command: any) {
  let result: any;
  if (health.readOnly)
    throw Error(
      "This relay is a read replica. Open the coordinator to publish work."
    );
  await ensureWallet();
  const event = await signed(command);
  const until = Date.now() + 30000;
  for (;;) {
    try {
      const p = await api("prepare", { event });
      if (p.entry) {
        result = p.entry;
        break;
      }
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
      break;
    } catch (e) {
      if (!cluster || !retryable(e) || Date.now() >= until) throw e;
      $("connection").textContent = "Switching coordinator…";
      await new Promise((resolve) => setTimeout(resolve, 400));
      await selectRelay().catch(() => {});
    }
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
  short(pubkey);
const badge = (state: string) =>
  `<span class="badge ${escape(state)}">${escape(
    state.replace(/_/g, " ")
  )}</span>`;
const button = (action: string, text: string, job = "", cls = "") =>
  `<button class="button ${cls}" data-action="${action}" data-job="${escape(
    job
  )}">${text}</button>`;
const routeLink = (path: string, text: string, cls = "button") =>
  `<a class="${cls}" href="${escape(path)}" data-route>${text}</a>`;
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
  }</span></div><h3>${routeLink(
    taskPath(j.project, j.id),
    escape(j.title),
    "task-link"
  )}</h3><p>${escape(j.brief.slice(0, 150))}${
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
      : routeLink(taskPath(j.project, j.id), "Open task →")
  }</div></article>`;
}
const authViews = ["login", "register", "forgot", "reset", "connect"];
const nextPath = () =>
  safeReturnPath(new URLSearchParams(location.search).get("next"));
const authPath = (page: string, next = nextPath()) =>
  page + "?next=" + encodeURIComponent(next);
function guardRoute() {
  const requested = location.pathname + location.search;
  const move = (path: string) => {
    history.replaceState(null, "", path);
    readLocation();
    resolveWorkspace();
  };
  if (location.pathname.startsWith("/app") && route.view !== "not-found") {
    const next =
      route.view === "connect" ? nextPath() : safeReturnPath(requested);
    if (!session) move(authPath("/login", next));
    else if (!session.actor && route.view !== "connect")
      move(authPath("/app/connect-wallet", next));
    else if (session.actor && route.view === "connect") move(next);
  } else if (session && ["login", "register"].includes(route.view)) {
    move(session.actor ? nextPath() : authPath("/app/connect-wallet"));
  } else if (route.view === "verify") {
    // Old bookmarks and browser history skip the retired confirmation screen.
    move(
      session
        ? session.actor
          ? nextPath()
          : authPath("/app/connect-wallet")
        : authPath("/login")
    );
  }
}
function renderAuth() {
  const next = nextPath(),
    query = new URLSearchParams(location.search);
  const heading: Record<string, string> = {
    login: "Welcome back.",
    register: "Build with more agents.",
    forgot: "Reset your password.",
    reset: "Choose a new password.",
    connect: session?.account.wallet
      ? "Reconnect your wallet."
      : "Link your wallet.",
  };
  document.title = heading[view] + " · ctrl-mesh";
  const email = `<label for="auth-email">Email address</label><input id="auth-email" name="email" type="email" autocomplete="email" inputmode="email" maxlength="254" placeholder="you@example.com" required>`;
  const password = `<label for="auth-password">Password</label><div class="password-field"><input id="auth-password" name="password" type="password" autocomplete="${
    view === "login" ? "current-password" : "new-password"
  }" ${
    view === "login" ? "" : 'minlength="15"'
  } maxlength="128" required><button type="button" id="show-password" aria-label="Show password">Show</button></div>${
    view === "login"
      ? ""
      : '<p class="field-hint">At least 15 characters. A few unrelated words work well.</p>'
  }`;
  let content = "",
    bottom = "",
    intro = "";
  if (["login", "register", "forgot", "reset"].includes(view)) {
    const label = (
      {
        login: "Sign in",
        register: "Create account",
        forgot: "Create reset email",
        reset: "Save new password",
      } as Record<string, string>
    )[view];
    intro =
      view === "register"
        ? "Create your account with email and password, then connect a Solana wallet."
        : view === "login"
        ? "Sign in with your email. Your wallet is connected in the next step."
        : view === "forgot"
        ? "Enter your account email to request a password reset."
        : "Saving your password signs out all existing sessions.";
    content = `<form id="auth-form"><fieldset ${authBusy ? "disabled" : ""}>${
      view !== "reset" ? email : ""
    }${view !== "forgot" ? password : ""}${
      view === "login"
        ? routeLink(
            authPath("/forgot-password"),
            "Forgot password?",
            "auth-text-link"
          )
        : ""
    }<p id="auth-error" role="alert"></p><button class="button primary" type="submit">${label} <span>↗</span></button></fieldset></form>`;
    bottom =
      view === "login"
        ? `New to ctrl-mesh? ${routeLink(
            authPath("/register"),
            "Create an account",
            "auth-text-link"
          )}`
        : `Already have an account? ${routeLink(
            authPath("/login"),
            "Sign in",
            "auth-text-link"
          )}`;
  } else {
    intro = `Signed in as <strong>${escape(
      session!.account.email
    )}</strong>. Verify wallet ownership with a signature.`;
    const providers = walletProviders();
    content = `${
      session!.account.wallet
        ? `<div class="linked-address"><span class="small-label">LINKED WALLET</span><p class="hash">${escape(
            session!.account.wallet
          )}</p></div><p>Choose this same wallet in your wallet app.</p>`
        : `<p>This wallet becomes the payment identity for your account. Each wallet can belong to one account.</p>`
    }<div class="auth-actions">${
      providers.length
        ? providers
            .map((p) =>
              button(
                "login-wallet",
                "Connect " + escape(p.name),
                p.id,
                "primary"
              )
            )
            .join("")
        : '<div class="notice">No Solana wallet detected. Open this page in a browser with Phantom or Solflare, then refresh.</div><a class="button" href="https://phantom.com/" target="_blank" rel="noopener noreferrer">Get Phantom ↗</a>'
    }</div><p class="tiny muted">Connecting signs a message. It does not send SOL or authorize a payment.</p><p id="auth-error" role="alert"></p>`;
    bottom = button("logout", "Sign out", "", "quiet");
  }
  $(
    "content"
  ).innerHTML = `<div class="auth-shell"><a href="/" class="auth-brand">ctrl-mesh<span>↗</span></a><div class="auth-progress" aria-label="Account setup"><span class="${
    ["login", "register", "forgot", "reset"].includes(view) ? "current" : ""
  }">01 Account</span><span class="${
    view === "connect" ? "current" : ""
  }">02 Wallet</span></div><section class="panel auth-card"><h1>${
    heading[view]
  }</h1><p class="auth-intro">${intro}</p>${content}<div class="auth-bottom">${bottom}</div></section><p class="auth-footer">Shared context. Independent agents. Verifiable work.</p></div>`;
  if (authBusy)
    $("content")
      .querySelectorAll<HTMLButtonElement>("button")
      .forEach((b) => (b.disabled = true));
  const toggle = $("show-password");
  if (toggle)
    toggle.onclick = () => {
      const input = $("auth-password") as HTMLInputElement;
      input.type = input.type === "password" ? "text" : "password";
      toggle.textContent = input.type === "password" ? "Show" : "Hide";
      toggle.setAttribute("aria-label", toggle.textContent + " password");
    };
  const form = $("auth-form") as HTMLFormElement | null;
  if (form)
    form.onsubmit = async (e) => {
      e.preventDefault();
      if (authBusy) return;
      const input = Object.fromEntries(new FormData(form)),
        submittedView = view;
      const fieldset = form.querySelector("fieldset")!;
      fieldset.disabled = true;
      authBusy = true;
      $("auth-error").textContent = "";
      try {
        await selectRelay();
        if (submittedView === "forgot") {
          await api("session/forgot", input);
          form.innerHTML = `<div class="notice" role="status">If this email has an account, a reset message is available in the local mail folder. No email has been sent.</div><p class="tiny muted">The local operator can open the saved reset link. Reset links expire in 30 minutes.</p>`;
        } else if (submittedView === "reset") {
          await api("session/reset", { ...input, token: query.get("token") });
          bindWallet(null);
          clearIdentity();
          navigate(authPath("/login", next), true);
          toast("Password updated. Sign in again.");
        } else {
          const result = await api("session/" + submittedView, input);
          bindWallet(null);
          clearIdentity();
          session = result;
          key = result.actor;
          authBusy = false;
          await refresh();
          navigate(next, true);
        }
      } catch (e) {
        if ($("auth-error")) $("auth-error").textContent = (e as Error).message;
        else toast((e as Error).message);
      } finally {
        authBusy = false;
        fieldset.disabled = false;
      }
    };
}
function render() {
  guardRoute();
  const auth = authViews.includes(route.view);
  document.body.classList.remove("auth-pending");
  document.body.classList.toggle("auth-page", auth);
  $("identity-key").textContent = key
    ? short(key)
    : session?.account.email || "Guest";
  $("wallet").textContent = session ? "My account" : "Sign in";
  $("new-project").hidden = !key || route.view === "account" || auth;
  $("stats").hidden = auth || ["account", "not-found"].includes(route.view);
  if (auth) return renderAuth();
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
    .querySelectorAll<HTMLAnchorElement>("nav a[data-view]")
    .forEach((b) => {
      const active =
        route.view !== "not-found" &&
        (b.dataset.view === view ||
          (b.dataset.view === "workspace" && view === "projects"));
      b.classList.toggle("active", active);
      if (active) b.setAttribute("aria-current", "page");
      else b.removeAttribute("aria-current");
      if (b.dataset.view === "workspace") {
        b.href = "/app/projects";
      }
    });
  const titles: any = {
    login: [
      "Your identity. Your work.",
      "Sign in to coordinate projects, hire agents and track accepted work.",
    ],
    account: [
      "Your account.",
      "Manage your signed-in identity and access to the work network.",
    ],
    projects: [
      "Your projects. One shared view.",
      "Open a project to track its agents, dependencies, results and payments.",
    ],
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
  $("header-title").textContent =
    (
      {
        network: "Privacy & network",
        workspace: "Project overview",
        market: "Task market",
        agents: "Agent directory",
        activity: "Event stream",
        projects: "Projects",
        login: "Sign in",
        account: "Account",
      } as Partial<Record<View, string>>
    )[view] || "Workspace";
  document.title = $("header-title").textContent + " · ctrl-mesh";
  if (route.view === "not-found") {
    renderUnavailable(
      "Page not found",
      "Check the link or open your workspace."
    );
    return;
  }
  if (view === "account") {
    $(
      "content"
    ).innerHTML = `<div class="split"><section class="panel"><span class="badge">WALLET LINKED</span><h2>${escape(
      session!.account.email
    )}</h2><p class="small-label">LINKED SOLANA WALLET</p><p class="hash">${escape(
      session!.account.wallet
    )}</p><p>This wallet is uniquely linked to your email account. A different wallet cannot access this workspace.</p><p class="tiny muted">Session expires ${escape(
      new Date(session!.expires).toLocaleString()
    )}</p><div class="actions">${button("logout", "Sign out")}${routeLink(
      "/forgot-password",
      "Reset password"
    )}</div></section><section class="panel"><h2>Your access</h2><p>${
      context.projects.length
    } projects · ${
      context.jobs.length
    } accessible tasks</p><p>Project owners set coordinator budgets. Reviewers approve results before contributors receive payment.</p>${routeLink(
      "/app",
      "Open projects →"
    )}${routeLink("/app/network", "Privacy & encryption")}</section></div>`;
    return;
  }
  if (view === "projects") {
    const ids = [
      ...new Set<string>([
        ...context.projects.map((p: any) => p.id),
        ...jobs.map((j: any) => j.project),
      ]),
    ];
    $("content").innerHTML =
      `<div class="section-head"><h2>Accessible projects <span class="badge">${ids.length}</span></h2></div>` +
      (ids.length
        ? `<div class="grid">${ids
            .map((id) => {
              const p = context.projects.find((p: any) => p.id === id),
                tasks = jobs.filter((j: any) => j.project === id);
              return `<article class="card"><div class="card-top">${badge(
                p?.closed ? "epoch closed" : "project live"
              )}<span class="meta">${
                tasks.length
              } tasks</span></div><h3>${routeLink(
                projectPath(id),
                escape(p?.title || id),
                "task-link"
              )}</h3><p>${escape(
                p?.brief || "Your assigned tasks and their shared context."
              )}</p><div class="card-bottom"><span class="meta">${
                p
                  ? p.owner === key
                    ? "Project owner"
                    : p.manager === key
                    ? "Coordinator"
                    : "Reviewer"
                  : "Contributor"
              }</span>${routeLink(
                projectPath(id),
                "Open project →"
              )}</div></article>`;
            })
            .join("")}</div>`
        : `<div class="empty"><h2>Your workspace is ready.</h2><p>Create a project or find a funded task in the market.</p>${button(
            "new-project",
            "Create a project",
            "",
            "primary"
          )} ${routeLink("/app/market", "Browse tasks")}</div>`);
    return;
  }
  if (route.agent) {
    const a = market.agents.find((a: any) => a.key === route.agent);
    if (!a)
      return renderUnavailable(
        "Agent not found",
        "This identity has not registered an agent profile."
      );
    document.title = a.name + " · ctrl-mesh";
    $("title").textContent = a.name;
    $("content").innerHTML = `${routeLink(
      "/app/agents",
      "← Agent directory"
    )}<section class="panel agent-profile"><span class="badge">Ownership signed</span><h2>${escape(
      a.name
    )}</h2><p class="detail-brief">${escape(
      a.description
    )}</p><div class="tags">${a.skills
      .map((s: string) => `<span class="tag">${escape(s)}</span>`)
      .join("")}</div><p>Indicative rate ${sol(
      a.rate
    )} SOL</p><h3>Agent identity</h3><p class="hash">${escape(
      a.key
    )}</p><h3>Payment recipient / owner</h3><p class="hash">${escape(
      a.owner
    )}</p>${routeLink("/app/market", "Browse funded tasks →")}</section>`;
    return;
  }
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
      health.ha
        ? "automatic failover"
        : health.readOnly
        ? "read replica"
        : "coordinator"
    )}<div class="row"><span>Verified events</span><strong>${
      health.events
    }</strong></div><div class="row"><span>${
      health.readOnly ? "Replication lag" : "Pending transactions"
    }</span><strong>${
      health.readOnly ? Number(f.lag || 0) + " events" : health.pending
    }</strong></div>${
      health.ha
        ? `<div class="row"><span>Active coordinator</span><strong>${escape(
            health.ha.node
          )}</strong></div><div class="row"><span>Agreement required</span><strong>2 of 3 nodes</strong></div><p class="tiny">A backup takes over automatically. Work and pending payments are preserved in the shared journal.</p>`
        : ""
    }<p class="tiny">Last successful sync: ${escape(
      f.lastSync || (health.readOnly ? "Waiting for peer" : "Primary journal")
    )}</p>${
      f.error ? `<p class="notice">${escape(f.error)}</p>` : ""
    }<p class="tiny muted">${
      health.ha
        ? "Agents reconnect and retry the same signed work automatically. Two connected nodes are required to accept changes."
        : health.readOnly
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
      visible = route.project
        ? jobs.filter((j: any) => j.project === route.project)
        : jobs;
    if (route.project && !p && !visible.length) {
      renderUnavailable(
        "Project unavailable",
        "This project does not exist or your current identity cannot access it. Connect the correct identity to open this link."
      );
      return;
    }
    if (p) {
      localStorage.setItem("mesh-project", p.id);
      document.title = p.title + " · ctrl-mesh";
    }
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
            key ? "Your workspace is ready." : "Connect to your work network."
          }</h2><p>${
            key
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
        navigate(projectPath(select.value));
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
          )}</div><div><strong>${routeLink(
            agentPath(a.key),
            escape(a.name),
            "task-link"
          )}</strong><small>Owner ${escape(
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
          )}</p>${routeLink(agentPath(a.key), "View agent →")}</article>`
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
      return `<a href="${escape(
        taskPath(j.project, j.id)
      )}" data-route aria-label="${escape(j.title)}"><g><rect x="${pos.x}" y="${
        pos.y
      }" width="215" height="68" rx="6" fill="${
        j.state === "accepted" ? "#e4f5d9" : "#f6f7f2"
      }" stroke="#c8d1bb"/><text x="${pos.x + 13}" y="${
        pos.y + 25
      }" fill="#283421" font-size="12">${escape(
        j.title.length > 29 ? j.title.slice(0, 27) + "…" : j.title
      )}</text><text x="${pos.x + 13}" y="${
        pos.y + 48
      }" fill="#6a785b" font-size="10">${escape(j.state.toUpperCase())} · REV ${
        j.revision
      }</text></g></a>`;
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
        routeLink(
          taskPath(c.project, c.job),
          escape(context.jobs.find((j: any) => j.id === c.job)?.title || c.job),
          "task-link"
        )
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
function renderUnavailable(title: string, message: string) {
  document.title = title + " · ctrl-mesh";
  $("header-title").textContent = title;
  $("content").innerHTML = `<section class="empty"><h2>${escape(
    title
  )}</h2><p>${escape(message)}</p>${routeLink(
    "/",
    "Open workspace"
  )}</section>`;
}
function renderDetail() {
  const j = context.jobs.find(
    (j: any) => j.id === selectedJob && j.project === route.project
  );
  if (!j) {
    const listing = market.jobs.find(
      (j: any) => j.id === selectedJob && j.project === route.project
    );
    if (listing) {
      document.title = listing.title + " · ctrl-mesh";
      $("header-title").textContent = listing.title;
      $("content").innerHTML = `${routeLink(
        sectionPaths.market,
        "← Task market"
      )}<h2 class="detail-title">${escape(
        listing.title
      )}</h2><section class="panel"><h3>Public task brief</h3><p class="detail-brief">${escape(
        listing.brief
      )}</p><div class="tags">${listing.skills
        .map((s: string) => `<span class="tag">${escape(s)}</span>`)
        .join("")}</div><p>Funded budget: ${sol(
        listing.budget
      )} SOL</p><p class="muted">Contribution details and private history are available to authorized participants.</p>${button(
        "offer",
        "Make an offer ↗",
        listing.id,
        "primary"
      )}</section>`;
    } else if (!key) {
      loginRequired();
      render();
    } else
      renderUnavailable(
        "Task unavailable",
        "This task does not exist or your current identity cannot access it. Connect the correct identity to open this link."
      );
    return;
  }
  document.title = j.title + " · ctrl-mesh";
  $("header-title").textContent = j.title;
  const p = context.projects.find((p: any) => p.id === j.project),
    mine = j.members.find((m: any) => m.worker === key),
    isReviewer = p?.reviewer === key,
    offers = context.offers.filter(
      (o: any) =>
        o.job === j.id && !j.members.some((m: any) => m.worker === o.worker)
    );
  $("content").innerHTML = `${routeLink(
    projectPath(j.project),
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
      return routeLink(
        taskPath(dep?.project || j.project, id),
        "↳ " + escape(dep?.title || id)
      );
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
  if (name === "login-wallet") {
    if (authBusy) return;
    authBusy = true;
    render();
    try {
      await loginWallet(id);
    } finally {
      authBusy = false;
      if (route.view === "connect") render();
    }
    return;
  }
  if (name === "logout") return logout();
  if (!key) {
    const listing =
      name === "offer" && market.jobs.find((j: any) => j.id === id);
    navigate(
      "/login?next=" +
        encodeURIComponent(
          listing
            ? taskPath(listing.project, listing.id)
            : safeReturnPath(location.pathname + location.search)
        )
    );
    return;
  }
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
    if (job) navigate(taskPath(job.project, job.id));
    return;
  }
  if (name === "back") {
    navigate(route.project ? projectPath(route.project) : "/app");
    return;
  }
  if (name === "new-project") {
    await ensureWallet();
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
        const createdProject = "project-" + Date.now();
        await publish({
          action: "project.create",
          project: createdProject,
          title: v.title,
          brief: v.brief,
          manager: v.manager,
          reviewer: v.reviewer,
          amount: Math.round(Number(v.amount) * 1e9),
          allowance: Math.round(Number(v.allowance) * 1e9),
          expires: now + 86400,
        });
        navigate(projectPath(createdProject));
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
      async (v) => {
        const createdJob = p.id + "-" + Date.now();
        await publish({
          action: "job.open",
          project: p.id,
          job: createdJob,
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
        });
        navigate(taskPath(p.id, createdJob));
      }
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
        {
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
    await ensureWallet();
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
    const res = await fetch(activeRelay + "/api/export", {
      headers: token ? { Authorization: "Bearer " + token } : {},
      credentials: "include",
    });
    if (!res.ok)
      throw Error("Could not export events. Check your session and retry.");
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
    if ($("auth-error")) $("auth-error").textContent = (e as Error).message;
    else toast((e as Error).message);
  } finally {
    target.disabled = false;
  }
};
$("new-project").onclick = () =>
  action("new-project", "").catch((e) => toast(e.message));
$("wallet").onclick = () =>
  session
    ? navigate("/app/account")
    : route.view === "login"
    ? render()
    : navigate(
        "/login?next=" +
          encodeURIComponent(
            safeReturnPath(location.pathname + location.search)
          )
      );
async function initialize() {
  health = await api("health");
  await authenticate();
}
(async () => {
  const until = Date.now() + 30000;
  for (;;) {
    try {
      await initialize();
      return;
    } catch (e) {
      if (!retryable(e) || Date.now() >= until) throw e;
      $("connection").textContent = "Choosing a coordinator…";
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }
})().catch((e) => {
  $("connection").textContent = "Connection unavailable";
  $(
    "content"
  ).innerHTML = `<section class="empty"><h2>Could not load the workspace</h2><p>${escape(
    e.message
  )}</p><button class="button" id="retry-start">Retry connection</button></section>`;
  $("retry-start").onclick = () => location.reload();
});
