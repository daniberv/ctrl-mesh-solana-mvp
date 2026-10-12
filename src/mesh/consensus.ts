import { timingSafeEqual } from "crypto";
import { EventEmitter } from "events";
import { Store, EMPTY_HASH } from "./store";
import { canonical, digest, MeshEvent, Receipt } from "./events";

export type Action =
  | { type: "barrier" }
  | {
      type: "session.create";
      hash: string;
      actor: string;
      expires: number;
      previous?: string;
    }
  | { type: "session.revoke"; hash: string }
  | { type: "intent"; event: MeshEvent; transaction: string; signature: string }
  | { type: "entry"; event: MeshEvent; receipt: Receipt }
  | { type: "failed"; id: string };
export type Member = { id: string; url: string };
export type ClusterConfig = {
  cluster: string;
  stream: string;
  genesis: string;
  program: string;
  baseHead: number;
  baseHash: string;
  members: Member[];
};
type Record = { idx: number; term: number; hash: string; action: Action };
export class Unavailable extends Error {
  status = 503;
}
type Options = {
  id: string;
  token: string;
  config: ClusterConfig;
  electionMs?: number;
  heartbeatMs?: number;
  requestMs?: number;
  proposalMs?: number;
  // Injectable transport for deterministic partition/crash tests.
  transport?: (peer: Member, message: any) => Promise<any>;
};

/** Fixed-membership, crash-fault Raft. All three voters retain the complete log.
 * No lease/clock-based safety assumption and no automatic membership changes.
 * A transaction may leave this process only after its exact bytes are committed.
 */
