import { strict as assert } from "assert";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import nacl from "tweetnacl";
import * as anchor from "@coral-xyz/anchor";
import {
  ComputeBudgetProgram,
  Keypair,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import { Chain } from "../src/mesh/chain";
import { Engine } from "../src/mesh/engine";
import { Store } from "../src/mesh/store";
import { State } from "../src/mesh/state";
import { MeshEvent, signEvent } from "../src/mesh/events";
import { walletSigningMessage } from "../src/mesh/signatures";
import {
  buildTransaction,
  verifyPreparedTransaction,
  TRANSACTION_COMPUTE_UNITS,
  TRANSACTION_MICRO_LAMPORTS,
} from "../src/mesh/transaction";

// Phantom's documented enhancement: unsigned messages without an explicit
// compute budget receive priority fee instructions at signing time.
function phantomSign(transaction: Transaction, actor: Keypair) {
  const tx = Transaction.from(
    transaction.serialize({ requireAllSignatures: false })
  );
  if (
    !tx.signatures.some((s) => s.signature) &&
    !tx.instructions.some((ix) =>
      ix.programId.equals(ComputeBudgetProgram.programId)
    )
  )
    tx.instructions.unshift(
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 })
    );
  tx.partialSign(actor);
  return Transaction.from(tx.serialize({ requireAllSignatures: false }));
}

