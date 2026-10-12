import { strict as assert } from "assert";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import nacl from "tweetnacl";
import * as anchor from "@coral-xyz/anchor";
import { Keypair, Transaction, SystemProgram } from "@solana/web3.js";
import { Consensus, ClusterConfig } from "../src/mesh/consensus";
import { Chain } from "../src/mesh/chain";
import { Engine } from "../src/mesh/engine";
import { Store, EMPTY_HASH } from "../src/mesh/store";
import { MeshClient } from "../src/mesh/sdk";
import { createRelay } from "../src/mesh/relay";
import { signEvent } from "../src/mesh/events";
import { createWorkPackage } from "../src/proof";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn: () => boolean, message: string, timeout = 15000) {
  const end = Date.now() + timeout;
  while (!fn()) {
    if (Date.now() > end) throw Error(message);
    await sleep(40);
  }
}
describe("automatic writable failover", function () {
  this.timeout(180000);
  const provider = anchor.AnchorProvider.env();
  const owner = Keypair.generate(),
    manager = Keypair.generate(),
    reviewer = Keypair.generate();
  const vendorA = Keypair.generate(),
    vendorB = Keypair.generate(),
    workerA = Keypair.generate(),
    workerB = Keypair.generate();
  const sponsors = [Keypair.generate(), Keypair.generate(), Keypair.generate()];
  const directory = mkdtempSync(join(tmpdir(), "mesh-ha-"));
  const nodes: {
    store: Store;
    engine: Engine;
    raft: Consensus;
    relay: ReturnType<typeof createRelay>;
    alive: boolean;
  }[] = [];
  const blocked = new Set<number>();
  let config: ClusterConfig, originalLeader: number;
  const project = "ha-" + Date.now(),
    job = "ha-delivery";
  const now = () => Math.floor(Date.now() / 1000);
  const live = () => nodes.filter((n) => n.alive);
  const leader = () =>
    nodes.find(
      (n) => n.alive && n.raft.writable && !blocked.has(nodes.indexOf(n))
    )!;
  const index = () => nodes.indexOf(leader());
  const client = (key: Keypair, url?: string) =>
    new MeshClient(url || config.members[originalLeader].url, key, {
      replicas: config.members.map((m) => m.url).filter((u) => u !== url),
      stream: config.stream,
      requestMs: 2000,
      failoverMs: 20000,
    });
  async function start(i: number) {
    const store = new Store(join(directory, i + ".sqlite"));
    if (!store.meta("ha.config")) {
      store.setMeta("stream", config.stream);
      store.setMeta("genesis", config.genesis);
    }
    const engine = new Engine(
      store,
      new Chain(provider.connection.rpcEndpoint, sponsors[i]),
      false,
      true
    );
    const raft = new Consensus(
      store,
      {
        id: String(i),
        token: "ha-test-token-".repeat(4),
        config,
        electionMs: 500,
        heartbeatMs: 70,
        requestMs: 200,
        proposalMs: 700,
        transport: async (peer, message) => {
          const p = Number(peer.id);
          if (blocked.has(i) || blocked.has(p) || !nodes[p]?.alive)
            throw Error("Partition");
          return nodes[p].raft.handle(message);
        },
      },
      (action) => engine.applyConsensus(action)
    );
    engine.consensus = raft;
    const relay = createRelay(engine, {
      port: 4211 + i,
      localMailDir: join(directory, "mail"),
    });
    nodes[i] = { store, engine, raft, relay, alive: true };
    await relay.start();
    raft.start();
  }
  async function stop(i: number) {
    const n = nodes[i];
    if (!n.alive) return;
    n.alive = false;
    await n.raft.stop();
    n.relay.server.closeAllConnections();
    await n.relay.stop();
    await n.engine.serial(async () => {});
    n.store.close();
  }
  async function sync() {
    await until(
      () =>
        !!leader() &&
        live().every(
          (n) =>
            n.store.hash() === leader().store.hash() &&
            n.store.head() === leader().store.head()
        ),
      "Voters did not converge"
    );
  }
  async function publish(key: Keypair, action: string, data: any = {}) {
    return client(key).publish({ action, project, job, ...data });
  }
  const revision = () => leader().engine.state.jobs[job].revision;
  function submitCommand(key: Keypair, text: string) {
    const files = [{ path: "deliverable.txt", content: Buffer.from(text) }];
    return {
      action: "job.submit",
      project,
      job,
      revision: revision(),
      package: createWorkPackage(project + "/" + job, key, files),
      files: files.map((f) => ({
        path: f.path,
        base64: f.content.toString("base64"),
      })),
    };
  }
  before(async () => {
    await provider.sendAndConfirm(
      new Transaction().add(
        ...[owner, ...sponsors].map((key) =>
          SystemProgram.transfer({
            fromPubkey: provider.wallet.publicKey,
            toPubkey: key.publicKey,
            lamports: 1000000000,
          })
        )
      )
    );
    config = {
      cluster: randomUUID(),
      stream: randomUUID(),
      genesis: await provider.connection.getGenesisHash(),
      program: new Chain(
        provider.connection.rpcEndpoint,
        sponsors[0]
      ).program.programId.toBase58(),
      baseHead: 0,
      baseHash: EMPTY_HASH,
      members: [0, 1, 2].map((i) => ({
        id: String(i),
        url: "http://127.0.0.1:" + (4211 + i),
      })),
    };
    for (let i = 0; i < 3; i++) await start(i);
    await until(
      () => live().filter((n) => n.raft.writable).length === 1,
      "No initial leader"
    );
    originalLeader = index();
  });
  after(async () => {
    for (let i = 0; i < nodes.length; i++) await stop(i);
  });

  it("elects one writer, authenticates peers, and durably replicates multi-owner work", async () => {
    const denied = await fetch(config.members[0].url + "/api/ha/rpc", {
      method: "POST",
      body: "{}",
    });
    assert.equal(denied.status, 400);
    for (const [vendor, agent, name] of [
      [owner, manager, "Planner"],
      [owner, reviewer, "Reviewer"],
      [vendorA, workerA, "Provider A"],
      [vendorB, workerB, "Provider B"],
    ] as const) {
      await client(vendor).publish({
        action: "agent.register",
        agent: agent.publicKey.toBase58(),
        name,
        description: name,
        skills: ["typescript"],
        rate: 1000000,
        binding: Buffer.from(
          nacl.sign.detached(
            Buffer.from(
              "ctrl-mesh:agent-owner:v1:" + vendor.publicKey.toBase58()
            ),
            agent.secretKey
          )
        ).toString("hex"),
      });
    }
    await publish(owner, "project.create", {
      title: "Survives a coordinator failure",
      brief: "Two independent providers",
      manager: manager.publicKey.toBase58(),
      reviewer: reviewer.publicKey.toBase58(),
      amount: 100000000,
      allowance: 50000000,
      expires: now() + 3600,
    });
    await publish(manager, "job.open", {
      title: "Complete across failover",
      brief: "Submit, review and pay after the primary disappears",
      budget: 10000000,
      deadline: now() + 1800,
      skills: ["typescript"],
      dependencies: [],
      public: true,
    });
    for (const worker of [workerA, workerB]) {
      const offer = await publish(worker, "offer.publish", {
        amount: 4000000,
        eta: now() + 600,
        message: "Ready",
      });
      await publish(manager, "job.award", {
        offerId: offer.event.id,
        leaseUntil: now() + 900,
        revision: revision(),
      });
    }
    await sync();
    assert.equal(live().filter((n) => n.raft.writable).length, 1);
    assert.equal(live()[0].store.head(), 10);
    assert.throws(
      () => new Engine(nodes[0].store, nodes[0].engine.chain),
      /requires its HA cluster/
    );
  });

  it("replays a quorum-persisted submission when the primary dies before broadcasting it", async () => {
    const i = index(),
      old = nodes[i],
      conn = old.engine.chain.connection;
    const send = conn.sendRawTransaction.bind(conn);
    let triggered = false;
    conn.sendRawTransaction = async (...args: Parameters<typeof send>) => {
      if (!triggered) {
        triggered = true;
        old.alive = false;
        await old.raft.stop();
        old.relay.server.closeAllConnections();
        throw new TypeError("Process died before broadcast");
      }
      return send(...args);
    };
    const event = signEvent(
      workerA,
      submitCommand(workerA, "Backend survives primary death")
    );
    const result = await client(workerA).publishEvent(event);
    assert(triggered);
    assert.notEqual(index(), i);
    assert.equal(result.event.id, event.id);
    assert(result.receipt.signature);
    assert.equal(
      leader()
        .store.entries()
        .filter((e) => e.event.id === event.id).length,
      1
    );
    await old.relay.stop();
    await old.engine.serial(async () => {});
    old.store.close();
    await start(i);
    await sync();
    assert.equal(nodes[i].raft.role, "follower");
  });

  it("fences an isolated primary, keeps shared context/watch cursors, and discards uncommitted work", async () => {
    const i = index(),
      isolated = nodes[i];
    const cursor = isolated.store.head();
    const seen: string[] = [];
    const watch = await client(workerA).watch((e) => seen.push(e.event.id), {
      cursor,
      project,
      job,
    });
    blocked.add(i);
    const stray = signEvent(manager, {
      action: "progress",
      project,
      job,
      message: "uncommitted minority update",
    });
    // Model an already admitted off-chain update that loses its quorum while
    // being replicated. Its divergent payload must disappear, not just a barrier.
    await assert.rejects(
      isolated.raft.propose({ type: "entry", event: stray, receipt: {} }),
      /majority|Coordinator/
    );
    await assert.rejects(isolated.engine.prepare(stray), /Coordinator/);
    await until(
      () => !!leader() && index() !== i,
      "Majority did not replace isolated leader"
    );
    const result = await client(workerB).publish(
      submitCommand(workerB, "Frontend completed during partition")
    );
    await until(
      () => seen.includes(result.event.id),
      "Watch did not reconnect and resume"
    );
    assert.equal(new Set(seen).size, seen.length);
    assert.equal(isolated.store.get(stray.id), undefined);
    blocked.delete(i);
    await sync();
    assert.equal(nodes[i].store.get(stray.id), undefined);
    assert(nodes[i].store.get(result.event.id));
    const snapshot = await client(manager, config.members[i].url).context();
    assert.equal(snapshot.jobs.find((j: any) => j.id === job).state, "review");
    watch.close();
  });

  it("recovers a payment confirmed before the leader crashes, without paying twice", async () => {
    const root = leader().engine.state.jobs[job].root;
    await publish(reviewer, "job.review", {
      approved: true,
      root,
      revision: revision(),
      comment: "Both contributions verified",
    });
    await publish(manager, "job.accept", { root, revision: revision() });
    const before = await provider.connection.getBalance(vendorA.publicKey);
    const i = index(),
      old = nodes[i],
      conn = old.engine.chain.connection;
    const send = conn.sendRawTransaction.bind(conn);
    let triggered = false;
    conn.sendRawTransaction = async (...args: Parameters<typeof send>) => {
      const sig = await send(...args);
      if (!triggered) {
        triggered = true;
        await conn.confirmTransaction(sig, "confirmed");
        old.alive = false;
        await old.raft.stop();
        old.relay.server.closeAllConnections();
        throw new TypeError(
          "Process died after confirmation, before journal append"
        );
      }
      return sig;
    };
    const event = signEvent(workerA, {
      action: "job.claim",
      project,
      job,
      revision: revision(),
    });
    const paid = await client(workerA).publishEvent(event);
    assert(triggered);
    assert(paid.receipt.signature);
    assert.equal(
      (await provider.connection.getBalance(vendorA.publicKey)) - before,
      4000000
    );
    const duplicate = await client(workerA).publishEvent(event);
    assert.equal(duplicate.seq, paid.seq);
    assert.equal(duplicate.receipt.signature, paid.receipt.signature);
    assert.equal(
      (await provider.connection.getBalance(vendorA.publicKey)) - before,
      4000000
    );
    await publish(workerB, "job.claim", { revision: revision() });
    assert(leader().engine.state.jobs[job].members.every((m) => m.paid));
    await old.relay.stop();
    await old.engine.serial(async () => {});
    old.store.close();
    await start(i);
    await sync();
  });

  it("rejects writes and stale private reads without a majority, then resumes after quorum returns", async () => {
    const i = index(),
      before = leader().store.head();
    const others = [0, 1, 2].filter((n) => n !== i);
    for (const n of others) blocked.add(n);
    const event = signEvent(manager, {
      action: "key.publish",
      algorithm: "x25519-xsalsa20-poly1305-v1",
      boxKey: Buffer.from(nacl.box.keyPair().publicKey).toString("hex"),
      previous: "",
    });
    const limited = new MeshClient(config.members[i].url, manager, {
      stream: config.stream,
      failoverMs: 1500,
      requestMs: 1500,
    });
    await assert.rejects(limited.publishEvent(event), /unconfirmed/);
    assert.equal(nodes[i].store.head(), before);
    await assert.rejects(limited.context(), /election|Coordinator|majority/);
    blocked.clear();
    await until(
      () => live().filter((n) => n.raft.writable).length === 1,
      "Quorum did not recover"
    );
    const result = await client(manager).publishEvent(event);
    await sync();
    assert.equal(
      live()[0]
        .store.entries()
        .filter((e) => e.event.id === event.id).length,
      1
    );
    assert(result.seq > before);
  });

  it("keeps browser sessions and logout revocation across coordinator failure", async () => {
    const origin = config.members[0].url;
    const request = (path: string, input?: any, cookie = "") =>
      fetch(config.members[index()].url + "/api/" + path, {
        method: input === undefined ? "GET" : "POST",
        headers: {
          Origin: origin,
          Cookie: cookie,
          "Content-Type": "application/json",
        },
        body: input === undefined ? undefined : JSON.stringify(input),
      });
    const registration = await request("session/register", {
      email: "ha@example.test",
      password: "durable email wallet passphrase",
    });
    assert.equal(registration.status, 200);
    let cookie = registration.headers.getSetCookie()[0].split(";")[0];
    const preview = await (
      await request("session/local-email", undefined, cookie)
    ).json();
    const token = new URL(preview.message.url).searchParams.get("token");
    assert.equal(
      (await request("session/verify", { token }, cookie)).status,
      200
    );
    const c = await (
      await request(
        "session/challenge",
        { actor: owner.publicKey.toBase58() },
        cookie
      )
    ).json();
    const connected = await request(
      "session/connect",
      {
        nonce: c.nonce,
        signature: Buffer.from(
          nacl.sign.detached(Buffer.from(c.message), owner.secretKey)
        ).toString("hex"),
      },
      cookie
    );
    assert.equal(connected.status, 200);
    cookie = connected.headers.getSetCookie()[0].split(";")[0];
    const first = index();
    await stop(first);
    await until(() => !!leader(), "No replacement for browser session");
    const context = await request("context", undefined, cookie);
    assert.equal(context.status, 200);
    assert((await context.json()).projects.some((p: any) => p.id === project));
    assert.equal(
      (await (await request("session", undefined, cookie)).json()).session
        .actor,
      owner.publicKey.toBase58()
    );
    assert.equal(
      (await (await request("session", undefined, cookie)).json()).session
        .account.email,
      "ha@example.test"
    );
    await start(first);
    await sync();
    for (const n of live())
      assert.equal(
        n.store.accounts.byEmail("ha@example.test")!.wallet,
        owner.publicKey.toBase58()
      );
    assert.equal((await request("session/logout", {}, cookie)).status, 200);
    const second = index();
    await stop(second);
    await until(() => !!leader(), "No replacement after logout");
    assert.equal((await request("context", undefined, cookie)).status, 401);
    assert.equal(
      (await (await request("session", undefined, cookie)).json()).session,
      null
    );
    await start(second);
    await sync();
  });
});
