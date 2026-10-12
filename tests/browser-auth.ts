import { strict as assert } from "assert";
import { mkdtempSync } from "fs";
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

describe("browser identity and navigation", function () {
  this.timeout(15000);
  const url = "http://127.0.0.1:4221",
    actor = Keypair.generate(),
    stranger = Keypair.generate();
  const file = join(mkdtempSync(join(tmpdir(), "mesh-auth-")), "events.sqlite");
  let store: Store, engine: Engine, relay: ReturnType<typeof createRelay>;
  const jar = new Map<string, string>();
  const cookies = () => [...jar].map(([k, v]) => k + "=" + v).join("; ");
  async function request(
    path: string,
    input?: any,
    headers: Record<string, string> = {},
    cookie = cookies()
  ) {
    const r = await fetch(url + path, {
      method: input === undefined ? "GET" : "POST",
      headers: {
        Origin: url,
        Cookie: cookie,
        "Content-Type": "application/json",
        ...headers,
      },
      body: input === undefined ? undefined : JSON.stringify(input),
    });
    for (const c of r.headers.getSetCookie()) {
      const [pair] = c.split(";"),
        split = pair.indexOf("=");
      jar.set(pair.slice(0, split), pair.slice(split + 1));
    }
    return r;
  }
  async function challenge(key = actor) {
    const r = await request("/api/session/challenge", {
      actor: key.publicKey.toBase58(),
    });
    assert.equal(r.status, 200);
    return r.json();
  }
  const signature = (message: string, key = actor) =>
    Buffer.from(
      nacl.sign.detached(Buffer.from(message), key.secretKey)
    ).toString("hex");
  async function login(key = actor) {
    const c = await challenge(key);
    const r = await request("/api/session/login", {
      nonce: c.nonce,
      signature: signature(c.message, key),
    });
    assert.equal(r.status, 200);
    return r;
  }
  async function start() {
    store = new Store(file);
    engine = new Engine(store, {} as Chain);
    relay = createRelay(engine, { port: 4221 });
    await relay.start();
  }
  async function stop() {
    relay.server.closeAllConnections();
    await relay.stop();
    store.close();
  }
  before(start);
  after(stop);

  it("serves every deep route and rejects external post-login destinations", async () => {
    for (const path of [
      "/projects",
      "/market",
      "/agents",
      "/activity",
      "/network",
      "/login",
      "/account",
      projectPath("project /?"),
      taskPath("..", "a/b"),
      "/agents/" + actor.publicKey.toBase58(),
    ]) {
      const r = await request(path);
      assert.equal(r.status, 200, path);
      assert.match(r.headers.get("content-type")!, /text\/html/);
    }
    assert.equal(
      (await request("/missing", undefined, { Accept: "text/html" })).status,
      404
    );
    assert.equal((await request("/missing.js")).status, 404);
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
      "/missing",
    ])
      assert.equal(safeReturnPath(path), "/projects");
    assert.equal(safeReturnPath("/projects/p/tasks/t"), "/projects/p/tasks/t");
    assert.equal(parseRoute("/projects/%zz").view, "not-found");
  });
  it("requires a signed identity for private HTTP and keeps agent bearer authentication working", async () => {
    assert.equal(
      (await request("/api/context", undefined, {}, "")).status,
      401
    );
    assert.equal(
      (await request("/api/session", undefined, {}, "")).status,
      200
    );
    assert.equal(
      (await (await request("/api/session", undefined, {}, "")).json()).session,
      null
    );
    const client = new MeshClient(url, actor);
    assert.ok(await client.authenticate());
    assert.deepEqual((await client.context()).projects, []);
  });
  it("binds signatures to the browser, wallet and origin, rejects replay and expired challenges", async () => {
    const c = await challenge();
    assert.ok(
      c.message.startsWith(new URL(url).host + " wants you to sign in")
    );
    assert.match(c.message, new RegExp(actor.publicKey.toBase58()));
    assert.equal(
      (
        await request(
          "/api/session/login",
          { nonce: c.nonce, signature: signature(c.message) },
          {},
          ""
        )
      ).status,
      400
    );
    const other = await challenge();
    assert.equal(
      (
        await request("/api/session/login", {
          nonce: other.nonce,
          signature: signature(other.message, stranger),
        })
      ).status,
      400
    );
    const valid = await challenge();
    const input = { nonce: valid.nonce, signature: signature(valid.message) };
    assert.equal(
      (
        await request("/api/session/login", input, {
          Origin: "http://evil.test",
        })
      ).status,
      403
    );
    assert.equal((await request("/api/session/login", input)).status, 200);
    assert.equal((await request("/api/session/login", input)).status, 400);
    const expired = await challenge(),
      originalNow = Date.now;
    Date.now = () => originalNow() + 121000;
    try {
      assert.equal(
        (
          await request("/api/session/login", {
            nonce: expired.nonce,
            signature: signature(expired.message),
          })
        ).status,
        400
      );
    } finally {
      Date.now = originalNow;
    }
  });
  it("sets HttpOnly cookies, persists across restart and rotates sessions on another login", async () => {
    const r = await login();
    assert.ok(
      r.headers
        .getSetCookie()
        .some(
          (c) =>
            c.includes("HttpOnly") &&
            c.includes("SameSite=Strict") &&
            c.includes("Max-Age=28800")
        )
    );
    const old = cookies();
    assert.equal((await r.json()).actor, actor.publicKey.toBase58());
    await stop();
    await start();
    assert.equal(
      (await (await request("/api/session")).json()).session.actor,
      actor.publicKey.toBase58()
    );
    assert.equal((await request("/api/context")).status, 200);
    await login(stranger);
    assert.equal(
      (await request("/api/context", undefined, {}, old)).status,
      401
    );
    assert.equal(
      (await (await request("/api/session")).json()).session.actor,
      stranger.publicKey.toBase58()
    );
  });
  it("enforces actor binding, POST origin and server-side session expiry", async () => {
    await login();
    const event = signEvent(stranger, {
      action: "progress",
      project: "missing",
      job: "missing",
      message: "wrong actor",
    });
    const mismatch = await request("/api/prepare", { event });
    assert.match((await mismatch.json()).error, /Actor does not match/);
    assert.equal(
      (await request("/api/session/logout", {}, { Origin: "" })).status,
      403
    );
    store.db.prepare("UPDATE browser_sessions SET expires=0").run();
    assert.equal((await request("/api/context")).status, 401);
  });
  it("revokes cookies and live subscriptions on logout and denies foreign websocket origins", async () => {
    await login();
    const saved = cookies();
    const ws = new WebSocket(url.replace("http", "ws") + "/wire", {
      headers: { Origin: url, Cookie: saved },
    });
    const ready = new Promise<void>((resolve, reject) => {
      ws.on("error", reject);
      ws.on("open", () => ws.send(JSON.stringify(["AUTH", ""])));
      ws.on("message", (data) => {
        if (JSON.parse(data.toString())[0] === "OK") resolve();
      });
    });
    await ready;
    const closed = new Promise<number>((resolve) => ws.once("close", resolve));
    assert.equal((await request("/api/session/logout", {})).status, 200);
    assert.equal(await closed, 4001);
    assert.equal(
      (await request("/api/context", undefined, {}, saved)).status,
      401
    );
    await stop();
    await start();
    assert.equal(
      (await request("/api/context", undefined, {}, saved)).status,
      401
    );
    const foreign = new WebSocket(url.replace("http", "ws") + "/wire", {
      headers: { Origin: "http://evil.test", Cookie: saved },
    });
    assert.equal(
      await new Promise<number>((resolve) => foreign.once("close", resolve)),
      4003
    );
  });
});