export class Consensus extends EventEmitter {
  role: "follower" | "candidate" | "leader" = "follower";
  leader?: string;
  term = 0;
  commitIndex = 0;
  applied = 0;
  error?: string;
  private vote?: string;
  private timer?: NodeJS.Timeout;
  private deadline = 0;
  private heartbeat = 0;
  private active = false;
  private readyIndex = 0;
  private next = new Map<string, number>();
  private matched = new Map<string, number>();
  private inFlight = new Set<string>();
  private tasks = new Set<Promise<any>>();
  private identity: string;
  private electionMs: number;
  private waiters = new Set<() => void>();
  constructor(
    public store: Store,
    public options: Options,
    private apply: (action: Action) => void
  ) {
    super();
    const c = options.config;
    if (options.token.length < 32)
      throw Error("HA peer token must have at least 32 characters");
    if (
      c.members.length !== 3 ||
      new Set(c.members.map((m) => m.id)).size !== 3 ||
      new Set(c.members.map((m) => m.url)).size !== 3 ||
      !c.members.some((m) => m.id === options.id)
    )
      throw Error(
        "HA requires exactly three distinct fixed voters including this node"
      );
    for (const m of c.members) {
      const url = new URL(m.url);
      if (
        url.username ||
        url.password ||
        url.pathname !== "/" ||
        url.search ||
        url.hash ||
        !(
          url.protocol === "https:" ||
          (url.protocol === "http:" &&
            ["127.0.0.1", "localhost"].includes(url.hostname))
        )
      )
        throw Error("HA peers require HTTPS or loopback HTTP origins");
    }
    if (
      store.meta("stream") !== c.stream ||
      store.hash(c.baseHead) !== c.baseHash ||
      store.meta("genesis") !== c.genesis
    )
      throw Error("HA bootstrap journal/network mismatch");
    this.identity = digest(canonical(c));
    const pinned = store.meta("ha.config");
    if (pinned && pinned !== this.identity)
      throw Error("HA membership/configuration is immutable");
    if (store.meta("ha.node") && store.meta("ha.node") !== options.id)
      throw Error(
        "HA database belongs to a different voter; do not clone active voter databases"
      );
    if (!pinned && (store.head() !== c.baseHead || store.pending().length))
      throw Error(
        "Bootstrap requires the exact quiescent baseline and no pending transactions"
      );
    store.db.exec(`PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS consensus_log(idx INTEGER PRIMARY KEY,term INTEGER NOT NULL,hash TEXT NOT NULL,action TEXT NOT NULL);`);
    store.setMeta("ha.config", this.identity);
    store.setMeta("ha.node", options.id);
    const hard = JSON.parse(
      store.meta("ha.hard") || '{"term":0,"commit":0,"applied":0}'
    );
    this.term = hard.term;
    this.vote = hard.vote;
    this.commitIndex = hard.commit;
    this.applied = hard.applied;
    let previous = EMPTY_HASH,
      index = 0,
      term = 0;
    for (const row of this.records()) {
      if (
        row.idx !== ++index ||
        row.term < term ||
        row.hash !== this.hash(previous, row)
      )
        throw Error("Consensus log integrity mismatch");
      previous = row.hash;
      term = row.term;
    }
    if (
      this.applied > this.commitIndex ||
      this.commitIndex > index ||
      term > this.term
    )
      throw Error("Invalid durable consensus state");
    this.electionMs = options.electionMs || 1500;
    this.applyCommitted();
  }
  private hash(previous: string, row: Omit<Record, "hash"> | Record) {
    return digest(canonical([previous, row.idx, row.term, row.action]));
  }
  private persist() {
    this.store.setMeta(
      "ha.hard",
      JSON.stringify({
        term: this.term,
        vote: this.vote,
        commit: this.commitIndex,
        applied: this.applied,
      })
    );
  }
  private records(after = 0, limit = Number.MAX_SAFE_INTEGER): Record[] {
    return (
      this.store.db
        .prepare("SELECT * FROM consensus_log WHERE idx>? ORDER BY idx LIMIT ?")
        .all(after, limit) as any[]
    ).map((r) => ({ ...r, action: JSON.parse(r.action) }));
  }
  private record(idx: number): Record {
    if (idx === 0)
      return { idx: 0, term: 0, hash: EMPTY_HASH, action: { type: "barrier" } };
    const r = this.store.db
      .prepare("SELECT * FROM consensus_log WHERE idx=?")
      .get(idx) as any;
    return r && { ...r, action: JSON.parse(r.action) };
  }
  private last(): Record {
    const r = this.store.db
      .prepare("SELECT * FROM consensus_log ORDER BY idx DESC LIMIT 1")
      .get() as any;
    return r ? { ...r, action: JSON.parse(r.action) } : this.record(0);
  }
  private resetDeadline() {
    this.deadline = Date.now() + this.electionMs * (1 + Math.random());
  }
  info() {
    return {
      cluster: this.options.config.cluster,
      node: this.options.id,
      role: this.role,
      term: this.term,
      leader: this.options.config.members.find((m) => m.id === this.leader)
        ?.url,
      writable: this.writable,
      committed: this.commitIndex,
      applied: this.applied,
      log: this.last().idx,
      voters: 3,
      quorum: 2,
      members: this.options.config.members,
      error: this.error,
    };
  }
  get writable() {
    return (
      this.active &&
      !this.error &&
      this.role === "leader" &&
      this.readyIndex > 0 &&
      this.applied >= this.readyIndex
    );
  }
  assertLeader(term = this.term) {
    if (!this.writable || term !== this.term)
      throw new Unavailable(
        "Coordinator changed or is electing; retry the same signed event on the cluster"
      );
    return this.term;
  }
  authorize(token: string) {
    const a = Buffer.from(token),
      b = Buffer.from(this.options.token);
    if (a.length !== b.length || !timingSafeEqual(a, b))
      throw Error("HA peer authentication required");
  }
  start() {
    this.active = true;
    this.resetDeadline();
    this.timer = setInterval(() => {
      if (this.error) return;
      if (this.role === "leader") {
        if (Date.now() >= this.heartbeat) this.replicate();
      } else if (Date.now() >= this.deadline) this.track(this.elect());
    }, 50);
  }
  async stop() {
    this.active = false;
    clearInterval(this.timer);
    this.stepDown(this.term);
    await Promise.allSettled([...this.tasks]);
  }
  private track(promise: Promise<any>) {
    this.tasks.add(promise);
    promise
      .catch((e) => {
        this.error = String(e.message || e);
        this.stepDown(this.term);
      })
      .finally(() => this.tasks.delete(promise));
  }
  private changed() {
    for (const wake of this.waiters) wake();
    this.emit("change", this.info());
  }
  private stepDown(term: number, leader?: string) {
    if (term > this.term) {
      this.term = term;
      this.vote = undefined;
      this.persist();
    }
    this.role = "follower";
    this.leader = leader;
    this.readyIndex = 0;
    this.resetDeadline();
    this.changed();
  }
  private async rpc(peer: Member, message: any) {
    const request = {
      ...message,
      from: this.options.id,
      config: this.identity,
    };
    if (this.options.transport) return this.options.transport(peer, request);
    const r = await fetch(peer.url + "/api/ha/rpc", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + this.options.token,
      },
      body: JSON.stringify(request),
      redirect: "error",
      signal: AbortSignal.timeout(this.options.requestMs || 1000),
    });
    if (!r.ok) throw Error("HA peer unavailable: " + r.status);
    return r.json() as Promise<any>;
  }
  private async elect() {
    if (!this.active || this.error) return;
    this.role = "candidate";
    this.leader = undefined;
    this.term++;
    this.vote = this.options.id;
    this.persist();
    this.resetDeadline();
    const term = this.term,
      last = this.last();
    let votes = 1;
    this.changed();
    await Promise.all(
      this.options.config.members
        .filter((m) => m.id !== this.options.id)
        .map(async (peer) => {
          try {
            const r = await this.rpc(peer, {
              type: "vote",
              term,
              lastIndex: last.idx,
              lastTerm: last.term,
            });
            if (!this.active) return;
            if (r.term > this.term) {
              this.stepDown(r.term);
              return;
            }
            if (
              this.term !== term ||
              this.role !== "candidate" ||
              r.term !== term ||
              !r.granted
            )
              return;
            if (++votes >= 2) {
              this.role = "leader";
              this.leader = this.options.id;
              this.next.clear();
              this.matched.clear();
              for (const m of this.options.config.members)
                if (m.id !== this.options.id)
                  this.next.set(m.id, this.last().idx + 1);
              // A current-term entry commits inherited intents before any new work.
              this.readyIndex = this.append({ type: "barrier" }).idx;
              this.changed();
              this.replicate();
            }
          } catch {
            /* A missing peer does not prevent the other majority from electing. */
          }
        })
    );
  }
  /** Authenticated RPC handler. No await: disk term/vote/log transitions are indivisible. */
  handle(m: any) {
    if (!this.active || this.error)
      throw new Unavailable(this.error || "HA node stopped");
    if (
      m.config !== this.identity ||
      !this.options.config.members.some((p) => p.id === m.from) ||
      m.from === this.options.id
    )
      throw Error("HA cluster/member mismatch");
    if (
      !Number.isSafeInteger(m.term) ||
      m.term < 1 ||
      !["vote", "append"].includes(m.type)
    )
      throw Error("Invalid consensus message");
    if (m.term > this.term) this.stepDown(m.term);
    if (m.type === "vote") {
      const last = this.last();
      const fresh =
        m.lastTerm > last.term ||
        (m.lastTerm === last.term && m.lastIndex >= last.idx);
      const granted =
        m.term === this.term && (!this.vote || this.vote === m.from) && fresh;
      if (granted) {
        this.vote = m.from;
        this.persist();
        this.resetDeadline();
      }
      return { term: this.term, granted };
    }
    if (m.term < this.term) return { term: this.term, ok: false };
    this.stepDown(m.term, m.from);
    const previous = this.record(m.previous);
    if (
      !previous ||
      previous.term !== m.previousTerm ||
      previous.hash !== m.previousHash
    )
      return { term: this.term, ok: false, last: this.last().idx };
    if (
      !Array.isArray(m.entries) ||
      m.entries.length > 8 ||
      !Number.isSafeInteger(m.commit) ||
      m.commit < 0
    )
      throw Error("Invalid consensus append");
    let prior = previous;
    this.store.db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of m.entries as Record[]) {
        if (
          row.idx !== prior.idx + 1 ||
          !Number.isSafeInteger(row.term) ||
          row.term < prior.term ||
          row.term > m.term ||
          row.hash !== this.hash(prior.hash, row)
        )
          throw Error("Invalid consensus log chain");
        const existing = this.record(row.idx);
        if (existing && existing.hash !== row.hash) {
          if (row.idx <= this.commitIndex)
            throw Error("Attempt to replace committed consensus history");
          this.store.db
            .prepare("DELETE FROM consensus_log WHERE idx>=?")
            .run(row.idx);
        }
        this.store.db
          .prepare(
            "INSERT OR IGNORE INTO consensus_log(idx,term,hash,action) VALUES(?,?,?,?)"
          )
          .run(row.idx, row.term, row.hash, JSON.stringify(row.action));
        prior = row;
      }
      this.store.db.exec("COMMIT");
    } catch (e) {
      this.store.db.exec("ROLLBACK");
      throw e;
    }
    // Only the prefix matched by THIS RPC is proven, even if a local suffix exists.
    this.commitIndex = Math.max(
      this.commitIndex,
      Math.min(m.commit, prior.idx)
    );
    this.persist();
    this.applyCommitted();
    return { term: this.term, ok: true, matched: prior.idx };
  }
  private append(action: Action) {
    const last = this.last();
    const row: Record = {
      idx: last.idx + 1,
      term: this.term,
      action,
      hash: "",
    };
    row.hash = this.hash(last.hash, row);
    this.store.db
      .prepare(
        "INSERT INTO consensus_log(idx,term,hash,action) VALUES(?,?,?,?)"
      )
      .run(row.idx, row.term, row.hash, JSON.stringify(action));
    return row;
  }
  private replicate() {
    this.heartbeat = Date.now() + (this.options.heartbeatMs || 250);
    for (const peer of this.options.config.members) {
      if (peer.id === this.options.id || this.inFlight.has(peer.id)) continue;
      this.inFlight.add(peer.id);
      this.track(
        this.sendAppend(peer).finally(() => this.inFlight.delete(peer.id))
      );
    }
  }
  private async sendAppend(peer: Member) {
    if (!this.active || this.role !== "leader") return;
    const term = this.term,
      next = this.next.get(peer.id) || 1;
    const previous = this.record(next - 1);
    // Keep request bodies bounded even for encrypted artifacts.
    const entries: Record[] = [];
    let bytes = 0;
    for (const row of this.records(next - 1, 8)) {
      const size = Buffer.byteLength(JSON.stringify(row));
      if (entries.length && bytes + size > 1500000) break;
      entries.push(row);
      bytes += size;
    }
    let r: any;
    try {
      r = await this.rpc(peer, {
        type: "append",
        term,
        previous: previous.idx,
        previousTerm: previous.term,
        previousHash: previous.hash,
        entries,
        commit: this.commitIndex,
      });
    } catch {
      return;
    }
    if (!this.active) return;
    if (r.term > this.term) {
      this.stepDown(r.term);
      return;
    }
    if (this.role !== "leader" || this.term !== term || r.term !== term) return;
    if (!r.ok) {
      this.next.set(
        peer.id,
        Math.max(
          1,
          Math.min(
            next - 1,
            Number.isSafeInteger(r.last) ? r.last + 1 : next - 1
          )
        )
      );
      return;
    }
    const matched = previous.idx + entries.length;
    if (r.matched !== matched) return;
    this.matched.set(peer.id, matched);
    this.next.set(peer.id, matched + 1);
    const majority = [
      this.last().idx,
      ...this.options.config.members
        .filter((m) => m.id !== this.options.id)
        .map((m) => this.matched.get(m.id) || 0),
    ].sort((a, b) => b - a)[1];
    if (
      majority > this.commitIndex &&
      this.record(majority).term === this.term
    ) {
      this.commitIndex = majority;
      this.persist();
      this.applyCommitted();
      this.heartbeat = 0;
    }
  }
  private applyCommitted() {
    try {
      while (this.applied < this.commitIndex) {
        const row = this.record(this.applied + 1);
        // Each handler is idempotent. Persist the applied watermark AFTER its durable effects.
        this.apply(row.action);
        this.applied = row.idx;
        this.persist();
      }
      this.changed();
    } catch (e) {
      this.error =
        "Committed action could not be applied: " + (e as Error).message;
      throw e;
    }
  }
  async propose(action: Action, term = this.term) {
    this.assertLeader(term);
    const row = this.append(action);
    this.replicate();
    const until = Date.now() + (this.options.proposalMs || 4000);
    while (this.applied < row.idx) {
      this.assertLeader(term);
      if (Date.now() >= until) {
        // Stop accepting work after a lost majority. Uncommitted suffix may later be replaced.
        this.stepDown(this.term);
        throw new Unavailable(
          "No majority available; command outcome is unknown, retry the same signed event"
        );
      }
      await new Promise<void>((resolve) => {
        const wake = () => {
          clearTimeout(timer);
          this.waiters.delete(wake);
          resolve();
        };
        const timer = setTimeout(wake, 100);
        this.waiters.add(wake);
      });
    }
    // A later leader may have replaced our uncommitted index while we awaited the quorum.
    this.assertLeader(term);
    if (this.record(row.idx)?.hash !== row.hash)
      throw new Unavailable(
        "Command leadership changed; retry the same signed event"
      );
  }
  async barrier() {
    const term = this.assertLeader();
    await this.propose({ type: "barrier" }, term);
    return term;
  }
}
