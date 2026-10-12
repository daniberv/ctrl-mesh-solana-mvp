import { strict as assert } from "assert";
import { mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Keypair } from "@solana/web3.js";
import nacl from "tweetnacl";
import { WebSocket } from "ws";
import { Engine } from "../src/mesh/engine";
import { Chain } from "../src/mesh/chain";
import { Store } from "../src/mesh/store";
import { createRelay } from "../src/mesh/relay";
import { MeshClient } from "../src/mesh/sdk";
import { signEvent } from "../src/mesh/events";
import {
  parseRoute,
  projectPath,
  taskPath,
  safeReturnPath,
} from "../src/routes";

describe("email accounts, wallet binding and navigation", function () {
  this.timeout(20000);
  const url = "http://127.0.0.1:4221",
    actor = Keypair.generate(),
    stranger = Keypair.generate();
  const directory = mkdtempSync(join(tmpdir(), "mesh-auth-")),
    file = join(directory, "events.sqlite"),
    mail = join(directory, "mail");
  const email = "builder@example.test",
    password = "a long unique passphrase for tests";
  let store: Store,
    engine: Engine,
    relay: ReturnType<typeof createRelay>,
    cookie = "",
    accountId = "";
  async function request(
    path: string,
    input?: any,
    saved = cookie,
    origin = url
  ) {
    const r = await fetch(url + path, {
      method: input === undefined ? "GET" : "POST",
      redirect: "manual",
      headers: {
        Connection: "close",
        Origin: origin,
        Cookie: saved,
        "Content-Type": "application/json",
        Accept: "text/html,application/json",
      },
      body: input === undefined ? undefined : JSON.stringify(input),
    });
    if (r.headers.getSetCookie()[0])
      cookie = r.headers.getSetCookie()[0].split(";")[0];
    return r;
  }
  const post = (name: string, input: any = {}, saved = cookie) =>
    request("/api/session/" + name, input, saved);
  const signature = (message: string, key = actor) =>
    Buffer.from(
      nacl.sign.detached(Buffer.from(message), key.secretKey)
    ).toString("hex");
  async function challenge(key = actor, saved = cookie) {
    const r = await post(
      "challenge",
      { actor: key.publicKey.toBase58() },
      saved
    );
    assert.equal(r.status, 200);
    return r.json();
  }
  async function connect(key = actor, saved = cookie) {
    const c = await challenge(key, saved),
      r = await post(
        "connect",
        { nonce: c.nonce, signature: signature(c.message, key) },
        saved
      );
    assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));
    return r;
  }
  async function login() {
    const r = await post("login", { email, password });
    assert.equal(r.status, 200);
    return r;
  }
  async function start() {
    store = new Store(file);
    engine = new Engine(store, {} as Chain);
    relay = createRelay(engine, { port: 4221, localMailDir: mail });
    await relay.start();
  }
  async function stop() {
    relay.server.closeAllConnections();
    await relay.stop();
    store.close();
  }
  before(start);
  after(stop);

  it("separates the public landing, account entry and all /app deep routes", async () => {
    const landing = await (await request("/")).text();
    assert.match(landing, /Build beyond one agent/);
    assert(!landing.includes('src="/app.js"'));
    for (const path of [
      "/app",
      "/app/projects",
      "/app/market",
      "/app/agents",
      "/app/activity",
      "/app/network",
      "/app/account",
      "/app/connect-wallet",
      "/login",
      "/register",
      "/forgot-password",
      "/verify-email",
      "/reset-password",
      projectPath("project /?"),
      taskPath("..", "a/b"),
      "/app/agents/" + actor.publicKey.toBase58(),
    ]) {
      const r = await request(path);
      assert.equal(r.status, 200, path);
      assert.match(r.headers.get("content-type")!, /text\/html/);
    }
    const old = await request("/projects/p/tasks/t?tab=results");
    assert.equal(old.status, 308);
    assert.equal(
      old.headers.get("location"),
      "/app/projects/p/tasks/t?tab=results"
    );
    assert.equal((await request("/missing")).status, 404);
    for (const id of [".", "..", "~foo", "a/b", "hello ?#%", "проект"]) {
      assert.equal(
        parseRoute(new URL(taskPath(id, id), url).pathname).project,
        id
      );
      assert.equal(parseRoute(new URL(taskPath(id, id), url).pathname).job, id);
    }
    for (const path of [
      "https://evil.test",
      "//evil.test",
      "/\\evil.test",
      "/login?next=//evil",
      "/app-nope",
      "/app/connect-wallet",
      "/missing",
    ])
      assert.equal(safeReturnPath(path), "/app");
    assert.equal(
      safeReturnPath("/app/projects/p/tasks/t"),
      "/app/projects/p/tasks/t"
    );
    assert.equal(parseRoute("/app/projects/%zz").view, "not-found");
  });
  it("denies anonymous private data while retaining independent agent authentication", async () => {
    assert.equal((await request("/api/context", undefined, "")).status, 401);
    assert.equal(
      (await (await request("/api/session", undefined, "")).json()).session,
      null
    );
    assert.equal(
      (await request("/api/session/local-email", undefined, "")).status,
      401
    );
    const client = new MeshClient(url, actor);
    assert.ok(await client.authenticate());
    assert.deepEqual((await client.context()).projects, []);
  });
  it("registers a normalized email, hashes its password, and gates unverified accounts", async () => {
    assert.equal(
      (await post("register", { email, password: "short" })).status,
      400
    );
    const r = await post("register", {
      email: " Builder@Example.Test ",
      password,
    });
    assert.equal(r.status, 200);
    assert.match(
      r.headers.getSetCookie()[0],
      /HttpOnly; SameSite=Strict; Max-Age=28800/
    );
    const s = await r.json();
    accountId = s.account.id;
    assert.equal(s.account.email, email);
    assert.equal(s.account.verified, false);
    assert.equal(s.actor, "");
    assert.match(
      store.accounts.byEmail(email)!.password,
      /^scrypt:131072:8:1:/
    );
    assert(!JSON.stringify(store.accounts.byEmail(email)).includes(password));
    assert.equal((await request("/api/context")).status, 403);
    assert.equal(
      (await post("challenge", { actor: actor.publicKey.toBase58() })).status,
      403
    );
    const preview = await (await request("/api/session/local-email")).json();
    assert.equal(preview.mode, "local");
    assert.equal(preview.message.to, email);
    assert.equal((await post("register", { email, password })).status, 409);
    assert.equal(
      store.db.prepare("SELECT COUNT(*) AS n FROM accounts").get()!.n,
      1
    );
  });
  it("confirms email with a one-use expiring link and invalidates superseded links", async () => {
    const first = new URL(
      (await (await request("/api/session/local-email")).json()).message.url
    ).searchParams.get("token");
    await post("resend");
    assert.equal((await post("verify", { token: first })).status, 400);
    const token = new URL(
      (await (await request("/api/session/local-email")).json()).message.url
    ).searchParams.get("token");
    assert.equal((await post("verify", { token })).status, 200);
    assert.equal((await post("verify", { token })).status, 400);
    assert.equal(
      (await (await request("/api/session")).json()).session.account.verified,
      true
    );
    assert.equal((await request("/api/context")).status, 403);
    assert.equal(
      (await (await request("/api/session/local-email")).json()).message,
      null
    );
    assert(!JSON.stringify(engine.state.market()).includes(email));
    assert.equal(store.head(), 0);
  });
  it("binds wallet signatures to the email session, origin, address and nonce", async () => {
    const c = await challenge();
    assert(c.message.includes(email));
    assert(c.message.includes(accountId));
    assert(c.message.includes(url));
    assert.equal(
      (
        await post(
          "connect",
          { nonce: c.nonce, signature: signature(c.message) },
          ""
        )
      ).status,
      400
    );
    const wrong = await challenge();
    assert.equal(
      (
        await post("connect", {
          nonce: wrong.nonce,
          signature: signature(wrong.message, stranger),
        })
      ).status,
      400
    );
    const valid = await challenge(),
      input = { nonce: valid.nonce, signature: signature(valid.message) };
    assert.equal(
      (await request("/api/session/connect", input, cookie, "http://evil.test"))
        .status,
      403
    );
    const old = cookie;
    assert.equal((await post("connect", input)).status, 200);
    assert.notEqual(cookie, old);
    assert.equal((await post("connect", input)).status, 400);
    assert.equal((await request("/api/context", undefined, old)).status, 401);
    assert.equal((await request("/api/context")).status, 200);
    const s = (await (await request("/api/session")).json()).session;
    assert.equal(s.actor, actor.publicKey.toBase58());
    assert.equal(s.account.wallet, s.actor);
    const expired = await challenge(),
      realNow = Date.now;
    Date.now = () => realNow() + 121000;
    try {
      assert.equal(
        (
          await post("connect", {
            nonce: expired.nonce,
            signature: signature(expired.message),
          })
        ).status,
        400
      );
    } finally {
      Date.now = realNow;
    }
  });
  it("keeps the email-wallet pair unique, including concurrent claims", async () => {
    assert.equal(
      (await post("challenge", { actor: stranger.publicKey.toBase58() }))
        .status,
      409
    );
    const firstCookie = cookie;
    const r = await post("register", {
      email: "second@example.test",
      password,
    });
    assert.equal(r.status, 200);
    const t = new URL(
      (await (await request("/api/session/local-email")).json()).message.url
    ).searchParams.get("token");
    await post("verify", { token: t });
    const c = await challenge();
    assert.equal(
      (
        await post("connect", {
          nonce: c.nonce,
          signature: signature(c.message),
        })
      ).status,
      409
    );
    assert.equal(store.accounts.byEmail("second@example.test")!.wallet, null);
    // Two verified accounts race for a previously unclaimed wallet.
    const secondCookie = cookie;
    const third = await post(
      "register",
      { email: "third@example.test", password },
      ""
    );
    assert.equal(third.status, 200);
    const t3 = new URL(
      (await (await request("/api/session/local-email")).json()).message.url
    ).searchParams.get("token");
    await post("verify", { token: t3 });
    const thirdCookie = cookie,
      a = await challenge(stranger, secondCookie),
      b = await challenge(stranger, thirdCookie);
    const results = await Promise.all([
      post(
        "connect",
        { nonce: a.nonce, signature: signature(a.message, stranger) },
        secondCookie
      ),
      post(
        "connect",
        { nonce: b.nonce, signature: signature(b.message, stranger) },
        thirdCookie
      ),
    ]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
    assert.equal(
      store.db
        .prepare("SELECT COUNT(*) AS n FROM accounts WHERE wallet=?")
        .get(stranger.publicKey.toBase58())!.n,
      1
    );
    cookie = firstCookie;
    await login();
    await connect();
  });
  it("persists across restart, rejects bad credentials and requires a new wallet proof after login", async () => {
    const saved = cookie;
    await stop();
    await start();
    assert.equal((await request("/api/context")).status, 200);
    assert.equal(
      (await post("login", { email, password: "wrong" })).status,
      401
    );
    assert.equal(
      (await post("login", { email: "missing@example.test", password })).status,
      401
    );
    const r = await login();
    assert.equal((await r.json()).actor, "");
    assert.notEqual(saved, cookie);
    assert.equal((await request("/api/context", undefined, saved)).status, 401);
    assert.equal((await request("/api/context")).status, 403);
    await connect();
  });
  it("enforces the linked command actor, mutation origins and wallet disconnect", async () => {
    const event = signEvent(stranger, {
      action: "progress",
      project: "missing",
      job: "missing",
      message: "wrong actor",
    });
    assert.match(
      (await (await request("/api/prepare", { event })).json()).error,
      /Actor does not match/
    );
    assert.equal(
      (await request("/api/session/logout", {}, cookie, "")).status,
      403
    );
    assert.equal((await post("disconnect")).status, 200);
    assert.equal((await request("/api/context")).status, 403);
    assert.equal(
      (await (await request("/api/session")).json()).session.account.email,
      email
    );
    await connect();
  });
  async function liveSocket() {
    const ws = new WebSocket(url.replace("http", "ws") + "/wire", {
      headers: { Origin: url, Cookie: cookie },
    });
    await new Promise<void>((resolve, reject) => {
      ws.on("error", reject);
      ws.on("open", () => ws.send(JSON.stringify(["AUTH", ""])));
      ws.on("message", (data) => {
        if (JSON.parse(data.toString())[0] === "OK") resolve();
      });
    });
    return ws;
  }
  it("resets a password through a private local outbox and revokes every session and socket", async () => {
    const saved = cookie,
      ws = await liveSocket(),
      closed = new Promise<number>((r) => ws.once("close", r));
    assert.equal((await post("forgot", { email }, "")).status, 200);
    assert.equal(
      (await post("forgot", { email: "absent@example.test" }, "")).status,
      200
    );
    assert.equal(
      (await request("/api/session/local-email", undefined, "")).status,
      401
    );
    const message = JSON.parse(
        readFileSync(join(mail, accountId + "-reset.json"), "utf8")
      ),
      token = new URL(message.url).searchParams.get("token");
    const next = "another unrelated test passphrase";
    assert.equal(
      (await post("reset", { token, password: next }, "")).status,
      200
    );
    assert.equal(await closed, 4001);
    assert.equal((await request("/api/context", undefined, saved)).status, 401);
    assert.equal((await post("reset", { token, password: next })).status, 400);
    assert.equal((await post("login", { email, password })).status, 401);
    assert.equal((await post("login", { email, password: next })).status, 200);
    assert.equal(
      store.accounts.byEmail(email)!.wallet,
      actor.publicKey.toBase58()
    );
    await connect();
  });
  it("revokes durable cookies on logout, expires sessions and denies foreign sockets", async () => {
    const saved = cookie,
      ws = await liveSocket(),
      closed = new Promise<number>((r) => ws.once("close", r));
    assert.equal((await post("logout")).status, 200);
    assert.equal(await closed, 4001);
    await stop();
    await start();
    assert.equal((await request("/api/context", undefined, saved)).status, 401);
    const foreign = new WebSocket(url.replace("http", "ws") + "/wire", {
      headers: { Origin: "http://evil.test", Cookie: saved },
    });
    assert.equal(
      await new Promise<number>((r) => foreign.once("close", r)),
      4003
    );
    await post("login", {
      email,
      password: "another unrelated test passphrase",
    });
    store.db.prepare("UPDATE account_sessions SET expires=0").run();
    assert.equal((await request("/api/context")).status, 401);
  });
  it("replicates login rate counters across restart", async () => {
    for (let i = 0; i < 8; i++)
      assert.equal(
        (await post("login", { email: "rate@example.test", password })).status,
        401
      );
    await stop();
    await start();
    assert.equal(
      (await post("login", { email: "rate@example.test", password })).status,
      429
    );
  });
});