describe("wallet transaction preparation", function () {
  this.timeout(60000);
  const provider = anchor.AnchorProvider.env();
  const sponsor = (provider.wallet as anchor.Wallet).payer;
  const actor = Keypair.generate(),
    reviewer = Keypair.generate();
  const directory = mkdtempSync(join(tmpdir(), "mesh-wallet-tx-"));
  const store = new Store(join(directory, "events.sqlite"));
  const chain = new Chain(provider.connection.rpcEndpoint, sponsor);
  const engine = new Engine(store, chain);
  const now = () => Math.floor(Date.now() / 1000);
  const project = "wallet-tx-" + Date.now();
  const command = (id: string) => {
    const event = signEvent(actor, {
      action: "project.create",
      project: id,
      title: "Wallet transaction test",
      brief: "Wallet is also its coordinator; reviewer is independent.",
      manager: actor.publicKey.toBase58(),
      reviewer: reviewer.publicKey.toBase58(),
      amount: 10_000_000,
      allowance: 5_000_000,
      expires: now() + 3600,
    });
    return {
      ...event,
      sig: Buffer.from(
        nacl.sign.detached(
          walletSigningMessage("event", event.id),
          actor.secretKey
        )
      ).toString("hex"),
    };
  };
  const prepared = async (event: MeshEvent) => {
    const result = await engine.prepare(event);
    return Transaction.from(Buffer.from(result.transaction!, "base64"));
  };
  before(async () => {
    await provider.sendAndConfirm(
      new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: sponsor.publicKey,
          toPubkey: actor.publicKey,
          lamports: 100_000_000,
        })
      )
    );
    for (const key of [actor, reviewer]) {
      const address = key.publicKey.toBase58();
      await engine.commit(
        signEvent(key, {
          action: "agent.register",
          agent: address,
          name: "Wallet test agent",
          skills: ["typescript"],
          description: "Test agent",
          rate: 0,
          binding: Buffer.from(
            nacl.sign.detached(
              Buffer.from("ctrl-mesh:agent-owner:v1:" + address),
              key.secretKey
            )
          ).toString("hex"),
        })
      );
    }
  });
  after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("reproduces the message mismatch when a wallet enhances a legacy transaction", async () => {
    const event = command(project + "-legacy-repro");
    const tx = (await buildTransaction(
      event,
      engine.state,
      chain.program,
      sponsor.publicKey,
      false
    ))!;
    tx.feePayer = sponsor.publicKey;
    tx.recentBlockhash = (
      await chain.connection.getLatestBlockhash()
    ).blockhash;
    const message = tx.serializeMessage();
    const signed = phantomSign(tx, actor);
    assert.equal(message.equals(signed.serializeMessage()), false);
    assert.equal(signed.verifySignatures(false), true);
  });

  it("keeps the exact message through wallet signing and publishes a real project", async () => {
    const event = command(project);
    const tx = await prepared(event);
    assert.deepEqual(
      tx.instructions.slice(0, 2).map((ix) => [...ix.data]),
      [
        [
          ...ComputeBudgetProgram.setComputeUnitLimit({
            units: TRANSACTION_COMPUTE_UNITS,
          }).data,
        ],
        [
          ...ComputeBudgetProgram.setComputeUnitPrice({
            microLamports: TRANSACTION_MICRO_LAMPORTS,
          }).data,
        ],
      ]
    );
    assert.equal(
      tx.signatures.some((s) => s.signature),
      false
    );
    const context = engine.state.context(actor.publicKey.toBase58());
    await verifyPreparedTransaction(event, tx, context);
    const message = tx.serializeMessage();
    const signed = phantomSign(tx, actor);
    assert(message.equals(signed.serializeMessage()));
    await verifyPreparedTransaction(event, signed, context);
    const entry = await engine.commit(
      event,
      signed.serialize({ requireAllSignatures: false }).toString("base64")
    );
    assert(entry.receipt.signature);
    assert.equal(
      engine.state.projects[project].owner,
      actor.publicKey.toBase58()
    );
    assert.equal(
      engine.state.projects[project].manager,
      actor.publicKey.toBase58()
    );
    assert.equal(engine.state.projects[project].balance, 10_000_000);
    const state = new State();
    for (const previous of store.entries().filter((e) => e.seq < entry.seq))
      state.apply(previous);
    await chain.verifyHistorical(event, state, entry.receipt);
    assert.equal(store.pending().length, 0);
  });

  it("still rejects changed fees, commands, payers, blockhashes and unsigned actors", async () => {
    const event = command(project + "-tamper");
    const tx = await prepared(event);
    const raw = tx.serialize({ requireAllSignatures: false });
    const changes = [
      (x: Transaction) => {
        x.instructions[1] = ComputeBudgetProgram.setComputeUnitPrice({
          microLamports: 1_000_000,
        });
      },
      (x: Transaction) => {
        x.instructions[2].data[8] ^= 1;
      },
      (x: Transaction) => {
        x.feePayer = reviewer.publicKey;
        x.signatures = [];
      },
      (x: Transaction) => {
        x.recentBlockhash = Keypair.generate().publicKey.toBase58();
      },
      (x: Transaction) => {
        x.add(
          SystemProgram.transfer({
            fromPubkey: sponsor.publicKey,
            toPubkey: reviewer.publicKey,
            lamports: 1,
          })
        );
      },
    ];
    const head = store.head();
    for (const change of changes) {
      const altered = Transaction.from(raw);
      change(altered);
      altered.partialSign(actor);
      await assert.rejects(
        engine.commit(
          event,
          altered.serialize({ requireAllSignatures: false }).toString("base64")
        ),
        /differs/
      );
    }
    await assert.rejects(
      engine.commit(event, raw.toString("base64")),
      /Actor must sign/
    );
    assert.equal(store.head(), head);
    assert.equal(store.pending().length, 0);
  });

  it("verifies historical transactions created before explicit fee instructions", async () => {
    const event = command(project + "-old-journal");
    const original = chain.prepare.bind(chain);
    chain.prepare = async (event, state) => {
      const tx = await buildTransaction(
        event,
        state,
        chain.program,
        sponsor.publicKey,
        false
      );
      if (tx) {
        tx.feePayer = sponsor.publicKey;
        tx.recentBlockhash = (
          await chain.connection.getLatestBlockhash()
        ).blockhash;
      }
      return tx;
    };
    let entry;
    const state = new State();
    for (const previous of store.entries()) state.apply(previous);
    try {
      const tx = await prepared(event);
      tx.partialSign(actor);
      entry = await engine.commit(
        event,
        tx.serialize({ requireAllSignatures: false }).toString("base64")
      );
    } finally {
      chain.prepare = original;
    }
    await chain.verifyHistorical(event, state, entry!.receipt);
  });
});
