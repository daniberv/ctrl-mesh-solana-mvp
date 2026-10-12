import { createServer, IncomingMessage, ServerResponse } from "http";
import { readFileSync } from "fs";
import { randomBytes } from "crypto";
import { WebSocketServer, WebSocket } from "ws";
import { Engine } from "./engine";
import { address, Entry, verifyEvent } from "./events";
import { Federation } from "./federation";
import { parseRoute } from "../routes";
import { BrowserAuth } from "./browser-auth";
export type DemoControl = {
  actors: () => any;
  run: (action: string, input: any) => Promise<any>;
};
export function createRelay(
  engine: Engine,
  options: {
    port: number;
    host?: string;
    demo?: DemoControl;
    federation?: Federation;
    publicOrigin?: string;
  }
) {
  const rates = new Map<string, { count: number; until: number }>();
  const limit = (actor: string) => {
    const now = Date.now();
    for (const [k, v] of rates) if (v.until < now) rates.delete(k);
    const bucket = rates.get(actor) || { count: 0, until: now + 60000 };
    if (++bucket.count > 120) throw Error("Command rate limit; retry later");
    rates.set(actor, bucket);
  };
  const challenges = new Map<string, number>();
  const browserAuth = new BrowserAuth(engine);
  const allowedOrigins = (req: IncomingMessage) => [
    options.publicOrigin || `http://${req.headers.host}`,
    ...(engine.consensus?.options.config.members.map(
      (m) => new URL(m.url).origin
    ) || []),
  ];
  const browserOrigin = (req: IncomingMessage) => {
    const origin = req.headers.origin;
    if (!origin || !allowedOrigins(req).includes(origin))
      throw Object.assign(Error("Browser origin required"), { status: 403 });
    return origin;
  };
  const sessions = new Map<string, { actor: string; expires: number }>();
  const actorFor = (token: string) => {
    const s = sessions.get(token);
    if (!s || s.expires < Date.now()) throw Error("Authentication required");
    return s.actor;
  };
  const requestActor = (req: IncomingMessage) =>
    req.headers.authorization
      ? actorFor(req.headers.authorization.replace(/^Bearer /, ""))
      : browserAuth.actor(req);
  const json = (res: ServerResponse, status: number, value: any) => {
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(JSON.stringify(value));
  };
  const body = async (req: IncomingMessage, maximum = 800000) => {
    const buffers: Buffer[] = [];
    let size = 0;
    for await (const b of req) {
      size += b.length;
      if (size > maximum) throw Error("Request too large");
      buffers.push(b);
    }
    return JSON.parse(Buffer.concat(buffers).toString() || "{}");
  };
  const server = createServer(async (req, res) => {
    try {
      const path = new URL(req.url || "/", "http://localhost").pathname;
      // No cross-origin command submission or DNS rebinding to the local demo.
      const host = req.headers.host || "";
      if (options.demo && !/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host))
        return json(res, 403, { error: "Local demo host required" });
      const peerOrigins =
        engine.consensus?.options.config.members.map(
          (m) => new URL(m.url).origin
        ) || [];
      if (
        req.headers.origin &&
        allowedOrigins(req).includes(req.headers.origin)
      ) {
        res.setHeader("Access-Control-Allow-Origin", req.headers.origin);
        res.setHeader("Vary", "Origin");
        res.setHeader("Access-Control-Allow-Credentials", "true");
        res.setHeader(
          "Access-Control-Allow-Headers",
          "Content-Type, Authorization"
        );
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        if (req.method === "OPTIONS") {
          res.writeHead(204);
          res.end();
          return;
        }
      } else if (req.headers.origin)
        return json(res, 403, { error: "Cross-origin requests disabled" });
      if (path === "/api/session" && req.method === "GET") {
        await engine.readBarrier();
        return json(res, 200, { session: browserAuth.session(req) || null });
      }
      if (path.startsWith("/api/session/") && req.method === "POST") {
        const origin = browserOrigin(req);
        limit("login:" + req.socket.remoteAddress);
        const input = await body(req, 4096);
        if (path === "/api/session/challenge")
          return json(
            res,
            200,
            await browserAuth.challenge(req, res, input, origin)
          );
        if (path === "/api/session/login")
          return json(
            res,
            200,
            await browserAuth.login(req, res, input, origin)
          );
        if (path === "/api/session/logout")
          return json(res, 200, await browserAuth.logout(req, res, origin));
        return json(res, 404, { error: "Not found" });
      }
      if (path === "/api/ha/rpc" && req.method === "POST" && engine.consensus) {
        engine.consensus.authorize(
          (req.headers.authorization || "").replace(/^Bearer /, "")
        );
        return json(
          res,
          200,
          engine.consensus.handle(await body(req, 2000000))
        );
      }
      if (
        path === "/api/federation/info" &&
        req.method === "GET" &&
        options.federation
      )
        return json(res, 200, options.federation.info());
      if (
        path === "/api/federation/batch" &&
        req.method === "GET" &&
        options.federation
      ) {
        options.federation.authorize(
          (req.headers.authorization || "").replace(/^Bearer /, "")
        );
        const query = new URL(req.url!, "http://localhost").searchParams;
        return json(
          res,
          200,
          options.federation.page(
            Number(query.get("after") || 0),
            query.get("nonce") || ""
          )
        );
      }
      if (path === "/api/challenge" && req.method === "GET") {
        for (const [n, t] of challenges)
          if (t < Date.now()) challenges.delete(n);
        if (challenges.size > 1000) throw Error("Too many challenges");
        const nonce = randomBytes(24).toString("hex");
        challenges.set(nonce, Date.now() + 60000);
        return json(res, 200, { nonce });
      }
      if (path === "/api/auth" && req.method === "POST") {
        const { event } = await body(req),
          c = verifyEvent(event);
        const expires = challenges.get(c.nonce) || 0;
        challenges.delete(c.nonce);
        if (c.action !== "auth" || expires < Date.now())
          throw Error("Invalid or expired challenge");
        for (const [token, s] of sessions)
          if (s.expires < Date.now()) sessions.delete(token);
        const token = randomBytes(32).toString("hex");
        sessions.set(token, {
          actor: address(event.pubkey),
          expires: Date.now() + 1800000,
        });
        return json(res, 200, { token });
      }
      if (path === "/api/market" && req.method === "GET") {
        await engine.readBarrier();
        return json(res, 200, engine.state.market());
      }
      if (path === "/api/health" && req.method === "GET")
        return json(res, 200, {
          ok: true,
          events: engine.state.timeline.length,
          pending: engine.store.pending().length,
          network: "localnet",
          demo: !!options.demo,
          readOnly: engine.readOnly,
          federation: options.federation?.info(),
          ha: engine.consensus?.info(),
          stream: engine.store.meta("stream"),
        });
      if (options.demo && path === "/api/demo/actors" && req.method === "GET")
        return json(res, 200, options.demo.actors());
      if (options.demo && path === "/api/demo/run" && req.method === "POST") {
        const data = await body(req);
        return json(res, 200, await options.demo.run(data.action, data));
      }
      if (path.startsWith("/api/")) {
        if (req.method === "GET") await engine.readBarrier();
        // Cookie-authenticated mutations require an allowed Origin, in addition
        // to each command's existing wallet signature and role checks.
        if (req.method === "POST" && !req.headers.authorization)
          browserOrigin(req);
        const actor = requestActor(req);
        if (path === "/api/context" && req.method === "GET") {
          const query = new URL(req.url!, "http://localhost").searchParams;
          const snapshot = engine.state.context(actor);
          const project = query.get("project"),
            job = query.get("job");
          if (project) {
            snapshot.projects = snapshot.projects.filter(
              (p) => p.id === project
            );
            snapshot.jobs = snapshot.jobs.filter((j) => j.project === project);
            snapshot.offers = snapshot.offers.filter(
              (o) => o.project === project
            );
          }
          if (job) {
            const task = snapshot.jobs.find((j) => j.id === job);
            snapshot.jobs = task
              ? snapshot.jobs.filter(
                  (j) => j.id === job || task.dependencies.includes(j.id)
                )
              : [];
            snapshot.offers = snapshot.offers.filter((o) => o.job === job);
            snapshot.projects = snapshot.projects.filter(
              (p) => p.id === task?.project
            );
          }
          snapshot.signingProjects = snapshot.signingProjects.filter((p) =>
            snapshot.jobs.some((j) => j.project === p.id)
          );
          if (query.get("artifacts") === "0")
            snapshot.jobs = snapshot.jobs.map((j) => ({
              ...j,
              packages: Object.fromEntries(
                Object.entries(j.packages).map(([worker, p]) => [
                  worker,
                  { eventId: p.eventId, package: p.package },
                ])
              ),
            }));
          return json(res, 200, snapshot);
        }
        if (path === "/api/events" && req.method === "GET") {
          const after = Number(
            new URL(req.url!, "http://localhost").searchParams.get("after") || 0
          );
          return json(res, 200, {
            entries: engine.store
              .entries(after)
              .filter((e) => engine.state.canRead(e, actor)),
            cursor: engine.state.timeline.at(-1)?.seq || 0,
          });
        }
        if (path === "/api/export" && req.method === "GET") {
          res.writeHead(200, {
            "Content-Type": "application/x-ndjson",
            "Content-Disposition": 'attachment; filename="mesh-events.ndjson"',
          });
          for (const e of engine.store.entries())
            if (engine.state.canRead(e, actor))
              res.write(JSON.stringify(e) + "\n");
          res.end();
          return;
        }
        if (
          req.method === "POST" &&
          (path === "/api/prepare" || path === "/api/commit")
        ) {
          limit(actor);
          const b = await body(req);
          if (address(b.event.pubkey) !== actor)
            throw Error("Actor does not match authenticated key");
          return json(
            res,
            200,
            path.endsWith("prepare")
              ? await engine.prepare(b.event)
              : await engine.commit(b.event, b.transaction)
          );
        }
        return json(res, 404, { error: "Not found" });
      }
      const files: Record<string, [string, string]> = {
        "/": ["web/index.html", "text/html"],
        "/style.css": ["web/style.css", "text/css"],
        "/app.js": ["web/app.js", "text/javascript"],
      };
      if (path === "/favicon.ico") {
        res.writeHead(204);
        res.end();
        return;
      }
      const appRoute = parseRoute(path).view !== "not-found";
      const missingPage =
        !files[path] &&
        !appRoute &&
        (req.headers.accept || "").includes("text/html");
      const asset =
        files[path] ||
        (appRoute || missingPage ? ["web/index.html", "text/html"] : undefined);
      if ((req.method === "GET" || req.method === "HEAD") && asset) {
        const [file, mime] = asset;
        res.writeHead(missingPage ? 404 : 200, {
          "Content-Type": mime + "; charset=utf-8",
          "Cache-Control": "no-cache",
          "Content-Security-Policy":
            "default-src 'self'; connect-src 'self' ws://127.0.0.1:* ws://localhost:* " +
            peerOrigins
              .flatMap((url) => [url, url.replace(/^http/, "ws")])
              .join(" ") +
            "; style-src 'self'; script-src 'self'; frame-ancestors 'none'",
        });
        res.end(req.method === "HEAD" ? undefined : readFileSync(file));
        return;
      }
      json(res, 404, { error: "Not found" });
    } catch (error) {
      const message = String((error as Error).message || error);
      json(
        res,
        message === "Authentication required"
          ? 401
          : (error as any).status || 400,
        {
          error: message,
          ...(engine.consensus ? { ha: engine.consensus.info() } : {}),
        }
      );
    }
  });
  const wss = new WebSocketServer({
    server,
    path: "/wire",
    maxPayload: 800000,
  });
  const leadership = () => {
    if (engine.consensus && !engine.consensus.writable)
      for (const socket of wss.clients)
        socket.close(1012, "Coordinator changed; reconnect with cursor");
  };
  engine.consensus?.on("change", leadership);
  wss.on("connection", (socket, req) => {
    if (
      req.headers.origin &&
      !allowedOrigins(req).includes(req.headers.origin)
    ) {
      socket.close(4003, "Origin is not allowed");
      return;
    }
    let alive = true;
    socket.on("pong", () => (alive = true));
    const heartbeat = setInterval(() => {
      if (actor) {
        try {
          authenticatedActor();
        } catch {
          socket.close(4001, "Session expired");
          return;
        }
      }
      if (!alive) {
        socket.terminate();
        return;
      }
      alive = false;
      socket.ping();
    }, 15000);

    let actor = "";
    let token = "";
    const authenticatedActor = () =>
      token ? actorFor(token) : (browserOrigin(req), browserAuth.actor(req));
    const revoked = (hash: string) => {
      if (!token && browserAuth.sessionHash(req) === hash)
        socket.close(4001, "Session ended");
    };
    engine.on("session.revoked", revoked);
    const subscriptions = new Map<string, any>();
    const send = (frame: any[]) => {
      if (socket.readyState === WebSocket.OPEN) {
        if (socket.bufferedAmount > 4 * 1024 * 1024) {
          socket.close(1013, "Slow consumer; reconnect with cursor");
          return;
        }
        socket.send(JSON.stringify(frame));
      }
    };
    const matches = (entry: Entry, f: any) => {
      const c = JSON.parse(entry.event.content);
      return (
        entry.seq > (f.after || 0) &&
        (!f.project || c.project === f.project) &&
        (!f.job || c.job === f.job) &&
        (!f.ids || f.ids.includes(entry.event.id)) &&
        (!f.since || entry.event.created_at >= f.since) &&
        (!f.until || entry.event.created_at <= f.until) &&
        (!f["#s"] || f["#s"].includes(c.project || "public")) &&
        (!f["#d"] || f["#d"].includes(c.job)) &&
        (!f.kinds || f.kinds.includes(entry.event.kind)) &&
        (!f.authors || f.authors.includes(entry.event.pubkey))
      );
    };
    const deliver = (entry: Entry) => {
      try {
        authenticatedActor();
      } catch {
        socket.close(4001, "Session expired");
        return;
      }
      for (const [id, f] of subscriptions)
        if (
          f.some((filter: any) => matches(entry, filter)) &&
          engine.state.canRead(entry, actor)
        )
          send([
            "EVENT",
            id,
            entry.event,
            { seq: entry.seq, receipt: entry.receipt },
          ]);
    };
    const chain = (status: any) => {
      try {
        authenticatedActor();
      } catch {
        return;
      }
      if (
        status.job &&
        engine.state.jobs[status.job] &&
        engine.state.canReadJob(engine.state.jobs[status.job], actor)
      )
        send(["CHAIN", status]);
    };
    engine.on("event", deliver);
    engine.on("chain", chain);
    socket.on("message", async (data) => {
      try {
        const [type, id, ...filters] = JSON.parse(data.toString());
        if (type === "AUTH") {
          if (typeof id !== "string")
            throw Error("Invalid authentication frame");
          token = id;
          await engine.readBarrier();
          actor = authenticatedActor();
          send(["OK", "AUTH", true]);
          return;
        }
        actor = authenticatedActor();
        if (type === "REQ") {
          await engine.readBarrier();
          if (subscriptions.size >= 20 && !subscriptions.has(id))
            throw Error("Subscription limit");
          const fs = filters.length ? filters : [{}];
          if (
            fs.length > 10 ||
            fs.some(
              (f: any) =>
                typeof f !== "object" ||
                f === null ||
                Array.isArray(f) ||
                !Number.isSafeInteger(f.after || 0) ||
                (f.after || 0) < 0 ||
                ["ids", "authors", "kinds", "#s", "#d"].some(
                  (k) => f[k] !== undefined && !Array.isArray(f[k])
                )
            )
          )
            throw Error("Invalid filter");
          subscriptions.set(id, fs);
          const selected = new Map<number, Entry>();
          for (const filter of fs) {
            const rows = engine.store
              .entries(filter.after || 0)
              .filter(
                (entry) =>
                  matches(entry, filter) && engine.state.canRead(entry, actor)
              );
            for (const entry of rows.slice(
              -(filter.limit === undefined
                ? Math.max(1, rows.length)
                : Math.max(1, Math.min(Number(filter.limit) || 1, 10000)))
            ))
              selected.set(entry.seq, entry);
          }
          for (const entry of [...selected.values()].sort(
            (a, b) => a.seq - b.seq
          ))
            send([
              "EVENT",
              id,
              entry.event,
              { seq: entry.seq, receipt: entry.receipt },
            ]);
          send(["EOSE", id, engine.state.timeline.at(-1)?.seq || 0]);
        } else if (type === "EVENT") {
          limit(actor);
          if (address(id.pubkey) !== actor) throw Error("Actor mismatch");
          const prepared = await engine.prepare(id);
          if (prepared.transaction)
            throw Error(
              "On-chain commands require HTTP prepare/commit with an actor-signed transaction"
            );
          await engine.commit(id);
          send(["OK", id.id, true, "stored"]);
        } else if (type === "CLOSE") subscriptions.delete(id);
        else throw Error("Use signed prepare/commit for mutations");
      } catch (e) {
        send(["NOTICE", (e as Error).message]);
      }
    });
    socket.on("close", () => {
      clearInterval(heartbeat);
      engine.off("event", deliver);
      engine.off("chain", chain);
      engine.off("session.revoked", revoked);
    });
  });
  return {
    server,
    wss,
    start: () =>
      new Promise<void>((resolve) =>
        server.listen(options.port, options.host || "127.0.0.1", resolve)
      ),
    stop: () =>
      new Promise<void>((resolve) => {
        for (const client of wss.clients) client.terminate();
        wss.close();
        engine.consensus?.off("change", leadership);
        server.close(() => resolve());
      }),
  };
}
