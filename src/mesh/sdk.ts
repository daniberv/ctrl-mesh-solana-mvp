import { Keypair, Transaction } from "@solana/web3.js";
import WebSocket from "ws";
import { verifyPreparedTransaction } from "./transaction";
import { Command, Entry, signEvent, verifyEvent } from "./events";
export class MeshClient {
  private token = "";
  private authenticatedAt = 0;
  constructor(public url: string, public key: Keypair) {}
  async request(path: string, data?: any) {
    const r = await fetch(this.url + path, {
      method: data === undefined ? "GET" : "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.token ? { Authorization: "Bearer " + this.token } : {}),
      },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    const result = (await r.json()) as any;
    if (!r.ok) throw Error(result.error || r.statusText);
    return result;
  }
  async authenticate() {
    const { nonce } = await this.request("/api/challenge");
    const r = await this.request("/api/auth", {
      event: signEvent(this.key, { action: "auth", nonce }),
    });
    this.token = r.token;
    this.authenticatedAt = Date.now();
    return this.token;
  }
  private async session() {
    if (!this.token || Date.now() - this.authenticatedAt > 25 * 60 * 1000)
      await this.authenticate();
  }
  async context(
    options: { project?: string; job?: string; artifacts?: boolean } = {}
  ) {
    await this.session();
    const query = new URLSearchParams();
    if (options.project) query.set("project", options.project);
    if (options.job) query.set("job", options.job);
    if (options.artifacts === false) query.set("artifacts", "0");
    return this.request("/api/context?" + query);
  }
  async market() {
    return this.request("/api/market");
  }
  async publish(command: Command): Promise<Entry> {
    await this.session();
    const event = signEvent(this.key, command);
    const p = await this.request("/api/prepare", { event });
    if (p.entry) return p.entry;
    let transaction: string | undefined;
    if (p.transaction) {
      const tx = Transaction.from(Buffer.from(p.transaction, "base64"));
      await verifyPreparedTransaction(event, tx, await this.context());
      tx.partialSign(this.key);
      transaction = tx
        .serialize({ requireAllSignatures: false })
        .toString("base64");
    }
    return this.request("/api/commit", { event, transaction });
  }
  async watch(
    onEntry: (entry: Entry) => void,
    options: {
      cursor?: number;
      project?: string;
      job?: string;
      onReady?: (cursor: number) => void;
      onStatus?: (status: any) => void;
      onError?: (error: Error) => void;
    } = {}
  ) {
    let stopped = false;
    let socket: WebSocket | undefined;
    let retry: NodeJS.Timeout | undefined;
    let cursor = options.cursor || 0;
    const seen = new Set<string>();
    const connect = async () => {
      if (stopped) return;
      try {
        await this.authenticate();
        if (stopped) return;
        socket = new WebSocket(this.url.replace(/^http/, "ws") + "/wire");
        socket.on("open", () => {
          socket!.send(JSON.stringify(["AUTH", this.token]));
          socket!.send(
            JSON.stringify([
              "REQ",
              "context",
              { after: cursor, project: options.project, job: options.job },
            ])
          );
        });
        socket.on("message", (bytes) => {
          try {
            const frame = JSON.parse(bytes.toString());
            if (frame[0] === "EVENT") {
              const entry = {
                event: frame[2],
                seq: frame[3].seq,
                receipt: frame[3].receipt,
              } as Entry;
              verifyEvent(entry.event);
              if (!seen.has(entry.event.id)) {
                onEntry(entry);
                seen.add(entry.event.id);
                if (seen.size > 10000) seen.delete(seen.values().next().value!);
              }
              cursor = Math.max(cursor, entry.seq);
            }
            if (frame[0] === "EOSE") {
              cursor = Math.max(cursor, frame[2]);
              options.onReady?.(cursor);
            }
            if (frame[0] === "CHAIN") options.onStatus?.(frame[1]);
            if (frame[0] === "NOTICE") options.onError?.(Error(frame[1]));
          } catch (e) {
            options.onError?.(e as Error);
          }
        });
        socket.on("error", (e) => options.onError?.(e));
        socket.on("close", () => {
          if (!stopped) retry = setTimeout(connect, 500);
        });
      } catch (e) {
        options.onError?.(e as Error);
        if (!stopped) retry = setTimeout(connect, 1000);
      }
    };
    await connect();
    return {
      close() {
        stopped = true;
        clearTimeout(retry);
        socket?.close();
      },
      cursor: () => cursor,
    };
  }
}
