import { readFileSync } from "fs";
import { Keypair } from "@solana/web3.js";
import { Store } from "./mesh/store";
import { Chain } from "./mesh/chain";
import { Engine } from "./mesh/engine";
import { createRelay } from "./mesh/relay";
import { demoControl, localKey } from "./mesh/demo";
async function main() {
  const demo = process.env.MESH_DEMO === "1",
    port = Number(process.env.PORT || 4173),
    host = process.env.MESH_HOST || "127.0.0.1";
  if (demo && host !== "127.0.0.1")
    throw Error("Sandbox role controls must remain loopback-only");
  const rpc = process.env.SOLANA_RPC || "http://127.0.0.1:8899";
  if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(rpc))
    throw Error("This release is restricted to a local validator");
  const sponsor = demo
    ? localKey("owner")
    : Keypair.fromSecretKey(
        Uint8Array.from(
          JSON.parse(
            readFileSync(
              process.env.MESH_SPONSOR_KEY || ".mesh/keys/sponsor.json",
              "utf8"
            )
          )
        )
      );
  const chain = new Chain(rpc, sponsor),
    store = new Store(process.env.MESH_DB || ".mesh/events.sqlite"),
    engine = new Engine(store, chain);
  await engine.recover();
  await engine.verifyHeads();
  const relay = createRelay(engine, {
    port,
    host,
    ...(demo ? { demo: demoControl("http://127.0.0.1:" + port, engine) } : {}),
  });
  await relay.start();
  const subscriptions = new Map<string, number>();
  const subscribe = () => {
    for (const job of Object.values(engine.state.jobs))
      if (!subscriptions.has(job.id)) {
        const id = chain.connection.onAccountChange(
          new (require("@solana/web3.js").PublicKey)(job.address),
          (info) => {
            try {
              const data: any = chain.program.coder.accounts.decode(
                "job",
                info.data
              );
              engine.emit("chain", {
                job: job.id,
                revision: data.revision.toNumber(),
                event: Buffer.from(data.lastEvent).toString("hex"),
                commitment: "confirmed",
              });
            } catch {}
          },
          "confirmed"
        );
        subscriptions.set(job.id, id);
      }
  };
  engine.on("event", subscribe);
  subscribe();
  let reconciling = false;
  const timer = setInterval(async () => {
    if (reconciling) return;
    reconciling = true;
    try {
      await engine.serial(() => engine.recover());
      const recent = engine.state.timeline
        .filter(
          (e) => e.receipt.signature && e.receipt.commitment !== "finalized"
        )
        .slice(-100);
      if (recent.length) {
        const statuses = await chain.connection.getSignatureStatuses(
          recent.map((e) => e.receipt.signature!),
          { searchTransactionHistory: true }
        );
        statuses.value.forEach((s, i) => {
          if (s?.confirmationStatus === "finalized") {
            const entry = recent[i];
            entry.receipt.commitment = "finalized";
            store.db
              .prepare("UPDATE events SET receipt=? WHERE id=?")
              .run(JSON.stringify(entry.receipt), entry.event.id);
            engine.emit("chain", {
              job: JSON.parse(entry.event.content).job,
              event: entry.event.id,
              commitment: "finalized",
            });
          }
        });
      }
    } catch (e) {
      console.error("Reconciliation:", (e as Error).message);
    } finally {
      reconciling = false;
    }
  }, 3000);
  console.log(`ctrl-mesh platform: http://${host}:${port}`);
  console.log(
    `Signed relay, durable journal, real localnet settlement. Sandbox roles: ${demo}`
  );
  const close = async () => {
    clearInterval(timer);
    for (const id of subscriptions.values())
      await chain.connection.removeAccountChangeListener(id);
    await relay.stop();
    store.close();
    process.exit(0);
  };
  process.on("SIGINT", close);
  process.on("SIGTERM", close);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
