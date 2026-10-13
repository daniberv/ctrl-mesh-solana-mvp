import { createServer, request as upstreamRequest, ServerResponse } from "http";
import { readFileSync } from "fs";
import type { Duplex } from "stream";
import type { ClusterConfig, Member } from "./mesh/consensus";

/** Loopback gateway: stable public origin, leader selection, no mutation retries. */
async function main() {
  const config: ClusterConfig = JSON.parse(
    readFileSync(process.env.MESH_HA_CONFIG!, "utf8")
  );
  for (const member of config.members) {
    const url = new URL(member.url);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1")
      throw Error("Production gateway expects loopback voters");
  }
  let available: Member[] = [],
    leader: Member | undefined,
    lastPoll = 0;
  let polling: Promise<void> | undefined;
  const poll = () => {
    if (polling) return polling;
    polling = (async () => {
      const states = await Promise.all(
        config.members.map(async (member) => {
          try {
            const response = await fetch(member.url + "/api/health", {
              signal: AbortSignal.timeout(1500),
              redirect: "error",
            });
            const health = (await response.json()) as any;
            if (
              !response.ok ||
              health.ha?.cluster !== config.cluster ||
              health.stream !== config.stream ||
              health.solana?.genesis !== config.genesis ||
              health.solana?.program !== config.program ||
              health.ha.error
            )
              return null;
            return { member, health };
          } catch {
            return null;
          }
        })
      );
      const healthy = states.filter((s): s is NonNullable<typeof s> => !!s);
      available = healthy.map((s) => s.member);
      leader = healthy
        .filter((s) => s.health.ha.writable)
        .sort((a, b) => b.health.ha.term - a.health.ha.term)[0]?.member;
      lastPoll = Date.now();
    })().finally(() => {
      polling = undefined;
    });
    return polling;
  };
  const target = async (path: string) => {
    if (Date.now() - lastPoll > 500) await poll();
    return (
      leader ||
      (!path.startsWith("/api/") || path === "/api/health"
        ? available[0]
        : undefined)
    );
  };
  const unavailable = (res: ServerResponse) => {
    res.writeHead(503, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Retry-After": "2",
    });
    res.end(
      JSON.stringify({
        error: "Coordinator election in progress; retry shortly.",
      })
    );
  };
  const server = createServer(async (req, res) => {
    const member = await target(req.url || "/");
    if (!member) return unavailable(res);
    const upstream = upstreamRequest(
      member.url + req.url,
      {
        method: req.method,
        headers: req.headers,
      },
      (response) => {
        res.writeHead(response.statusCode || 502, response.headers);
        response.pipe(res);
      }
    );
    upstream.setTimeout(45000, () =>
      upstream.destroy(Error("Upstream timeout"))
    );
    upstream.on("error", () => {
      lastPoll = 0;
      if (!res.headersSent) unavailable(res);
      else res.destroy();
    });
    res.on("close", () => upstream.destroy());
    req.pipe(upstream);
  });
  server.on("upgrade", async (req, rawSocket, head) => {
    const socket = rawSocket as Duplex;
    socket.on("error", () => socket.destroy());
    if (req.url !== "/wire") {
      socket.destroy();
      return;
    }
    const member = await target("/api/wire");
    if (!member) {
      socket.end(
        "HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n"
      );
      return;
    }
    const upstream = upstreamRequest(member.url + req.url, {
      headers: req.headers,
    });
    upstream.on("upgrade", (response, peer, peerHead) => {
      peer.setTimeout(0);
      socket.write(
        `HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n`
      );
      for (let i = 0; i < response.rawHeaders.length; i += 2)
        socket.write(
          `${response.rawHeaders[i]}: ${response.rawHeaders[i + 1]}\r\n`
        );
      socket.write("\r\n");
      if (peerHead.length) socket.write(peerHead);
      if (head.length) peer.write(head);
      peer.on("error", () => socket.destroy());
      socket.on("close", () => peer.destroy());
      peer.on("close", () => socket.destroy());
      peer.pipe(socket);
      socket.pipe(peer);
    });
    upstream.on("response", () => socket.destroy());
    upstream.on("error", () => {
      lastPoll = 0;
      socket.destroy();
    });
    upstream.setTimeout(5000, () => upstream.destroy());
    upstream.end();
  });
  await poll();
  const timer = setInterval(() => {
    void poll();
  }, 500);
  server.listen(Number(process.env.PORT || 4180), "127.0.0.1", () =>
    console.log("ctrl-mesh production gateway listening on loopback")
  );
  const stop = () => {
    clearInterval(timer);
    server.closeAllConnections();
    server.close(() => process.exit(0));
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
