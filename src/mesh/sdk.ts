import { Keypair, Transaction } from "@solana/web3.js";
import WebSocket from "ws";
import nacl from "tweetnacl";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import { PRIVATE_ALGORITHM, SEALED_FILE, seal, unseal } from "./encryption";
import { createWorkPackage, verifyWorkPackage } from "../proof";
import { verifyPreparedTransaction } from "./transaction";
import { address, Command, Entry, signEvent, verifyEvent } from "./events";
export type ClientOptions = {
  /** Explicitly trusted cluster endpoints, used for reads AND writes. */
  replicas?: string[];
  stream?: string;
  failoverMs?: number;
  requestMs?: number;
  encryptionSecret?: Uint8Array;
};
class HttpError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}
export class MeshClient {
  private token = "";
  private authenticatedAt = 0;
  private readers = new Map<string, MeshClient>();
  private stream?: string;
  readonly encryptionSecret: Uint8Array;
  constructor(
    public url: string,
    public key: Keypair,
    public options: ClientOptions = {}
  ) {
    this.stream = options.stream;
    this.encryptionSecret =
      options.encryptionSecret ||
      hkdf(
        sha256,
        key.secretKey.subarray(0, 32),
        undefined,
        "ctrl-mesh:encryption:v1",
        32
      );
    if (this.encryptionSecret.length !== 32)
      throw Error("Encryption key must be 32 bytes");
  }
  async request(path: string, data?: any) {
    const r = await fetch(this.url + path, {
      method: data === undefined ? "GET" : "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.token ? { Authorization: "Bearer " + this.token } : {}),
      },
      body: data === undefined ? undefined : JSON.stringify(data),
      signal: AbortSignal.timeout(this.options.requestMs || 10000),
      redirect: "error",
    });
    const result = (await r.json()) as any;
    if (!r.ok) throw new HttpError(result.error || r.statusText, r.status);
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
  private async authedRequest(path: string, data?: any) {
    await this.session();
    try {
      return await this.request(path, data);
    } catch (e) {
      if (!(e instanceof HttpError) || e.status !== 401) throw e;
      await this.authenticate();
      return this.request(path, data);
    }
  }
  private async read<T>(
    fn: (client: MeshClient, health?: any) => Promise<T>
  ): Promise<T> {
    if (!this.options.replicas?.length) {
      const health = await this.request("/api/health");
      if (
        this.stream &&
        (health.stream || health.federation?.stream) !== this.stream
      )
        throw Error("Replica stream identity mismatch");
      this.stream ||= health.stream || health.federation?.stream;
      if (health.ha && !health.ha.writable)
        throw new HttpError("Coordinator election in progress", 503);
      return fn(this, health);
    }
    let failure: any;
    for (const url of [this.url, ...this.options.replicas]) {
      if (url !== this.url && !this.stream)
        throw Error("Pin a stream ID before offline replica fallback");
      const client =
        url === this.url
          ? this
          : this.readers.get(url) ||
            new MeshClient(url, this.key, {
              requestMs: this.options.requestMs,
            });
      if (url !== this.url) this.readers.set(url, client);
      try {
        const health = await client.request("/api/health");
        const stream = health.stream || health.federation?.stream;
        if (!stream || (this.stream && this.stream !== stream))
          throw new HttpError("Replica stream identity mismatch", 409);
        this.stream = stream;
        if (health.ha && !health.ha.writable)
          throw new HttpError("Coordinator election in progress", 503);
        return await fn(client, health);
      } catch (e) {
        if (e instanceof HttpError && e.status < 500) throw e;
        if (
          !(e instanceof HttpError) &&
          !(e instanceof TypeError) &&
          !(e instanceof DOMException)
        )
          throw e;
        failure = e;
      }
    }
    throw failure || Error("No relay available");
  }
  async updates(after = 0) {
    return this.read((client) =>
      client.authedRequest("/api/events?after=" + after)
    );
  }
  async context(
    options: { project?: string; job?: string; artifacts?: boolean } = {}
  ) {
    const query = new URLSearchParams();
    if (options.project) query.set("project", options.project);
    if (options.job) query.set("job", options.job);
    if (options.artifacts === false) query.set("artifacts", "0");
    return this.read(async (client, health) => {
      const snapshot = await client.authedRequest("/api/context?" + query);
      return {
        ...snapshot,
        relay: {
          url: client.url,
          readOnly: !!health?.readOnly,
          federation: health?.federation,
          ha: health?.ha,
        },
      };
    });
  }
  async market() {
    return this.read((client) => client.request("/api/market"));
  }
  async publishEncryptionKey(rotate = false) {
    const context = await this.context(),
      actor = this.key.publicKey.toBase58();
    const boxKey = Buffer.from(
      nacl.box.keyPair.fromSecretKey(this.encryptionSecret).publicKey
    ).toString("hex");
    const previous = context.encryptionKeys?.[actor];
    if (previous && JSON.parse(previous.content).boxKey === boxKey)
      return previous;
    if (previous && !rotate)
      throw Error(
        "A different encryption key is registered; keep the old key and explicitly rotate"
      );
    return (
      await this.publish({
        action: "key.publish",
        algorithm: PRIVATE_ALGORITHM,
        boxKey,
        previous: previous?.id || "",
      })
    ).event;
  }
  async publishPrivate(
    project: string,
    job: string | undefined,
    message: string,
    recipients: string[]
  ) {
    if (!message || message.length > 16000)
      throw Error("Private message must contain 1–16000 characters");
    await this.publishEncryptionKey();
    const context = await this.context();
    return this.publish({
      action: "private.publish",
      project,
      ...(job ? { job } : {}),
      sealed: seal(
        { message },
        {
          sender: this.key.publicKey.toBase58(),
          project,
          ...(job ? { job } : {}),
          purpose: "note",
        },
        recipients,
        context.encryptionKeys
      ),
    });
  }
  decryptPrivate(entry: Entry) {
    const command = verifyEvent(entry.event);
    if (command.action !== "private.publish")
      throw Error("Not a private message");
    return unseal(
      command.sealed,
      this.key.publicKey.toBase58(),
      this.encryptionSecret,
      {
        sender: address(entry.event.pubkey),
        project: command.project!,
        job: command.job,
        purpose: "note",
      }
    );
  }
  async submitPrivate(
    project: string,
    job: string,
    files: { path: string; content: Buffer }[],
    recipients: string[] = [],
    expectedRevision?: number
  ) {
    if (!files.length || files.length > 30)
      throw Error("Supply 1–30 artifact files");
    await this.publishEncryptionKey();
    const context = await this.context(),
      task = context.jobs.find(
        (j: any) => j.id === job && j.project === project
      );
    const p = [...context.projects, ...context.signingProjects].find(
      (p: any) => p.id === project
    );
    if (!task || !p) throw Error("Task access required");
    if (expectedRevision !== undefined && expectedRevision !== task.revision)
      throw Error("Stale revision; refresh context");
    // Apply the same path and duplicate-name rules before hiding the filenames.
    createWorkPackage(project + "/" + job, this.key, files);
    // File names and plaintext bytes stay inside the authenticated payload.
    const envelope = seal(
      {
        files: files.map((f) => ({
          path: f.path,
          base64: f.content.toString("base64"),
        })),
      },
      {
        sender: this.key.publicKey.toBase58(),
        project,
        job,
        purpose: "artifact",
      },
      [
        ...recipients,
        p.owner,
        p.reviewer,
        ...(p.expires === undefined || p.expires >= Date.now() / 1000
          ? [p.manager]
          : []),
      ],
      context.encryptionKeys
    );
    const container = Buffer.from(JSON.stringify(envelope));
    return this.publish({
      action: "job.submit",
      project,
      job,
      revision: task.revision,
      encrypted: true,
      package: createWorkPackage(project + "/" + job, this.key, [
        { path: SEALED_FILE, content: container },
      ]),
      files: [{ path: SEALED_FILE, base64: container.toString("base64") }],
    });
  }
  decryptArtifact(
    record: any,
    project: string,
    job: string
  ): { files: { path: string; base64: string }[] } {
    const c = verifyEvent(record.event);
    if (
      c.action !== "job.submit" ||
      !c.encrypted ||
      c.project !== project ||
      c.job !== job ||
      c.package.worker !== address(record.event.pubkey) ||
      c.package.taskId !== project + "/" + job ||
      !verifyWorkPackage(
        c.package,
        c.files.map((f: any) => ({
          path: f.path,
          content: Buffer.from(f.base64, "base64"),
        }))
      )
    )
      throw Error("Invalid encrypted artifact evidence");
    return unseal(
      JSON.parse(Buffer.from(c.files[0].base64, "base64").toString()),
      this.key.publicKey.toBase58(),
      this.encryptionSecret,
      {
        sender: address(record.event.pubkey),
        project,
        job,
        purpose: "artifact",
      }
    );
  }
  async publish(command: Command): Promise<Entry> {
    return this.publishEvent(signEvent(this.key, command));
  }
  /** Persist this event in the agent's outbox to retry even after the agent restarts. */
  async publishEvent(event: Entry["event"]): Promise<Entry> {
    verifyEvent(event);
    if (address(event.pubkey) !== this.key.publicKey.toBase58())
      throw Error("Event signer differs from client identity");
    const until = Date.now() + (this.options.failoverMs ?? 30000);
    let failure: any;
    do {
      try {
        return await this.read(async (client, health) => {
          // Legacy read replicas cannot be promoted by the client.
          if (health?.readOnly)
            throw new HttpError(
              "Replica is read-only; writable failover requires an HA cluster",
              409
            );
          const p = await client.authedRequest("/api/prepare", { event });
          if (p.entry) return p.entry;
          let transaction: string | undefined;
          if (p.transaction) {
            const tx = Transaction.from(Buffer.from(p.transaction, "base64"));
            await verifyPreparedTransaction(
              event,
              tx,
              await client.authedRequest("/api/context")
            );
            tx.partialSign(this.key);
            transaction = tx
              .serialize({ requireAllSignatures: false })
              .toString("base64");
          }
          return client.authedRequest("/api/commit", { event, transaction });
        });
      } catch (e) {
        if (e instanceof HttpError && e.status < 500) throw e;
        // Signature/instruction verification errors must not be retried as transport failures.
        if (
          !(e instanceof HttpError) &&
          !(e instanceof TypeError) &&
          !(e instanceof DOMException)
        )
          throw e;
        failure = e;
        if (Date.now() < until)
          await new Promise((resolve) => setTimeout(resolve, 300));
      }
    } while (Date.now() < until);
    const error = new Error(
      "Delivery unconfirmed; retry publishEvent with the same signed event: " +
        (failure?.message || failure)
    );
    Object.assign(error, { event, cause: failure });
    throw error;
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
        const active = await this.read(async (client, health) => {
          await client.authenticate();
          options.onStatus?.({
            relay: client.url,
            readOnly: !!health?.readOnly,
            federation: health?.federation,
          });
          return client;
        });
        if (stopped) return;
        socket = new WebSocket(active.url.replace(/^http/, "ws") + "/wire");
        socket.on("open", () => {
          socket!.send(JSON.stringify(["AUTH", active.token]));
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
