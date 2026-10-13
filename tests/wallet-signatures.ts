import { strict as assert } from "assert";
import nacl from "tweetnacl";
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair } from "@solana/web3.js";
import { MeshEvent, signEvent, verifyEvent } from "../src/mesh/events";
import {
  walletSigningMessage,
  verifyDigestSignature,
} from "../src/mesh/signatures";
import {
  PRIVATE_ALGORITHM,
  seal,
  unseal,
  verifySignedEnvelope,
} from "../src/mesh/encryption";
import { createWorkPackage, verifyWorkPackage } from "../src/proof";
import { State } from "../src/mesh/state";
import {
  buildTransaction,
  verifyPreparedTransaction,
} from "../src/mesh/transaction";
import idl from "../target/idl/ctrl_mesh_mvp.json";

const walletEvent = (event: MeshEvent, key: Keypair): MeshEvent => ({
  ...event,
  sig: Buffer.from(
    nacl.sign.detached(walletSigningMessage("event", event.id), key.secretKey)
  ).toString("hex"),
});

describe("browser wallet message signatures", () => {
  const key = Keypair.generate();

  it("verifies readable event messages and historical SDK signatures", () => {
    const command = {
      action: "offer.publish",
      project: "p",
      job: "j",
      amount: 10000000,
      message: "Deliver the interface",
    };
    const legacy = signEvent(key, command);
    const event = walletEvent(legacy, key);
    const text = new TextDecoder("utf8", { fatal: true }).decode(
      walletSigningMessage("event", event.id)
    );
    assert.match(text, /^ctrl-mesh:work-event:v1\n/);
    assert.deepEqual(verifyEvent(event), command);
    assert.deepEqual(verifySignedEnvelope(event), command);
    assert.deepEqual(verifyEvent(legacy), command);
    assert.deepEqual(verifySignedEnvelope(legacy), command);
    assert.throws(
      () =>
        verifyEvent({
          ...event,
          content: event.content.replace("10000000", "20000000"),
        }),
      /signature/
    );
    assert.throws(
      () =>
        verifyEvent({
          ...event,
          pubkey: Buffer.from(Keypair.generate().publicKey.toBytes()).toString(
            "hex"
          ),
        }),
      /signature/
    );
    assert.equal(
      verifyDigestSignature(
        "work-package",
        event.id,
        event.sig,
        key.publicKey.toBytes()
      ),
      false
    );
  });

  it("keeps private messaging compatible with wallet-signed recipient keys", () => {
    const receiver = Keypair.generate(),
      box = nacl.box.keyPair();
    const actor = key.publicKey.toBase58(),
      recipient = receiver.publicKey.toBase58();
    const keyEvent = walletEvent(
      signEvent(receiver, {
        action: "key.publish",
        algorithm: PRIVATE_ALGORITHM,
        boxKey: Buffer.from(box.publicKey).toString("hex"),
        previous: "",
      }),
      receiver
    );
    const senderBox = nacl.box.keyPair();
    const senderKey = walletEvent(
      signEvent(key, {
        action: "key.publish",
        algorithm: PRIVATE_ALGORITHM,
        boxKey: Buffer.from(senderBox.publicKey).toString("hex"),
        previous: "",
      }),
      key
    );
    const directory = { [actor]: senderKey, [recipient]: keyEvent };
    const scope = { sender: actor, project: "p", purpose: "note" as const };
    const envelope = seal(
      { message: "private" },
      scope,
      [recipient],
      directory
    );
    assert.equal(
      unseal(envelope, recipient, box.secretKey, scope).message,
      "private"
    );
    assert.throws(
      () =>
        seal({}, scope, [recipient], {
          ...directory,
          [recipient]: { ...keyEvent, sig: "0".repeat(128) },
        }),
      /signed event/
    );
  });

  it("verifies wallet-signed work packages and rejects changed artifacts and domains", () => {
    const files = [
      { path: "deliverable.md", content: Buffer.from("Actual result") },
    ];
    const legacy = createWorkPackage("p/j", key, files);
    const signature = Buffer.from(
      nacl.sign.detached(
        walletSigningMessage("work-package", legacy.packageHash),
        key.secretKey
      )
    ).toString("hex");
    const work = { ...legacy, signature };
    assert.equal(verifyWorkPackage(work, files), true);
    assert.equal(verifyWorkPackage(legacy, files), true);
    assert.equal(
      verifyWorkPackage(work, [
        { ...files[0], content: Buffer.from("Changed result") },
      ]),
      false
    );
    assert.equal(
      verifyWorkPackage({ ...work, taskId: "other/task" }, files),
      false
    );
    assert.equal(
      verifyDigestSignature(
        "event",
        work.packageHash,
        signature,
        key.publicKey.toBytes()
      ),
      false
    );
  });

  it("validates prepared transactions using wallet-signed agent evidence", async () => {
    const state = new State(),
      reviewer = Keypair.generate();
    for (const actor of [key, reviewer]) {
      const address = actor.publicKey.toBase58();
      const event = walletEvent(
        signEvent(actor, {
          action: "agent.register",
          agent: address,
          name: "Browser agent",
          skills: ["typescript"],
          description: "Test contributor",
          rate: 0,
          binding: Buffer.from(
            nacl.sign.detached(
              Buffer.from("ctrl-mesh:agent-owner:v1:" + address),
              actor.secretKey
            )
          ).toString("hex"),
        }),
        actor
      );
      state.validate(event);
      state.apply({ seq: state.timeline.length + 1, event, receipt: {} });
    }
    const event = walletEvent(
      signEvent(key, {
        action: "project.create",
        project: "wallet-proof",
        title: "Wallet proof",
        brief: "Test signing",
        manager: key.publicKey.toBase58(),
        reviewer: reviewer.publicKey.toBase58(),
        amount: 10000000,
        allowance: 10000000,
        expires: Math.floor(Date.now() / 1000) + 3600,
      }),
      key
    );
    state.validate(event);
    const provider = new anchor.AnchorProvider(
      new Connection("http://127.0.0.1:8899"),
      new anchor.Wallet(key),
      {}
    );
    const program = new anchor.Program(idl as anchor.Idl, provider);
    const tx = (await buildTransaction(event, state, program, key.publicKey))!;
    tx.feePayer = key.publicKey;
    tx.recentBlockhash = Keypair.generate().publicKey.toBase58();
    const context = {
      agents: Object.values(state.agents),
      projects: [],
      jobs: [],
      offers: [],
    };
    await verifyPreparedTransaction(event, tx, context);
    const changed = structuredClone(context);
    changed.agents[0].registration.sig = "0".repeat(128);
    await assert.rejects(
      verifyPreparedTransaction(event, tx, changed),
      /signature/
    );
  });
});
