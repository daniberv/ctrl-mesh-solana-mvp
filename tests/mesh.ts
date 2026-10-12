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
import { Federation } from "../src/mesh/federation";
import { seal } from "../src/mesh/encryption";
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
  it("keeps private notes and artifacts encrypted across owners, rotation and storage", async () => {
    for (const actor of [owner, manager, reviewer, workerA, workerB, outsider])
      await client(actor).publishEncryptionKey();
    const note = await client(workerA).publishPrivate(
      project,
      job,
      "private reviewer finding 7f9a",
      [reviewer.publicKey.toBase58()]
    );
    assert.equal(
      client(reviewer).decryptPrivate(note).message,
      "private reviewer finding 7f9a"
    );
    assert.throws(() => client(workerB).decryptPrivate(note), /decryption key/);
    assert.throws(
      () => client(outsider).decryptPrivate(note),
      /decryption key/
    );
    assert(
      !(await client(workerB).updates()).entries.some(
        (e: any) => e.event.id === note.event.id
      )
    );
    assert(
      !(await client(outsider).updates()).entries.some(
        (e: any) => e.event.id === note.event.id
      )
    );
    assert(
      !JSON.stringify(store.entries()).includes("private reviewer finding 7f9a")
    );
    await assert.rejects(
      client(workerA).publishPrivate(project, job, "unauthorized sharing", [
        outsider.publicKey.toBase58(),
      ]),
      /Recipient access/
    );
    const oldReviewer = client(reviewer);
    const staleEnvelope = seal(
      { message: "stale audience" },
      { sender: workerA.publicKey.toBase58(), project, job, purpose: "note" },
      [reviewer.publicKey.toBase58()],
      engine.state.encryptionKeys
    );
    const rotated = new MeshClient("http://127.0.0.1:4191", reviewer, {
      encryptionSecret: nacl.randomBytes(32),
    });
    await assert.rejects(rotated.publishEncryptionKey(), /explicitly rotate/);
    await rotated.publishEncryptionKey(true);
    clients.set(reviewer, rotated);
    assert.throws(() => rotated.decryptPrivate(note), /decryption key/);
    assert.equal(
      oldReviewer.decryptPrivate(note).message,
      "private reviewer finding 7f9a"
    );
    await assert.rejects(
      client(workerA).publish({
        action: "private.publish",
        project,
        job,
        sealed: staleEnvelope,
      }),
      /encryption key changed/
    );
    const files = [
      {
        path: "confidential-source.ts",
        content: Buffer.from("export const privateImplementation = 75391;"),
      },
    ];
    await client(workerA).submitPrivate(project, job, files);
    const record =
      engine.state.jobs[job].packages[workerA.publicKey.toBase58()];
    assert.equal(record.encrypted, true);
    assert.equal(
      Buffer.from(
        rotated.decryptArtifact(record, project, job).files[0].base64,
        "base64"
      ).toString(),
      files[0].content.toString()
    );
    assert.equal(
      client(owner).decryptArtifact(record, project, job).files[0].path,
      files[0].path
    );
    assert.throws(
      () => client(workerB).decryptArtifact(record, project, job),
      /decryption key/
    );
    const stored = JSON.stringify(store.entries());
    assert(
      !stored.includes("confidential-source.ts") &&
        !stored.includes("privateImplementation")
    );
    const onchain: any = await (chain.program.account as any).job.fetch(
      new anchor.web3.PublicKey(engine.state.jobs[job].address)
    );
    assert.equal(
      Buffer.from(onchain.members[0].hash).toString("hex"),
      record.package.packageHash
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
    await client(workerA).submitPrivate(project, id, files);
    let task = engine.state.jobs[id];
    assert.equal(
      client(reviewer).decryptArtifact(
        task.packages[workerA.publicKey.toBase58()],
        project,
        id
      ).files[0].path,
      "done.txt"
    );
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
      send({
        id: 4,
        method: "tools/call",
        params: {
          name: "mesh_private_message",
          arguments: {
            project,
            job,
            message: "MCP encrypted handoff",
            recipients: [owner.publicKey.toBase58()],
          },
        },
      });
      const privateResult = (await wait(4)).result;
      assert.equal(privateResult.isError, false, privateResult.content[0].text);
      assert.equal(
        client(owner).decryptPrivate(JSON.parse(privateResult.content[0].text))
          .message,
        "MCP encrypted handoff"
      );
      send({
        id: 5,
        method: "tools/call",
        params: { name: "mesh_private_read", arguments: { project } },
      });
      const opened = (await wait(5)).result;
      assert.equal(opened.isError, false, opened.content[0].text);
      const records = JSON.parse(opened.content[0].text);
      assert(
        records.notes.some(
          (note: any) => note.data?.message === "MCP encrypted handoff"
        )
      );
      assert(
        records.artifacts.some(
          (record: any) => record.data?.files[0]?.path === "done.txt"
        )
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
  it("replicates verified history, repairs an offline tail and serves context after coordinator loss", async () => {
    const peerKey = Keypair.generate(),
      token = "test-peer-" + "7".repeat(40);
    const feed = new Federation(engine, { identity: peerKey, token });
    await feed.initialize();
    const source = createRelay(engine, { port: 4193, federation: feed });
    await source.start();
    const replicaPath = join(
      mkdtempSync(join(tmpdir(), "mesh-replica-")),
      "replica.sqlite"
    );
    let replicaStore = new Store(replicaPath);
    let replica = new Engine(
      replicaStore,
      new Chain(provider.connection.rpcEndpoint, Keypair.generate()),
      true
    );
    const options = {
      identity: Keypair.generate(),
      upstream: {
        url: "http://127.0.0.1:4193",
        publicKey: Buffer.from(peerKey.publicKey.toBytes()).toString("hex"),
        token,
      },
    };
    let federation = new Federation(replica, options);
    let copy = createRelay(replica, { port: 4192, federation });
    try {
      await federation.initialize();
      const unauthorized = await fetch(
        "http://127.0.0.1:4193/api/federation/batch?after=0&nonce=" +
          "a".repeat(48)
      );
      assert.equal(unauthorized.status, 400);
      const forged = structuredClone(store.entries()[0]);
      forged.event.sig = "0".repeat(128);
      await assert.rejects(replica.importEntry(forged), /signature/);
      const wrongPeer = new Federation(replica, {
        ...options,
        upstream: {
          ...options.upstream,
          publicKey: Buffer.from(
            Keypair.generate().publicKey.toBytes()
          ).toString("hex"),
        },
      });
      await wrongPeer.initialize();
      await assert.rejects(wrongPeer.sync(), /peer signature/);
      assert.equal(replicaStore.head(), 0);
      await federation.sync();
      assert.equal(replicaStore.head(), store.head());
      assert.equal(replicaStore.hash(), store.hash());
      assert.deepEqual(replica.state.jobs, engine.state.jobs);
      assert.deepEqual(replica.state.projects, engine.state.projects);
      await federation.sync();
      assert.equal(replica.state.timeline.length, engine.state.timeline.length);
      const badReceipt = structuredClone(
        store.entries().find((e) => e.receipt.chain)!
      );
      const checkState = new (require("../src/mesh/state").State)();
      for (const entry of store.entries().filter((e) => e.seq < badReceipt.seq))
        checkState.apply(entry);
      badReceipt.receipt.chain.revision += 999;
      await assert.rejects(
        chain.verifyHistorical(
          badReceipt.event,
          checkState,
          badReceipt.receipt
        ),
        /projection mismatch/
      );
      const swapped = {
        ...badReceipt.receipt,
        signature: store
          .entries()
          .find((e) => e.receipt.signature && e.seq !== badReceipt.seq)!.receipt
          .signature,
      };
      await assert.rejects(
        chain.verifyHistorical(badReceipt.event, checkState, swapped),
        /differs|signature/
      );
      await copy.start();
      const resilient = new MeshClient("http://127.0.0.1:4193", owner, {
        replicas: ["http://127.0.0.1:4192"],
        stream: store.meta("stream"),
      });
      await resilient.context();
      const originalHead = replicaStore.head();
      await copy.stop();
      await federation.stop();
      replicaStore.close();
      const isolatedKey = Keypair.generate();
      await new MeshClient(
        "http://127.0.0.1:4191",
        isolatedKey
      ).publishEncryptionKey();
      assert.equal(store.head(), originalHead + 1);
      replicaStore = new Store(replicaPath);
      replica = new Engine(
        replicaStore,
        new Chain(provider.connection.rpcEndpoint, Keypair.generate()),
        true
      );
      federation = new Federation(replica, options);
      await federation.initialize();
      await federation.sync();
      assert.equal(replicaStore.hash(), store.hash());
      copy = createRelay(replica, { port: 4192, federation });
      await copy.start();
      await source.stop();
      const fallback = await resilient.context();
      assert.equal(fallback.relay.readOnly, true);
      assert.equal(fallback.relay.url, "http://127.0.0.1:4192");
      assert.equal(fallback.cursor, store.head());
      await assert.rejects(
        new MeshClient(
          "http://127.0.0.1:4192",
          Keypair.generate()
        ).publishEncryptionKey(),
        /read-only/
      );
      const received: string[] = [];
      let ready!: () => void;
      const caughtUp = new Promise<void>((r) => (ready = r));
      const watching = await resilient.watch((e) => received.push(e.event.id), {
        cursor: originalHead,
        onReady: () => ready(),
      });
      await Promise.race([
        caughtUp,
        new Promise((_, reject) =>
          setTimeout(() => reject(Error("Replica watch timeout")), 5000)
        ),
      ]);
      watching.close();
      assert(received.includes(store.entries().at(-1)!.event.id));
      await assert.rejects(
        new MeshClient("http://127.0.0.1:4193", owner, {
          replicas: ["http://127.0.0.1:4192"],
          stream: "wrong-stream",
        }).context(),
        /stream identity/
      );
      // Persisted hash chains detect disk changes before serving an altered history.
      await copy.stop();
      await federation.stop();
      replicaStore.close();
      const { DatabaseSync } = require("node:sqlite");
      const disk = new DatabaseSync(replicaPath);
      disk
        .prepare("UPDATE events SET receipt=? WHERE seq=?")
        .run('{"slot":123}', 1);
      disk.close();
      assert.throws(() => new Store(replicaPath), /integrity mismatch/);
    } finally {
      await source.stop().catch(() => {});
      await copy.stop().catch(() => {});
      await federation.stop();
      try {
        replicaStore.close();
      } catch {}
    }
  });
});
