import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "fs";
import { dirname } from "path";
import { Entry, MeshEvent, Receipt } from "./events";
export class Store {
  db: DatabaseSync;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,event TEXT NOT NULL,receipt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS commands(id TEXT PRIMARY KEY,event TEXT NOT NULL,transaction_bytes TEXT,signature TEXT,status TEXT NOT NULL,receipt TEXT);
      CREATE TABLE IF NOT EXISTS cursors(name TEXT PRIMARY KEY,seq INTEGER NOT NULL);
    `);
  }
  entries(after = 0): Entry[] {
    return (
      this.db
        .prepare(
          "SELECT seq,event,receipt FROM events WHERE seq>? ORDER BY seq"
        )
        .all(after) as any[]
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
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare("INSERT OR IGNORE INTO events(id,event,receipt) VALUES(?,?,?)")
        .run(event.id, JSON.stringify(event), JSON.stringify(receipt));
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
