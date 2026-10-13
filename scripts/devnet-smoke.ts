// Explicit Devnet integration check using the existing deterministic test-agent keys.
import { strict as assert } from "assert";
import { readFileSync, writeFileSync } from "fs";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { Chain } from "../src/mesh/chain";
import { networkConfig, inspectNetwork } from "../src/mesh/network";
import { MeshClient } from "../src/mesh/sdk";
import { createWorkPackage, verifyWorkPackage } from "../src/proof";
import { ClusterConfig } from "../src/mesh/consensus";

const loadKey = (path: string) =>
  Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(path, "utf8")))
  );
async function main() {
  const config: ClusterConfig = JSON.parse(
    readFileSync(".mesh/devnet/ha/cluster.json", "utf8")
  );
  const saved = JSON.parse(readFileSync(".mesh/devnet/network.json", "utf8"));
  const network = networkConfig({
    SOLANA_NETWORK: "devnet",
    SOLANA_RPC: process.env.SOLANA_RPC || saved.rpc,
  });
  const deployer = loadKey(".mesh/devnet/deployer.json"),
    chain = new Chain(network.rpc, deployer);
  const info = await inspectNetwork(
    chain.connection,
    network,
    chain.program.programId
  );
  assert.equal(info.genesis, config.genesis);
  assert.equal(info.program, config.program);
  const roles = [
    "owner",
    "manager",
    "reviewer",
    "vendor-a",
    "worker-a",
    "vendor-b",
    "worker-b",
  ];
  const keys = Object.fromEntries(
    roles.map((role) => [role, loadKey(`.mesh/keys/${role}.json`)])
  );
  const clients = Object.fromEntries(
    roles.map((role) => [
      role,
      new MeshClient(config.members[0].url, keys[role], {
        replicas: config.members.slice(1).map((m) => m.url),
        stream: config.stream,
        requestMs: 20000,
        failoverMs: 60000,
      }),
    ])
  );
  const project =
      process.env.MESH_VERIFY_PROJECT || "devnet-check-" + Date.now(),
    job = project + "-delivery";
  const receipts: any[] = [],
    now = () => Math.floor(Date.now() / 1000);
  const publish = async (role: string, action: string, data: any = {}) => {
    const entry = await clients[role].publish({
      action,
      project,
      job,
      ...data,
    });
    receipts.push({
      action,
      event: entry.event.id,
      signature: entry.receipt.signature,
    });
    console.log(`${action}: ${entry.receipt.signature || entry.event.id}`);
    return entry;
  };
  const snapshot = async () =>
    (await clients.manager.context({ project })).jobs.find(
      (j: any) => j.id === job
    );
  const context = await clients.owner.context();
  const existing = context.projects.find((p: any) => p.id === project);
  if (existing) {
    const history = (await clients.owner.updates()).entries;
    for (const entry of history) {
      const command = JSON.parse(entry.event.content);
      if (command.project === project)
        receipts.push({
          action: command.action,
          event: entry.event.id,
          signature: entry.receipt.signature,
        });
    }
  }
  for (const role of ["manager", "reviewer", "worker-a", "worker-b"])
    assert(
      context.agents.some(
        (agent: any) => agent.key === keys[role].publicKey.toBase58()
      ),
      `Missing imported test agent ${role}`
    );
  const balance = await chain.connection.getBalance(keys.owner.publicKey);
  if (!existing && balance < 30_000_000)
    await sendAndConfirmTransaction(
      chain.connection,
      new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: deployer.publicKey,
          toPubkey: keys.owner.publicKey,
          lamports: 30_000_000 - balance,
        })
      ),
      [deployer],
      { commitment: "confirmed" }
    );
  if (!existing)
    await publish("owner", "project.create", {
      title: "Devnet integration verification",
      brief:
        "Deterministic test of two provider agents, independent review and onchain payments.",
      manager: keys.manager.publicKey.toBase58(),
      reviewer: keys.reviewer.publicKey.toBase58(),
      amount: 20_000_000,
      allowance: 10_000_000,
      expires: now() + 3600,
    });
  if (!(await snapshot()))
    await publish("manager", "job.open", {
      title: "Verify Devnet settlement",
      brief:
        "Two signed test artifacts; independent reviewer checks both before payout.",
      skills: ["typescript"],
      budget: 5_000_000,
      deadline: now() + 1800,
      dependencies: [],
      public: true,
    });
  for (const [role, amount] of [
    ["worker-a", 3_000_000],
    ["worker-b", 2_000_000],
  ] as const) {
    if (
      (await snapshot()).members.some(
        (m: any) => m.worker === keys[role].publicKey.toBase58()
      )
    )
      continue;
    const offer = await publish(role, "offer.publish", {
      amount,
      message: "Deterministic Devnet integration artifact",
    });
    await publish("manager", "job.award", {
      offerId: offer.event.id,
      revision: (await snapshot()).revision,
      leaseUntil: now() + 1200,
    });
  }
  let failedNode: string | undefined = process.env.MESH_VERIFY_FAILED_NODE,
    replacement: string | undefined;
  for (const role of ["worker-a", "worker-b"]) {
    const member = (await snapshot()).members.find(
      (m: any) => m.worker === keys[role].publicKey.toBase58()
    );
    if (member.hash !== "0".repeat(64)) continue;
    const files = [
      {
        path: role + ".txt",
        content: Buffer.from("Devnet verification by " + role),
      },
    ];
    const pkg = createWorkPackage(project + "/" + job, keys[role], files);
    assert(verifyWorkPackage(pkg, files));
    await publish(role, "job.submit", {
      revision: (await snapshot()).revision,
      package: pkg,
      files: files.map((f) => ({
        path: f.path,
        base64: f.content.toString("base64"),
      })),
    });
    if (role === "worker-a" && process.argv.includes("--failover")) {
      const run = JSON.parse(readFileSync(".mesh/devnet/run.json", "utf8"));
      assert.equal(run.cluster, config.cluster);
      for (const member of config.members) {
        const health: any = await (
          await fetch(member.url + "/api/health")
        ).json();
        if (!health.ha?.writable) continue;
        assert.equal(health.network, "devnet");
        const pid = run.pids[member.id];
        assert(Number.isInteger(pid) && pid > 1);
        failedNode = member.id;
        process.kill(pid, "SIGTERM");
        console.log(
          `Stopped Devnet coordinator ${member.id} after first result; SDK will use the surviving majority.`
        );
        break;
      }
      assert(failedNode, "No writable coordinator found for failover check");
    }
  }
  const task = await snapshot();
  assert.equal(task.state, "review");
  assert.equal(task.members.length, 2);
  for (const record of Object.values(task.packages) as any[])
    assert(
      verifyWorkPackage(
        record.package,
        record.files.map((f: any) => ({
          path: f.path,
          content: Buffer.from(f.base64, "base64"),
        }))
      )
    );
  await publish("reviewer", "job.review", {
    revision: task.revision,
    root: task.root,
    approved: true,
    comment: "Verified both signed deterministic test artifacts.",
  });
  await publish("manager", "job.accept", {
    revision: (await snapshot()).revision,
    root: task.root,
  });
  const balances = await chain.connection.getMultipleAccountsInfo([
    keys["vendor-a"].publicKey,
    keys["vendor-b"].publicKey,
  ]);
  for (const role of ["worker-a", "worker-b"])
    await publish(role, "job.claim", { revision: (await snapshot()).revision });
  const after = await chain.connection.getMultipleAccountsInfo([
    keys["vendor-a"].publicKey,
    keys["vendor-b"].publicKey,
  ]);
  const payouts = after.map(
    (a, i) => (a?.lamports || 0) - (balances[i]?.lamports || 0)
  );
  assert.deepEqual(payouts, [3_000_000, 2_000_000]);
  const settled = await snapshot();
  assert(settled.members.every((m: any) => m.paid));
  const account: any = await (chain.program.account as any).job.fetch(
    new PublicKey(settled.address)
  );
  assert(account.members.slice(0, 2).every((m: any) => m.paid));
  const current = (await clients.owner.context({ project })).projects.find(
    (p: any) => p.id === project
  );
  if (current.balance > 0)
    await publish("owner", "project.withdraw", {
      revision: current.revision,
      amount: current.balance,
    });
  const healths = [];
  for (const member of config.members) {
    try {
      const health: any = await (
        await fetch(member.url + "/api/health", {
          signal: AbortSignal.timeout(2000),
        })
      ).json();
      healths.push({
        node: member.id,
        network: health.network,
        genesis: health.solana.genesis,
        events: health.events,
        hash: health.federation.hash,
        pending: health.pending,
        writable: health.ha.writable,
      });
      if (health.ha.writable) replacement = member.id;
    } catch {
      healths.push({ node: member.id, available: false });
    }
  }
  if (failedNode) assert(replacement && replacement !== failedNode);
  const report = {
    project,
    projectAddress: current.address,
    job,
    jobAddress: settled.address,
    network: info.network,
    genesis: info.genesis,
    program: info.program,
    payoutsLamports: payouts,
    failedNode,
    replacement,
    receipts,
    nodes: healths,
  };
  writeFileSync(
    ".mesh/devnet/verification.json",
    JSON.stringify(report, null, 2) + "\n",
    { mode: 0o600 }
  );
  console.log(JSON.stringify(report, null, 2));
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
