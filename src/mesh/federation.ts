import { Keypair } from "@solana/web3.js";
import nacl from "tweetnacl";
import { randomBytes, timingSafeEqual } from "crypto";
import { Engine } from "./engine";
import { canonical, digest, Entry } from "./events";
import { journalHash } from "./store";
export type Upstream = { url: string; publicKey: string; token: string };
export type FederationOptions = {
  identity: Keypair;
  token?: string;
  upstream?: Upstream;
};
type Page = {
  version: 1;
  stream: string;
  genesis: string;
  program: string;
  nonce: string;
  after: number;
  previous: string;
  head: number;
  headHash: string;
  entries: Entry[];
  cursor: number;
  hash: string;
};
const pageHash = (page: Page) =>
  digest("ctrl-mesh:replication:v1:" + canonical(page));
const validURL = (raw: string) => {
  const u = new URL(raw);
  if (
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    u.pathname !== "/" ||
    (u.protocol !== "https:" &&
      !(
        u.protocol === "http:" &&
        ["localhost", "127.0.0.1"].includes(u.hostname)
      ))
  )
    throw Error("Peer URL must be an HTTPS origin or loopback HTTP origin");
  return u.origin;
};
export class Federation {
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private stopped = false;
  private genesis = "";
  private lastSync: string | null = null;
  private error: string | null = null;
  private remoteHead = 0;
  constructor(public engine: Engine, public options: FederationOptions) {
    if (options.token && options.token.length < 32)
      throw Error("Replication token must contain at least 32 characters");
    if (options.upstream) {
      if (engine.store.head() && !engine.store.meta("upstream"))
        throw Error(
          "Use a separate empty database for a new replica; this journal is a coordinator journal"
        );
      options.upstream.url = validURL(options.upstream.url);
      if (
        !/^[a-f0-9]{64}$/.test(options.upstream.publicKey) ||
        options.upstream.token.length < 32
      )
        throw Error("Pinned peer key and replication token required");
      if (!engine.readOnly)
        throw Error("An upstream requires read-only replica mode");
    }
  }
  async initialize() {
    this.genesis = await this.engine.chain.connection.getGenesisHash();
    const saved = this.engine.store.meta("genesis");
    if (saved && saved !== this.genesis)
      throw Error("Journal belongs to a different Solana ledger");
    this.engine.store.setMeta("genesis", this.genesis);
  }
  info() {
    return {
      version: 1,
      publicKey: Buffer.from(
        this.options.identity.publicKey.toBytes()
      ).toString("hex"),
      stream: this.engine.store.meta("stream"),
      genesis: this.genesis,
      program: this.engine.chain.program.programId.toBase58(),
      mode: this.engine.readOnly ? "replica" : "coordinator",
      head: this.engine.store.head(),
      hash: this.engine.store.hash(),
      lastSync: this.lastSync,
      remoteHead: this.remoteHead,
      lag: this.options.upstream
        ? Math.max(0, this.remoteHead - this.engine.store.head())
        : 0,
      error: this.error,
    };
  }
  authorize(token: string) {
    const expected = this.options.token;
    if (
      !expected ||
      Buffer.byteLength(token) !== Buffer.byteLength(expected) ||
      !timingSafeEqual(Buffer.from(token), Buffer.from(expected))
    )
      throw Error("Peer authentication required");
  }
  page(after: number, nonce: string) {
    if (
      !Number.isSafeInteger(after) ||
      after < 0 ||
      after > this.engine.store.head() ||
      !/^[a-f0-9]{48}$/.test(nonce)
    )
      throw Error("Invalid replication cursor or nonce");
    const entries: Entry[] = [];
    let size = 0;
    for (const entry of this.engine.store.entries(after, 16)) {
      const bytes = Buffer.byteLength(JSON.stringify(entry));
      if (entries.length && size + bytes > 1024 * 1024) break;
      entries.push(entry);
      size += bytes;
    }
    const cursor = entries.at(-1)?.seq || after;
    const page: Page = {
      version: 1,
      stream: this.engine.store.meta("stream")!,
      genesis: this.genesis,
      program: this.engine.chain.program.programId.toBase58(),
      nonce,
      after,
      previous: this.engine.store.hash(after)!,
      head: this.engine.store.head(),
      headHash: this.engine.store.hash()!,
      entries,
      cursor,
      hash: this.engine.store.hash(cursor)!,
    };
    return {
      page,
      signature: Buffer.from(
        nacl.sign.detached(
          Buffer.from(pageHash(page), "hex"),
          this.options.identity.secretKey
        )
      ).toString("hex"),
    };
  }
  async sync() {
    if (this.running) return this.running;
    this.running = this.pull()
      .then(() => {
        this.error = null;
        this.lastSync = new Date().toISOString();
      })
      .catch((e) => {
        this.error = (e as Error).message;
        throw e;
      })
      .finally(() => {
        this.running = undefined;
      });
    return this.running;
  }
  private async pull() {
    const peer = this.options.upstream;
    if (!peer) return;
    const savedPeer = this.engine.store.meta("upstream");
    if (savedPeer && savedPeer !== peer.publicKey)
      throw Error("Upstream identity changed; explicit migration required");
    // Bound each pass so shutdown and status stay responsive while repairing large tails.
    for (let round = 0; round < 16 && !this.stopped; round++) {
      const after = this.engine.store.head(),
        nonce = randomBytes(24).toString("hex");
      const response = await fetch(
        peer.url + `/api/federation/batch?after=${after}&nonce=${nonce}`,
        {
          headers: { Authorization: "Bearer " + peer.token },
          signal: AbortSignal.timeout(10000),
          redirect: "error",
        }
      );
      if (!response.ok) throw Error("Peer returned HTTP " + response.status);
      const chunks: Uint8Array[] = [];
      let size = 0;
      for await (const chunk of response.body as any) {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) throw Error("Replication page too large");
        chunks.push(chunk);
      }
      const { page, signature } = JSON.parse(
        Buffer.concat(chunks).toString()
      ) as { page: Page; signature: string };
      if (
        !page ||
        typeof signature !== "string" ||
        !/^[a-f0-9]{128}$/.test(signature) ||
        !nacl.sign.detached.verify(
          Buffer.from(pageHash(page), "hex"),
          Buffer.from(signature, "hex"),
          Buffer.from(peer.publicKey, "hex")
        )
      )
        throw Error("Invalid peer signature");
      if (
        page.version !== 1 ||
        page.nonce !== nonce ||
        page.after !== after ||
        page.previous !== this.engine.store.hash(after) ||
        page.genesis !== this.genesis ||
        page.program !== this.engine.chain.program.programId.toBase58() ||
        !Number.isSafeInteger(page.head) ||
        page.head < after ||
        !Array.isArray(page.entries) ||
        page.entries.length > 16
      )
        throw Error("Peer journal prefix, network or challenge mismatch");
      if (
        typeof page.stream !== "string" ||
        page.stream.length > 100 ||
        !page.stream
      )
        throw Error("Invalid stream identity");
      if (
        (after > 0 || savedPeer) &&
        page.stream !== this.engine.store.meta("stream")
      )
        throw Error("Peer stream changed; refusing to mix journals");
      let hash = this.engine.store.hash(after)!;
      for (const [i, entry] of page.entries.entries()) {
        if (entry.seq !== after + i + 1) throw Error("Peer sequence gap");
        hash = journalHash(hash, entry);
      }
      if (
        page.cursor !== after + page.entries.length ||
        page.cursor > page.head ||
        page.hash !== hash ||
        (page.cursor === page.head && page.headHash !== hash) ||
        (page.head > after && !page.entries.length)
      )
        throw Error("Peer journal hash mismatch");
      if (!savedPeer && after === 0) {
        this.engine.store.setMeta("stream", page.stream);
        this.engine.store.setMeta("upstream", peer.publicKey);
      }
      this.remoteHead = page.head;
      for (const entry of page.entries) await this.engine.importEntry(entry);
      if (this.engine.store.hash() !== page.hash)
        throw Error("Imported journal hash mismatch");
      if (page.cursor === page.head) return;
    }
  }
  start(interval = 1000) {
    if (!this.options.upstream) return;
    const tick = () => {
      this.sync().catch(() => {});
    };
    tick();
    this.timer = setInterval(tick, interval);
  }
  async stop() {
    this.stopped = true;
    clearInterval(this.timer);
    await this.running?.catch(() => {});
  }
}
