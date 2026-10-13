import { createServer } from "http";

/** The public RPC rate limit is lower than the CLI's parallel upload rate. */
export async function deploymentRPC(upstream: string) {
  let queue = Promise.resolve(),
    lastRequest = 0,
    closing = false;
  const stop = new AbortController();
  const server = createServer(async (req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 2_000_000) {
        res.writeHead(413).end();
        return;
      }
      chunks.push(Buffer.from(chunk));
    }
    const body = Buffer.concat(chunks).toString();
    const scheduled = queue.then(async () => {
      if (closing) {
        res.destroy();
        return;
      }
      const wait = Math.max(0, 350 - (Date.now() - lastRequest));
      if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
      lastRequest = Date.now();
    });
    queue = scheduled.catch(() => {});
    const call = scheduled.then(async () => {
      for (let retry = 0; retry < 4; retry++) {
        if (closing) {
          res.destroy();
          return;
        }
        const response = await fetch(upstream, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
          signal: AbortSignal.any([AbortSignal.timeout(20000), stop.signal]),
        });
        const text = await response.text();
        if (response.status === 429 && retry < 3) {
          await new Promise((resolve) => setTimeout(resolve, 3000));
          continue;
        }
        res.writeHead(response.status, { "Content-Type": "application/json" });
        res.end(text);
        return;
      }
    });
    try {
      await call;
    } catch {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: "Devnet RPC unavailable; retry the saved upload",
          },
          id: null,
        })
      );
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => {
      closing = true;
      stop.abort();
      server.closeAllConnections();
      server.close();
    },
  };
}
