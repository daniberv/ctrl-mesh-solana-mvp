import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  renameSync,
} from "fs";
import { randomBytes, randomUUID } from "crypto";
import { createServer } from "net";
import { Store } from "../src/mesh/store";
import { Chain } from "../src/mesh/chain";
import { Engine } from "../src/mesh/engine";
import { ClusterConfig } from "../src/mesh/consensus";
import { localKey } from "../src/mesh/demo";
import { SystemProgram, Transaction } from "@solana/web3.js";

async function main() {
  if (existsSync(".mesh/ha/cluster.json")) {
    console.log(
      "HA is already initialized. Start yarn ha:demo; bootstrap never resets an existing cluster."
    );
    return;
  }
  for (const port of [4173, 4174, 4175])
    await new Promise<void>((resolve, reject) => {
      const probe = createServer();
      probe.once("error", () =>
        reject(Error(`Stop the relay on port ${port} before migrating`))
      );
      probe.listen(port, "127.0.0.1", () => probe.close(() => resolve()));
    });
  if (!existsSync(".mesh/events.sqlite"))
    throw Error("Create a standalone sandbox journal first");
  const store = new Store(".mesh/events.sqlite");
  try {
    const resume = store.meta("ha.staging");
    if (
      store.meta("ha.retired") &&
      resume &&
      /^\.mesh\/ha-bootstrap-[0-9a-f-]+$/.test(resume)
    ) {
      const prepared = JSON.parse(
        readFileSync(resume + "/cluster.json", "utf8")
      );
      if (prepared.cluster !== store.meta("ha.retired"))
        throw Error("Interrupted migration identity mismatch");
      renameSync(resume, ".mesh/ha");
      console.log(
        "Completed the interrupted HA migration. Start yarn ha:demo."
      );
      return;
    }
    const chain = new Chain("http://127.0.0.1:8899", localKey("owner"));
    const engine = new Engine(store, chain);
    if (store.pending().length)
      throw Error(
        "Reconcile pending commands on the old coordinator before migration"
      );
    await engine.verifyHeads();
    const genesis = await chain.connection.getGenesisHash();
    if (store.meta("genesis") && store.meta("genesis") !== genesis)
      throw Error("Existing journal belongs to another validator");
    store.setMeta("genesis", genesis);
    const stamp = new Date().toISOString().replace(/[^0-9TZ]/g, "");
    const backup = `.mesh-backups/pre-ha-${stamp}`;
    mkdirSync(backup, { recursive: true, mode: 0o700 });
    store.db.prepare("VACUUM INTO ?").run(backup + "/events.sqlite");
    const staging = `.mesh/ha-bootstrap-${randomUUID()}`;
    mkdirSync(staging, { mode: 0o700 });
    const members = ["a", "b", "c"].map((id, i) => ({
      id,
      url: `http://127.0.0.1:${4173 + i}`,
    }));
    const config: ClusterConfig = {
      cluster: randomUUID(),
      stream: store.meta("stream")!,
      genesis,
      program: chain.program.programId.toBase58(),
      baseHead: store.head(),
      baseHash: store.hash()!,
      members,
    };
    // Each candidate pays its own transaction fees. Project and worker signing keys are not copied.
    for (const member of members) {
      const sponsor = localKey(`ha-${member.id}-sponsor`);
      if ((await chain.connection.getBalance(sponsor.publicKey)) < 50000000) {
        const tx = new Transaction().add(
          SystemProgram.transfer({
            fromPubkey: chain.sponsor.publicKey,
            toPubkey: sponsor.publicKey,
            lamports: 100000000,
          })
        );
        await chain.program.provider.sendAndConfirm!(tx);
      }
      store.db.prepare("VACUUM INTO ?").run(`${staging}/${member.id}.sqlite`);
    }
    writeFileSync(
      staging + "/cluster.json",
      JSON.stringify(config, null, 2) + "\n",
      { mode: 0o600, flag: "wx" }
    );
    writeFileSync(staging + "/peer.token", randomBytes(32).toString("hex"), {
      mode: 0o600,
      flag: "wx",
    });
    // Persist a fence so the previous standalone process cannot re-enter this stream.
    store.setMeta("ha.staging", staging);
    store.setMeta("ha.retired", config.cluster);
    if (existsSync(".mesh/replica.sqlite")) {
      const replica = new Store(".mesh/replica.sqlite");
      replica.setMeta("ha.retired", config.cluster);
      replica.close();
    }
    renameSync(staging, ".mesh/ha");
    console.log(
      JSON.stringify(
        {
          migratedEvents: config.baseHead,
          stream: config.stream,
          backup,
          members,
        },
        null,
        2
      )
    );
  } finally {
    store.close();
  }
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
