import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "fs";
import { dirname } from "path";
import { Entry, MeshEvent, Receipt } from "./events";
import { canonical, digest } from "./events";
import { randomUUID } from "crypto";
export const EMPTY_HASH = "0".repeat(64);
// Finality may advance without changing the immutable journal identity.
export function journalHash(previous: string, entry: Entry) {
  const { commitment, ...receipt } = entry.receipt;
  return digest(canonical([previous, entry.seq, entry.event.id, receipt]));
}
export class Store {
  db: DatabaseSync;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,event TEXT NOT NULL,receipt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS commands(id TEXT PRIMARY KEY,event TEXT NOT NULL,transaction_bytes TEXT,signature TEXT,status TEXT NOT NULL,receipt TEXT);
      CREATE TABLE IF NOT EXISTS cursors(name TEXT PRIMARY KEY,seq INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS journal(seq INTEGER PRIMARY KEY,hash TEXT NOT NULL);
    `);
    if (!this.meta("stream")) this.setMeta("stream", randomUUID());
    // Backfill existing journals without changing events or their sequence numbers.
    try {
      let previous = EMPTY_HASH;
      for (const entry of this.entries()) {
        const hash = journalHash(previous, entry);
        const saved = this.hash(entry.seq);
        if (saved && saved !== hash)
          throw Error("Local journal integrity mismatch");
        this.db
          .prepare("INSERT OR IGNORE INTO journal(seq,hash) VALUES(?,?)")
          .run(entry.seq, hash);
        previous = hash;
      }
      if (
        (this.db.prepare("SELECT COUNT(*) AS n FROM journal").get() as any)
          .n !==
        (this.db.prepare("SELECT COUNT(*) AS n FROM events").get() as any).n
      )
        throw Error("Local journal integrity mismatch: deleted events");
    } catch (e) {
      this.db.close();
      throw e;
    }
  }
  meta(key: string): string | undefined {
    return (
      this.db.prepare("SELECT value FROM metadata WHERE key=?").get(key) as any
    )?.value;
  }
  setMeta(key: string, value: string) {
    this.db
      .prepare(
        "INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
      )
      .run(key, value);
  }
  head(): number {
    return Number(
      (
        this.db
          .prepare("SELECT COALESCE(MAX(seq),0) AS seq FROM events")
          .get() as any
      ).seq
    );
  }
  hash(seq = this.head()): string | undefined {
    if (seq === 0) return EMPTY_HASH;
    return (
      this.db.prepare("SELECT hash FROM journal WHERE seq=?").get(seq) as any
    )?.hash;
  }
  entries(after = 0, limit = Number.MAX_SAFE_INTEGER): Entry[] {
    return (
      this.db
        .prepare(
          "SELECT seq,event,receipt FROM events WHERE seq>? ORDER BY seq LIMIT ?"
        )
        .all(after, limit) as any[]
    ).map((r) => ({
      seq: r.seq,
      event: JSON.parse(r.event),
      receipt: JSON.parse(r.receipt),
    }));
  }
  get(id: string): Entry | undefined {
    const r = this.db
      .prepare("SELECT seq,event,receipt FROM events WHERE id=?")
      .get(id) as any;
    return r
      ? {
          seq: r.seq,
          event: JSON.parse(r.event),
          receipt: JSON.parse(r.receipt),
        }
      : undefined;
  }
  append(event: MeshEvent, receipt: Receipt): Entry {
    const prior = this.get(event.id);
    if (prior) return prior;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const previous = this.hash()!;
      this.db
        .prepare("INSERT OR IGNORE INTO events(id,event,receipt) VALUES(?,?,?)")
        .run(event.id, JSON.stringify(event), JSON.stringify(receipt));
      const entry = this.get(event.id)!;
      this.db
        .prepare("INSERT INTO journal(seq,hash) VALUES(?,?)")
        .run(entry.seq, journalHash(previous, entry));
      this.db
        .prepare("UPDATE commands SET status='committed',receipt=? WHERE id=?")
        .run(JSON.stringify(receipt), event.id);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return this.get(event.id)!;
  }
  saveCommand(event: MeshEvent, transaction: string, signature: string) {
    this.db
      .prepare(
        "INSERT INTO commands(id,event,transaction_bytes,signature,status) VALUES(?,?,?,?,'pending') ON CONFLICT(id) DO UPDATE SET transaction_bytes=excluded.transaction_bytes,signature=excluded.signature,status='pending'"
      )
      .run(event.id, JSON.stringify(event), transaction, signature);
  }
  pending(): any[] {
    return this.db
      .prepare("SELECT * FROM commands WHERE status='pending'")
      .all() as any[];
  }
  fail(id: string) {
    this.db.prepare("UPDATE commands SET status='failed' WHERE id=?").run(id);
  }
  close() {
    this.db.close();
  }
}
