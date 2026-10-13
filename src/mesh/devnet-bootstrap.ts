import { DatabaseSync } from "node:sqlite";
import { mkdirSync, renameSync, rmSync, writeFileSync, existsSync } from "fs";
import { dirname } from "path";
import { randomBytes, randomUUID } from "crypto";
import { ClusterConfig, Member } from "./consensus";
import { Store } from "./store";
import { MeshEvent, verifyEvent } from "./events";
import { NetworkInfo, pinNetwork } from "./network";
import { State } from "./state";

/** Carry identities across networks; chain history and login sessions stay in Localnet. */
export function bootstrapDevnet(
  directory: string,
  info: NetworkInfo,
  members: Member[],
  identitySource?: string
) {
  if (info.network !== "devnet")
    throw Error("Devnet bootstrap requires Devnet");
  if (existsSync(directory + "/cluster.json"))
    throw Error("Devnet cluster already exists; bootstrap never resets it");
  const staging = directory + "-bootstrap-" + randomUUID();
  mkdirSync(dirname(directory), { recursive: true, mode: 0o700 });
  mkdirSync(staging, { mode: 0o700 });
  let seed: Store | undefined;
  try {
    seed = new Store(staging + "/seed.sqlite");
    pinNetwork(seed, info);
    let accounts = 0,
      agents = 0;
    if (identitySource) {
      const source = new DatabaseSync(identitySource, { readOnly: true });
      try {
        source.exec("BEGIN");
        const pending = (
          source
            .prepare(
              "SELECT COUNT(*) AS n FROM commands WHERE status='pending'"
            )
            .get() as any
        ).n;
        if (pending)
          throw Error(
            "Reconcile pending Localnet commands before importing identities"
          );
        const rows = source
          .prepare(
            "SELECT id,email,password,verified,wallet,created FROM accounts ORDER BY id"
          )
          .all() as any[];
        const insert = seed.db.prepare(
          "INSERT INTO accounts(id,email,password,verified,wallet,created) VALUES(?,?,?,?,?,?)"
        );
        for (const row of rows) {
          insert.run(
            row.id,
            row.email,
            row.password,
            row.verified,
            row.wallet,
            row.created
          );
          accounts++;
        }
        const insertWallet = seed.db.prepare(
          "INSERT OR IGNORE INTO account_wallets(wallet,account_id,created) VALUES(?,?,?)"
        );
        // Older identity sources only have accounts.wallet.
        for (const row of rows)
          if (row.wallet) insertWallet.run(row.wallet, row.id, row.created);
        if (
          source
            .prepare(
              "SELECT name FROM sqlite_master WHERE type='table' AND name='account_wallets'"
            )
            .get()
        )
          for (const row of source
            .prepare("SELECT wallet,account_id,created FROM account_wallets")
            .all() as any[])
            insertWallet.run(row.wallet, row.account_id, row.created);
        const state = new State();
        for (const row of source
          .prepare("SELECT event FROM events ORDER BY seq")
          .all() as any[]) {
          const event = JSON.parse(row.event) as MeshEvent;
          if (JSON.parse(event.content).action !== "agent.register") continue;
          verifyEvent(event);
          state.validate(event, event.created_at);
          state.apply(seed.append(event, {}));
          agents++;
        }
        source.exec("COMMIT");
      } finally {
        source.close();
      }
    }
    const config: ClusterConfig = {
      cluster: randomUUID(),
      stream: seed.meta("stream")!,
      genesis: info.genesis,
      program: info.program,
      baseHead: seed.head(),
      baseHash: seed.hash()!,
      members,
    };
    for (const member of members)
      seed.db.prepare("VACUUM INTO ?").run(`${staging}/${member.id}.sqlite`);
    seed.close();
    seed = undefined;
    for (const suffix of ["", "-wal", "-shm"])
      rmSync(staging + "/seed.sqlite" + suffix, { force: true });
    writeFileSync(
      staging + "/cluster.json",
      JSON.stringify(config, null, 2) + "\n",
      { mode: 0o600, flag: "wx" }
    );
    writeFileSync(staging + "/peer.token", randomBytes(32).toString("hex"), {
      mode: 0o600,
      flag: "wx",
    });
    writeFileSync(
      staging + "/bootstrap.json",
      JSON.stringify(
        { accounts, agents, chainEvents: 0, sessions: 0 },
        null,
        2
      ) + "\n",
      { mode: 0o600 }
    );
    renameSync(staging, directory);
    return { config, accounts, agents };
  } catch (e) {
    seed?.close();
    rmSync(staging, { recursive: true, force: true });
    throw e;
  }
}
