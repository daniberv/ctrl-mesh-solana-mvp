import nacl from "tweetnacl";
import * as anchor from "@coral-xyz/anchor";
import {
  Keypair,
  Transaction,
  LAMPORTS_PER_SOL,
  SystemProgram,
} from "@solana/web3.js";
import { strict as assert } from "assert";
import bs58 from "bs58";
import { spawn } from "child_process";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { verifyPreparedTransaction } from "../src/mesh/transaction";
import { Chain } from "../src/mesh/chain";
import { Store } from "../src/mesh/store";
import { Engine } from "../src/mesh/engine";
import { MeshClient } from "../src/mesh/sdk";
import { createRelay } from "../src/mesh/relay";
import { signEvent, verifyEvent } from "../src/mesh/events";
import { createWorkPackage } from "../src/proof";

describe("multi-owner mesh platform", function () {
  this.timeout(180000);
  const provider = anchor.AnchorProvider.env();
  const sponsor = (provider.wallet as anchor.Wallet).payer;
  const owner = Keypair.generate(),
    manager = Keypair.generate(),
    reviewer = Keypair.generate(),
    vendorA = Keypair.generate(),
    vendorB = Keypair.generate(),
    workerA = Keypair.generate(),
    workerB = Keypair.generate(),
    outsider = Keypair.generate();
  let chain: Chain,
    store: Store,
    engine: Engine,
    relay: ReturnType<typeof createRelay>;
  const clients = new Map<Keypair, MeshClient>();
  const project = "mesh-" + Date.now(),
    job = "shared-delivery";
  let path: string;
  const now = () => Math.floor(Date.now() / 1000);
  const client = (key: Keypair) => {
    if (!clients.has(key))
      clients.set(key, new MeshClient("http://127.0.0.1:4191", key));
    return clients.get(key)!;
  };
  const command = (key: Keypair, action: string, data: any = {}) =>
    client(key).publish({ action, project, job, ...data });
  const rev = () => engine.state.jobs[job].revision;
  const submit = (key: Keypair, text: string) => {
    const files = [{ path: "deliverable.txt", content: Buffer.from(text) }];
    return command(key, "job.submit", {
      revision: rev(),
      package: createWorkPackage(project + "/" + job, key, files),
      files: files.map((f) => ({
        path: f.path,
        base64: f.content.toString("base64"),
      })),
    });
  };
  before(async () => {
    await provider.sendAndConfirm(
      new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: sponsor.publicKey,
          toPubkey: owner.publicKey,
          lamports: LAMPORTS_PER_SOL,
        })
      )
    );
    path = join(mkdtempSync(join(tmpdir(), "mesh-test-")), "events.sqlite");
    chain = new Chain(provider.connection.rpcEndpoint, sponsor);
    store = new Store(path);
    engine = new Engine(store, chain);
    relay = createRelay(engine, { port: 4191 });
    await relay.start();
    for (const [key, worker, name] of [
      [owner, manager, "Planner"],
      [owner, reviewer, "Reviewer"],
      [vendorA, workerA, "Vendor A"],
      [vendorB, workerB, "Vendor B"],
    ] as const)
      await client(key).publish({
        action: "agent.register",
        agent: worker.publicKey.toBase58(),
        name,
        description: name + " agent",
        skills: ["typescript"],
        rate: 1000000,
        binding: Buffer.from(
          nacl.sign.detached(
            Buffer.from("ctrl-mesh:agent-owner:v1:" + key.publicKey.toBase58()),
            worker.secretKey
          )
        ).toString("hex"),
      });
    await client(owner).publish({
      action: "project.create",
      project,
      title: "Cross-owner collaboration",
      brief: "Shared project",
      manager: manager.publicKey.toBase58(),
      reviewer: reviewer.publicKey.toBase58(),
      amount: 100000000,
      allowance: 50000000,
      expires: now() + 3600,
    });
  });
  after(async () => {
    await relay?.stop();
    store?.close();
  });
  it("enforces owner-scoped agent identities and rejects forged events", async () => {
    await assert.rejects(
      client(outsider).publish({
        action: "agent.register",
        agent: workerA.publicKey.toBase58(),
        name: "Hijacked",
        description: "Bad",
        skills: [],
        rate: 1,
      }),
      /ownership proof|another owner/
    );
    const bad = signEvent(workerA, {
      action: "progress",
      project,
      job,
      message: "hello",
    });
    bad.content = bad.content.replace("hello", "false");
    assert.throws(() => verifyEvent(bad), /signature/);
  });
  it("delegates a capped budget and accepts signed bids from two independent owners", async () => {
    await command(manager, "job.open", {
      title: "Shared delivery",
      brief: "Build the module",
      skills: ["typescript"],
      budget: 20000000,
      deadline: now() + 1800,
      dependencies: [],
      public: true,
    });
    await assert.rejects(
      command(manager, "job.open", {
        job: "over-budget",
        title: "Too expensive",
        brief: "No",
        skills: [],
        budget: 40000000,
        deadline: now() + 1000,
        dependencies: [],
        public: true,
      }),
      /budget/
    );
    const a = await command(workerA, "offer.publish", {
      amount: 11000000,
      message: "API implementation",
    });
    const b = await command(workerB, "offer.publish", {
      amount: 9000000,
      message: "UI implementation",
    });
    await command(manager, "job.award", {
      offerId: a.event.id,
      leaseUntil: now() + 1200,
      revision: rev(),
    });
    await command(manager, "job.award", {
      offerId: b.event.id,
      leaseUntil: now() + 1200,
      revision: rev(),
    });
    assert.equal(engine.state.jobs[job].members.length, 2);
    assert.equal(
      engine.state.jobs[job].members[0].recipient,
      vendorA.publicKey.toBase58()
    );
    const context = await client(workerA).context();
    assert.equal(context.jobs.length, 1);
    assert.equal(context.projects.length, 0);
    assert.equal((await client(outsider).context()).jobs.length, 0);
    const narrow = await client(workerA).context({
      project,
      job,
      artifacts: false,
    });
    assert.equal(narrow.jobs.length, 1);
    assert(narrow.signingProjects.some((p: any) => p.id === project));
  });
  it("verifies signed provider quotes before a coordinator signs a hire", async () => {
    const offer = Object.values(engine.state.offers)[0];
    const event = signEvent(manager, {
      action: "job.award",
      project,
      job,
      offerId: offer.id,
      leaseUntil: now() + 1300,
      revision: rev(),
    });
    const tx = (await chain.prepare(event, engine.state))!;
    const context = await client(manager).context();
    await verifyPreparedTransaction(event, tx, context);
    context.offers[0].amount += 1;
    await assert.rejects(
      verifyPreparedTransaction(event, tx, context),
      /offer context was altered/
    );
  });
  it("rejects transaction substitution and stale concurrent commands", async () => {
    const event = signEvent(workerA, {
      action: "job.renew",
      project,
      job,
      revision: rev(),
      leaseUntil: now() + 1300,
    });
    const prepared = await engine.prepare(event);
    const tx = Transaction.from(Buffer.from(prepared.transaction!, "base64"));
    await verifyPreparedTransaction(event, tx, await client(workerA).context());
    tx.add(
      SystemProgram.transfer({
        fromPubkey: sponsor.publicKey,
        toPubkey: outsider.publicKey,
        lamports: 1,
      })
    );
    tx.partialSign(workerA);
    await assert.rejects(
      verifyPreparedTransaction(event, tx, await client(workerA).context()),
      /Unexpected|differs/
    );
    await assert.rejects(
      engine.commit(
        event,
        tx.serialize({ requireAllSignatures: false }).toString("base64")
      ),
      /differs/
    );
    const stale = rev();
    await submit(workerA, "API v1");
    await assert.rejects(
      command(workerB, "job.renew", {
        revision: stale,
        leaseUntil: now() + 1300,
      }),
      /Stale/
    );
  });
  it("streams updates, replays missed events, and does not leak private tasks", async () => {
    const entries: string[] = [];
    let ready!: () => void;
    const synced = new Promise<void>((r) => (ready = r));
    const watch = await client(workerB).watch((e) => entries.push(e.event.id), {
      project,
      cursor: 0,
      onReady: () => ready(),
    });
    await synced;
    const update = await command(workerA, "progress", {
      message: "API ready for integration",
    });
    await new Promise((r) => setTimeout(r, 100));
    assert(entries.includes(update.event.id));
    const cursor = watch.cursor();
    watch.close();
    const offline = await command(workerA, "progress", {
      message: "Schema changed while peer offline",
    });
    const replay: string[] = [];
    let resumed!: () => void;
    const sync = new Promise<void>((r) => (resumed = r));
    const back = await client(workerB).watch((e) => replay.push(e.event.id), {
      cursor,
      onReady: () => resumed(),
    });
    await sync;
    back.close();
    assert.deepEqual(replay, [offline.event.id]);
    await command(manager, "job.open", {
      job: "private-work",
      title: "Private work",
      brief: "Private secret",
      skills: [],
      budget: 1000000,
      deadline: now() + 1000,
      dependencies: [],
      public: false,
    });
    assert(
      !(await client(workerA).context()).jobs.some(
        (j: any) => j.id === "private-work"
      )
    );
    assert(
      !(await client(workerA).market()).jobs.some(
        (j: any) => j.id === "private-work"
      )
    );
  });
  it("reviews exact multi-author result versions and pays each provider only once", async () => {
    await submit(workerB, "UI v1");
    let j = engine.state.jobs[job];
    assert.equal(j.state, "review");
    const oldRoot = j.root;
    await command(reviewer, "job.review", {
      root: oldRoot,
      approved: false,
      comment: "Change API schema",
      revision: rev(),
    });
    assert.equal(engine.state.jobs[job].state, "changes_requested");
    await submit(workerA, "API v2");
    j = engine.state.jobs[job];
    assert.notEqual(j.root, oldRoot);
    await assert.rejects(
      command(manager, "job.accept", { root: oldRoot, revision: rev() }),
      /version/
    );
    await assert.rejects(
      command(workerA, "job.review", {
        root: j.root,
        approved: true,
        comment: "Self review",
        revision: rev(),
      }),
      /Reviewer/
    );
    await command(reviewer, "job.review", {
      root: j.root,
      approved: true,
      comment: "Verified API and UI",
      revision: rev(),
    });
    const approvedRoot = j.root;
    await submit(workerB, "UI v2");
    j = engine.state.jobs[job];
    assert.notEqual(j.root, approvedRoot);
    assert.equal(j.reviewRoot, "0".repeat(64));
    await assert.rejects(
      command(manager, "job.accept", { root: approvedRoot, revision: rev() }),
      /version/
    );
    await command(reviewer, "job.review", {
      root: j.root,
      approved: true,
      comment: "Verified the updated UI version",
      revision: rev(),
    });
    await command(manager, "job.accept", { root: j.root, revision: rev() });
    const before = await provider.connection.getBalance(vendorA.publicKey);
    await command(workerA, "job.claim", { revision: rev() });
    assert.equal(
      (await provider.connection.getBalance(vendorA.publicKey)) - before,
      11000000
    );
    await assert.rejects(
      command(workerA, "job.claim", { revision: rev() }),
      /Unpaid|Role|authorize|Simulation failed/
    );
    await command(workerB, "job.claim", { revision: rev() });
    assert(engine.state.jobs[job].members.every((m) => m.paid));
  });
  it("enforces the delegated cap inside the Solana program, independent of the relay", async () => {
    const event = signEvent(manager, {
      action: "job.open",
      project,
      job: "raw-over-budget",
      title: "Attempt",
      brief: "Attempt",
      skills: [],
      budget: 60000000,
      deadline: now() + 1000,
      dependencies: [],
      public: true,
    });
    const tx = (await chain.prepare(event, engine.state))!;
    tx.partialSign(manager, sponsor);
    await assert.rejects(
      provider.connection.sendRawTransaction(tx.serialize()),
      /Budget|Simulation failed/
    );
    assert(!engine.state.jobs["raw-over-budget"]);
  });
  it("recovers a confirmed transaction when the relay dies before appending its event", async () => {
    const id = "recover-" + Date.now();
    const event = signEvent(manager, {
      action: "job.open",
      project,
      job: id,
      title: "Crash recovery",
      brief: "Recover after send",
      skills: [],
      budget: 1000000,
      deadline: now() + 1000,
      dependencies: [],
      public: false,
    });
    const tx = (await chain.prepare(event, engine.state))!;
    tx.partialSign(manager, sponsor);
    const raw = tx.serialize(),
      sig = bs58.encode(tx.signature!);
    store.saveCommand(event, raw.toString("base64"), sig);
    await provider.connection.sendRawTransaction(raw);
    await provider.connection.confirmTransaction(sig, "confirmed");
    assert(!store.get(event.id));
    await engine.serial(() => engine.recover());
    assert.equal(engine.state.jobs[id].state, "open");
    assert.equal(store.pending().length, 0);
    await command(owner, "job.cancel", { job: id, revision: 0 });
  });
  it("blocks work on unfinished dependencies and refunds expired collaboration", async () => {
    const id = "dependent-" + Date.now();
    await command(manager, "job.open", {
      job: id,
      title: "Dependent task",
      brief: "Requires private-work",
      skills: [],
      budget: 2000000,
      deadline: now() + 6,
      dependencies: ["private-work"],
      public: true,
    });
    const offer = await command(workerA, "offer.publish", {
      job: id,
      amount: 1000000,
      message: "Dependent work",
    });
    await command(manager, "job.award", {
      job: id,
      offerId: offer.event.id,
      revision: 0,
      leaseUntil: engine.state.jobs[id].deadline,
    });
    const files = [
      { path: "dependent.txt", content: Buffer.from("should not run") },
    ];
    await assert.rejects(
      command(workerA, "job.submit", {
        job: id,
        revision: 1,
        package: createWorkPackage(project + "/" + id, workerA, files),
        files: [
          { path: files[0].path, base64: files[0].content.toString("base64") },
        ],
      }),
      /Dependency|Simulation failed/
    );
    assert.equal(engine.state.jobs[id].state, "working");
    assert.equal(store.pending().length, 0);
    await new Promise((r) => setTimeout(r, 7000));
    await command(owner, "job.cancel", { job: id, revision: 1 });
    assert.equal(engine.state.jobs[id].state, "cancelled");
    await command(owner, "job.cancel", { job: "private-work", revision: 0 });
  });
  it("returns unused accepted-task funds and permits only the owner to withdraw the project reserve", async () => {
    const id = "reserve-" + Date.now();
    await command(manager, "job.open", {
      job: id,
      title: "Reserve return",
      brief: "Return unused budget",
      skills: [],
      budget: 2000000,
      deadline: now() + 1000,
      dependencies: [],
      public: true,
    });
    const offer = await command(workerA, "offer.publish", {
      job: id,
      amount: 1000000,
      message: "Fixed quote",
    });
    await command(manager, "job.award", {
      job: id,
      offerId: offer.event.id,
      revision: 0,
      leaseUntil: now() + 500,
    });
    const files = [{ path: "done.txt", content: Buffer.from("done") }];
    await command(workerA, "job.submit", {
      job: id,
      revision: 1,
      package: createWorkPackage(project + "/" + id, workerA, files),
      files: [
        { path: files[0].path, base64: files[0].content.toString("base64") },
      ],
    });
    let task = engine.state.jobs[id];
    await command(reviewer, "job.review", {
      job: id,
      revision: task.revision,
      root: task.root,
      approved: true,
      comment: "Done",
    });
    await command(manager, "job.accept", {
      job: id,
      revision: task.revision,
      root: task.root,
    });
    await command(workerA, "job.claim", { job: id, revision: task.revision });
    const before = engine.state.projects[project].balance;
    await command(owner, "job.reclaim", { job: id, revision: task.revision });
    assert.equal(engine.state.projects[project].balance, before + 1000000);
    await assert.rejects(
      command(owner, "job.reclaim", { job: id, revision: task.revision }),
      /reclaimable/
    );
    await assert.rejects(
      client(manager).publish({
        action: "project.withdraw",
        project,
        revision: engine.state.projects[project].revision,
        amount: 1,
      }),
      /Owner/
    );
    const balance = await provider.connection.getBalance(owner.publicKey);
    await client(owner).publish({
      action: "project.withdraw",
      project,
      revision: engine.state.projects[project].revision,
      amount: 1000000,
    });
    assert.equal(
      (await provider.connection.getBalance(owner.publicKey)) - balance,
      1000000
    );
  });
  it("exposes the same context to an external MCP process", async () => {
    const keyFile = join(path + "-agent.json");
    writeFileSync(keyFile, JSON.stringify([...workerA.secretKey]), {
      mode: 0o600,
    });
    const child = spawn(
      process.execPath,
      ["-r", "ts-node/register", "src/mcp-server.ts"],
      {
        env: {
          ...process.env,
          MESH_AGENT_KEY: keyFile,
          MESH_URL: "http://127.0.0.1:4191",
        },
        stdio: ["pipe", "pipe", "pipe"],
      }
    );
    const output: any[] = [];
    let buffer = "";
    child.stdout.on("data", (b) => {
      buffer += b.toString();
      let i;
      while ((i = buffer.indexOf("\n")) >= 0) {
        output.push(JSON.parse(buffer.slice(0, i)));
        buffer = buffer.slice(i + 1);
      }
    });
    const send = (r: any) =>
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...r }) + "\n");
    const wait = async (id: number) => {
      const start = Date.now();
      while (!output.some((r) => r.id === id)) {
        if (Date.now() - start > 10000) throw Error("MCP response timeout");
        await new Promise((r) => setTimeout(r, 30));
      }
      return output.find((r) => r.id === id);
    };
    try {
      send({
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "test", version: "1" },
        },
      });
      assert.equal((await wait(1)).result.serverInfo.name, "ctrl-mesh");
      send({ method: "notifications/initialized" });
      send({ id: 2, method: "tools/list" });
      assert(
        (await wait(2)).result.tools.some((t: any) => t.name === "mesh_command")
      );
      send({
        id: 3,
        method: "tools/call",
        params: { name: "mesh_context", arguments: {} },
      });
      assert.equal(
        JSON.parse((await wait(3)).result.content[0].text).actor,
        workerA.publicKey.toBase58()
      );
    } finally {
      child.kill("SIGTERM");
    }
  });
  it("replays the durable journal after relay restart and revokes delegation", async () => {
    const count = engine.state.timeline.length;
    await relay.stop();
    store.close();
    store = new Store(path);
    engine = new Engine(store, chain);
    relay = createRelay(engine, { port: 4191 });
    await relay.start();
    clients.clear();
    await engine.verifyHeads();
    assert.equal(engine.state.timeline.length, count);
    assert(engine.state.jobs[job].members.every((m) => m.paid));
    await client(owner).publish({
      action: "project.policy",
      project,
      manager: manager.publicKey.toBase58(),
      reviewer: reviewer.publicKey.toBase58(),
      allowance: 50000000,
      expires: now() - 1,
      revision: engine.state.projects[project].revision,
    });
    assert.equal((await client(manager).context()).projects.length, 0);
    assert.equal((await client(manager).context()).jobs.length, 0);
    await assert.rejects(
      command(manager, "job.open", {
        job: "after-revocation",
        title: "No",
        brief: "No",
        skills: [],
        budget: 1,
        deadline: now() + 1000,
        dependencies: [],
        public: true,
      }),
      /permission/
    );
  });
  it("closes an epoch with a signed report and on-chain evidence commitment", async () => {
    const evidence = engine.state.timeline
      .filter((e) => JSON.parse(e.event.content).action === "job.accept")
      .map((e) => e.event.id);
    const entry = await client(owner).publish({
      action: "epoch.close",
      project,
      report: "All contributions reviewed and settled.",
      evidence,
    });
    assert(entry.receipt.signature);
    assert(engine.state.projects[project].closed);
    const account: any = await (chain.program.account as any).project.fetch(
      engine.state.projects[project].address
    );
    assert.equal(account.closed, true);
    assert.equal(account.openJobs, 0);
  });
});
