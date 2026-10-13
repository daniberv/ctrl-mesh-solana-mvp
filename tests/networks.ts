import { strict as assert } from "assert";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import nacl from "tweetnacl";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  DEVNET_GENESIS,
  inspectNetwork,
  networkConfig,
  pinNetwork,
  verifyGenesis,
} from "../src/mesh/network";
import { bootstrapDevnet } from "../src/mesh/devnet-bootstrap";
import { Store } from "../src/mesh/store";
import { signEvent } from "../src/mesh/events";
import { Chain } from "../src/mesh/chain";
import { Engine } from "../src/mesh/engine";
import { Consensus, ClusterConfig } from "../src/mesh/consensus";

describe("Devnet configuration and isolated history", () => {
  const devnet = networkConfig({ SOLANA_NETWORK: "devnet" });
  const program = new PublicKey("F6eKaEwArFVNWphDWbzawQmnboAVr8XWwDHY8FkzJ2Qi");
  const info = {
    ...devnet,
    genesis: DEVNET_GENESIS,
    program: program.toBase58(),
  };
  it("requires an explicit network and verifies the genesis rather than the RPC label", async () => {
    assert.equal(networkConfig({}).network, "localnet");
    assert.throws(
      () => networkConfig({ SOLANA_RPC: devnet.rpc }),
      /select.*explicitly/
    );
    assert.throws(
      () => networkConfig({ SOLANA_NETWORK: "mainnet-beta" }),
      /localnet or devnet/
    );
    assert.throws(
      () =>
        networkConfig({
          SOLANA_NETWORK: "devnet",
          SOLANA_RPC: "http://localhost:8899",
        }),
      /HTTPS/
    );
    assert.throws(
      () => verifyGenesis(devnet, "mainnet-genesis"),
      /not Solana Devnet/
    );
    const wrong = { getGenesisHash: async () => "local-genesis" } as Connection;
    await assert.rejects(
      inspectNetwork(wrong, devnet, program),
      /not Solana Devnet/
    );
    const missing = {
      getGenesisHash: async () => DEVNET_GENESIS,
      getAccountInfo: async () => null,
    } as unknown as Connection;
    await assert.rejects(
      inspectNetwork(missing, devnet, program),
      /not deployed on devnet/
    );
    assert.equal(
      (await inspectNetwork(missing, devnet, program, false)).genesis,
      DEVNET_GENESIS
    );
  });
  it("rejects cross-network databases before replay and leaves their pins unchanged", () => {
    const dir = mkdtempSync(join(tmpdir(), "mesh-network-"));
    const store = new Store(join(dir, "events.sqlite"));
    try {
      store.setMeta("genesis", "local-genesis");
      assert.throws(() => pinNetwork(store, info), /different Solana network/);
      assert.equal(store.meta("genesis"), "local-genesis");
      assert.equal(store.meta("solana.network"), undefined);
      store.setMeta("genesis", DEVNET_GENESIS);
      pinNetwork(store, info);
      assert.throws(
        () =>
          pinNetwork(store, {
            ...info,
            program: Keypair.generate().publicKey.toBase58(),
          }),
        /different Solana network or program/
      );
      assert.equal(store.meta("solana.program"), info.program);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("imports accounts and signed agents into three new journals without copying local chain history, sessions or intents", () => {
    const dir = mkdtempSync(join(tmpdir(), "mesh-devnet-"));
    const source = new Store(join(dir, "local.sqlite"));
    const owner = Keypair.generate(),
      agent = Keypair.generate();
    const registration = signEvent(owner, {
      action: "agent.register",
      agent: agent.publicKey.toBase58(),
      name: "Coordinator",
      description: "Build tasks",
      skills: ["typescript"],
      rate: 1,
      binding: Buffer.from(
        nacl.sign.detached(
          Buffer.from("ctrl-mesh:agent-owner:v1:" + owner.publicKey.toBase58()),
          agent.secretKey
        )
      ).toString("hex"),
    });
    source.setMeta("genesis", "local-genesis");
    source.db
      .prepare("INSERT INTO accounts VALUES(?,?,?,?,?,?)")
      .run(
        "account",
        "builder@example.test",
        "hashed-password",
        0,
        owner.publicKey.toBase58(),
        1
      );
    source.db
      .prepare("INSERT INTO account_wallets VALUES(?,?,?)")
      .run(owner.publicKey.toBase58(), "account", 1);
    const secondWallet = Keypair.generate().publicKey.toBase58();
    source.db
      .prepare("INSERT INTO account_wallets VALUES(?,?,?)")
      .run(secondWallet, "account", 2);
    source.db
      .prepare("INSERT INTO account_sessions VALUES(?,?,?,?,?)")
      .run(
        "session",
        "account",
        owner.publicKey.toBase58(),
        Date.now() + 10000,
        0
      );
    source.saveBrowserSession(
      "browser-session",
      owner.publicKey.toBase58(),
      Date.now() + 10000
    );
    source.append(registration, {});
    const chainEvent = signEvent(owner, {
      action: "auth",
      nonce: "local-chain-fixture",
    });
    source.append(chainEvent, { signature: "localnet-only-signature" });
    const sourceHash = source.hash(),
      sourceStream = source.meta("stream");
    const members = ["a", "b", "c"].map((id, i) => ({
      id,
      url: `http://127.0.0.1:${4251 + i}`,
    }));
    try {
      const result = bootstrapDevnet(
        join(dir, "devnet"),
        info,
        members,
        join(dir, "local.sqlite")
      );
      assert.equal(result.accounts, 1);
      assert.equal(result.agents, 1);
      assert.notEqual(result.config.stream, sourceStream);
      for (const m of members) {
        const store = new Store(join(dir, "devnet", m.id + ".sqlite"));
        try {
          assert.equal(store.meta("genesis"), DEVNET_GENESIS);
          assert.equal(store.hash(), result.config.baseHash);
          assert.equal(store.head(), 1);
          assert.equal(store.get(registration.id)?.event.id, registration.id);
          assert.equal(store.get(chainEvent.id), undefined);
          assert.equal(
            store.accounts.byId("account")?.wallet,
            owner.publicKey.toBase58()
          );
          assert.equal(store.accounts.session("session"), undefined);
          assert.deepEqual(store.accounts.wallets("account"), [
            owner.publicKey.toBase58(),
            secondWallet,
          ]);
          assert.equal(store.browserSession("browser-session"), undefined);
          assert.equal(store.pending().length, 0);
          const engine = new Engine(store, {} as Chain, false, true);
          assert.equal(
            engine.state.agents[agent.publicKey.toBase58()].owner,
            owner.publicKey.toBase58()
          );
          new Consensus(
            store,
            { id: m.id, config: result.config, token: "test-token-".repeat(5) },
            (action) => engine.applyConsensus(action)
          );
        } finally {
          store.close();
        }
      }
      assert.equal(source.hash(), sourceHash);
      assert.equal(source.head(), 2);
      assert.equal(source.meta("genesis"), "local-genesis");
      assert.equal(
        source.accounts.session("session")?.actor,
        owner.publicKey.toBase58()
      );
      assert.throws(
        () => bootstrapDevnet(join(dir, "devnet"), info, members),
        /never resets/
      );
    } finally {
      source.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("cleans an incomplete bootstrap and preserves the source if local commands are pending", () => {
    const dir = mkdtempSync(join(tmpdir(), "mesh-pending-"));
    const source = new Store(join(dir, "local.sqlite"));
    source.saveCommand(
      signEvent(Keypair.generate(), { action: "auth", nonce: "pending" }),
      "bytes",
      "signature"
    );
    try {
      assert.throws(
        () =>
          bootstrapDevnet(
            join(dir, "devnet"),
            info,
            [],
            join(dir, "local.sqlite")
          ),
        /Reconcile pending/
      );
      assert.equal(existsSync(join(dir, "devnet", "cluster.json")), false);
      assert.equal(source.pending().length, 1);
    } finally {
      source.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("checks relay funding and simulates Devnet transactions before returning them to a wallet", async () => {
    const chain = new Chain(devnet.rpc, Keypair.generate());
    chain.network = info;
    const tx = new Transaction({
      feePayer: chain.sponsor.publicKey,
      recentBlockhash: Keypair.generate().publicKey.toBase58(),
    }).add(
      SystemProgram.transfer({
        fromPubkey: chain.sponsor.publicKey,
        toPubkey: Keypair.generate().publicKey,
        lamports: 1,
      })
    );
    let balance = 0,
      simulations = 0,
      error: any = null;
    chain.connection = {
      getFeeForMessage: async () => ({ value: 5000 }),
      getBalance: async () => balance,
      simulateTransaction: async (_tx: any, config: any) => {
        simulations++;
        assert.equal(config.sigVerify, false);
        return {
          value: {
            err: error,
            logs: error
              ? ["Program log: Error Message: Insufficient funds."]
              : [],
          },
        };
      },
    } as unknown as Connection;
    await assert.rejects(chain.preflight(tx), /fee payer needs test SOL/);
    assert.equal(simulations, 0);
    balance = 10000;
    await chain.preflight(tx);
    assert.equal(simulations, 1);
    error = { InstructionError: [0, "Custom"] };
    await assert.rejects(
      chain.preflight(tx),
      /simulation failed.*Insufficient funds/
    );
  });
});
