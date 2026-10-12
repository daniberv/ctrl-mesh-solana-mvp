import { existsSync, readFileSync, writeFileSync } from "fs";
import { randomBytes } from "crypto";
import { Keypair } from "@solana/web3.js";
import { Store } from "./mesh/store";
import { Chain } from "./mesh/chain";
import { Engine } from "./mesh/engine";
import { createRelay } from "./mesh/relay";
import { demoControl, localKey } from "./mesh/demo";
import { Federation } from "./mesh/federation";
import { ClusterConfig, Consensus } from "./mesh/consensus";
import { lockDatabase } from "./mesh/process-lock";
async function main() {
  const haConfig: ClusterConfig | undefined = process.env.MESH_HA_CONFIG
    ? JSON.parse(readFileSync(process.env.MESH_HA_CONFIG, "utf8"))
    : undefined;
  const haNode = process.env.MESH_HA_NODE || "";
  if (haConfig && !haConfig.members.some((m) => m.id === haNode))
    throw Error("Select a configured HA node");
  const demo = process.env.MESH_DEMO === "1",
    port = Number(process.env.PORT || 4173),
    host = process.env.MESH_HOST || "127.0.0.1";
  if (demo && host !== "127.0.0.1")
    throw Error("Sandbox role controls must remain loopback-only");
  const rpc = process.env.SOLANA_RPC || "http://127.0.0.1:8899";
  if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(rpc))
    throw Error("This release is restricted to a local validator");
  const replica = !!process.env.MESH_UPSTREAM;
  if (haConfig && replica)
    throw Error("HA voters cannot also pull a legacy upstream");
  if (replica && demo)
    throw Error("Replica cannot host sandbox signing controls");
  const sponsor = replica
    ? Keypair.generate()
    : demo && !haConfig
    ? localKey("owner")
    : Keypair.fromSecretKey(
        Uint8Array.from(
          JSON.parse(
            readFileSync(
              process.env.MESH_SPONSOR_KEY ||
                (haConfig
                  ? `.mesh/keys/ha-${haNode}-sponsor.json`
                  : ".mesh/keys/sponsor.json"),
              "utf8"
            )
          )
        )
      );
  const dbPath =
    process.env.MESH_DB ||
    (replica ? ".mesh/replica.sqlite" : ".mesh/events.sqlite");
  const unlock = haConfig ? lockDatabase(dbPath) : undefined;
  process.once("exit", () => unlock?.());
  const chain = new Chain(rpc, sponsor),
    store = new Store(dbPath),
    engine = new Engine(store, chain, replica, !!haConfig);
  if (haConfig) {
    if (
      (await chain.connection.getGenesisHash()) !== haConfig.genesis ||
      chain.program.programId.toBase58() !== haConfig.program
    )
      throw Error("HA cluster uses a different Solana network or program");
    engine.consensus = new Consensus(
      store,
      {
        id: haNode,
        config: haConfig,
        token: readFileSync(
          process.env.MESH_HA_TOKEN_FILE || ".mesh/ha/peer.token",
          "utf8"
        ).trim(),
      },
      (action) => engine.applyConsensus(action)
    );
  }
  if (!replica && !haConfig) {
    await engine.recover();
    await engine.verifyHeads();
  }
  let replicationToken = process.env.MESH_REPLICATION_TOKEN;
  if (demo && !replicationToken) {
    const path = ".mesh/replication.token";
    if (!existsSync(path))
      writeFileSync(path, randomBytes(32).toString("hex"), {
        mode: 0o600,
        flag: "wx",
      });
    replicationToken = readFileSync(path, "utf8").trim();
  }
  const federation = new Federation(engine, {
    identity: process.env.MESH_RELAY_KEY
      ? Keypair.fromSecretKey(
          Uint8Array.from(
            JSON.parse(readFileSync(process.env.MESH_RELAY_KEY, "utf8"))
          )
        )
      : localKey(
          haConfig ? `relay-ha-${haNode}` : replica ? "relay-replica" : "relay"
        ),
    token: replicationToken,
    ...(replica
      ? {
          upstream: {
            url: process.env.MESH_UPSTREAM!,
            publicKey: process.env.MESH_UPSTREAM_KEY || "",
            token: process.env.MESH_UPSTREAM_TOKEN || "",
          },
        }
      : {}),
  });
  await federation.initialize();
  const relay = createRelay(engine, {
    port,
    host,
    federation,
    ...(demo
      ? {
          demo: demoControl(
            "http://127.0.0.1:" + port,
            engine,
            haConfig?.members.map((m) => m.url)
          ),
        }
      : {}),
  });
  await relay.start();
  engine.consensus?.start();
  federation.start();
  const subscriptions = new Map<string, number>();
  const subscribe = () => {
    if (replica) return;
    if (engine.consensus && !engine.consensus.writable) return;
    for (const job of Object.values(engine.state.jobs))
      if (!subscriptions.has(job.id)) {
        const id = chain.connection.onAccountChange(
          new (require("@solana/web3.js").PublicKey)(job.address),
          (info) => {
            if (engine.consensus && !engine.consensus.writable) return;
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
  engine.consensus?.on("change", subscribe);
  subscribe();
  let reconciling = false;
  const timer = setInterval(async () => {
    if (replica) return;
    if (engine.consensus && !engine.consensus.writable) return;
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
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    clearInterval(timer);
    await engine.consensus?.stop();
    await federation.stop();
    await relay.stop();
    await Promise.race([
      Promise.allSettled(
        [...subscriptions.values()].map((id) =>
          chain.connection.removeAccountChangeListener(id)
        )
      ),
      new Promise((resolve) => setTimeout(resolve, 2000)),
    ]);
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
