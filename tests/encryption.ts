import { strict as assert } from "assert";
import { Keypair } from "@solana/web3.js";
import nacl from "tweetnacl";
import {
  PRIVATE_ALGORITHM,
  seal,
  unseal,
  verifyKeyRecord,
} from "../src/mesh/encryption";
import { signEvent } from "../src/mesh/events";
describe("private payload authentication", () => {
  const alice = Keypair.generate(),
    bob = Keypair.generate(),
    eve = Keypair.generate();
  const a = alice.publicKey.toBase58(),
    b = bob.publicKey.toBase58();
  const aBox = nacl.box.keyPair(),
    bBox = nacl.box.keyPair();
  const keyEvent = (key: Keypair, box: nacl.BoxKeyPair) =>
    signEvent(key, {
      action: "key.publish",
      algorithm: PRIVATE_ALGORITHM,
      boxKey: Buffer.from(box.publicKey).toString("hex"),
      previous: "",
    });
  const directory = { [a]: keyEvent(alice, aBox), [b]: keyEvent(bob, bBox) };
  const scope = {
    sender: a,
    project: "confidential",
    job: "shared",
    purpose: "note" as const,
  };
  it("authenticates ciphertext, scope, audience, and signed recipient keys", () => {
    const e = seal({ message: "only recipients" }, scope, [b], directory);
    assert.equal(
      unseal(e, b, bBox.secretKey, scope).message,
      "only recipients"
    );
    assert.equal(
      unseal(e, a, aBox.secretKey, scope).message,
      "only recipients"
    );
    assert.throws(
      () =>
        unseal(
          e,
          eve.publicKey.toBase58(),
          nacl.box.keyPair().secretKey,
          scope
        ),
      /decryption key/
    );
    const cipher = structuredClone(e);
    const bytes = Buffer.from(cipher.ciphertext, "base64");
    bytes[0] ^= 1;
    cipher.ciphertext = bytes.toString("base64");
    assert.throws(
      () => unseal(cipher, b, bBox.secretKey, scope),
      /authentication/
    );
    const moved = { ...e, project: "other" };
    assert.throws(
      () => unseal(moved, b, bBox.secretKey, { ...scope, project: "other" }),
      /authentication/
    );
    const stripped = {
      ...e,
      recipients: e.recipients.filter((r) => r.actor === b),
    };
    assert.throws(
      () => unseal(stripped, b, bBox.secretKey, scope),
      /authentication/
    );
    const badDirectory = {
      ...directory,
      [b]: { ...directory[b], sig: "0".repeat(128) },
    };
    assert.throws(() => seal({}, scope, [b], badDirectory), /signed event/);
    assert.throws(
      () =>
        verifyKeyRecord(
          b,
          signEvent(bob, {
            action: "key.publish",
            algorithm: PRIVATE_ALGORITHM,
            boxKey: "0".repeat(64),
            previous: "",
          })
        ),
      /public key/
    );
    const second = seal({ message: "only recipients" }, scope, [b], directory);
    assert.notEqual(e.nonce, second.nonce);
    assert.notEqual(e.ephemeral, second.ephemeral);
    assert.notEqual(e.ciphertext, second.ciphertext);
  });
});
