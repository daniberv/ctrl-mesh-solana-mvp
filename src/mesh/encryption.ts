// Portable client-side encryption. This module never needs relay or wallet signing secrets.
import nacl from "tweetnacl";
import { Buffer } from "buffer";
import { sha256 } from "@noble/hashes/sha256";
import { PublicKey } from "@solana/web3.js";
import type { MeshEvent } from "./events";
import { verifyDigestSignature } from "./signatures";
export const PRIVATE_ALGORITHM = "x25519-xsalsa20-poly1305-v1";
export const SEALED_FILE = "sealed.mesh.json";
export type KeyDirectory = Record<string, MeshEvent>;
export type Recipient = {
  actor: string;
  keyEvent: string;
  boxKey: string;
  nonce: string;
  wrapped: string;
};
export type Sealed = {
  version: 1;
  algorithm: typeof PRIVATE_ALGORITHM;
  sender: string;
  project: string;
  job?: string;
  purpose: "note" | "artifact";
  ephemeral: string;
  nonce: string;
  ciphertext: string;
  recipients: Recipient[];
};
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
const json = (v: any): string =>
  v === null || typeof v !== "object"
    ? JSON.stringify(v)
    : Array.isArray(v)
    ? "[" + v.map(json).join(",") + "]"
    : "{" +
      Object.keys(v)
        .sort()
        .map((k) => JSON.stringify(k) + ":" + json(v[k]))
        .join(",") +
      "}";
function bytes(value: string, size?: number) {
  if (typeof value !== "string") throw Error("Invalid encrypted encoding");
  const b = Buffer.from(value, "base64");
  if (
    b.toString("base64") !== value ||
    (size !== undefined && b.length !== size)
  )
    throw Error("Invalid encrypted encoding");
  return b;
}
export function verifySignedEnvelope(event: MeshEvent): any {
  if (!event) throw Error("Signed event required");
  const id = hex(
    sha256(
      Buffer.from(
        JSON.stringify([
          0,
          event.pubkey,
          event.created_at,
          event.kind,
          event.tags,
          event.content,
        ])
      )
    )
  );
  if (
    id !== event.id ||
    !verifyDigestSignature(
      "event",
      id,
      event.sig,
      Buffer.from(event.pubkey, "hex")
    ) ||
    !/^[a-f0-9]{64}$/.test(event.pubkey)
  )
    throw Error("Invalid signed event");
  return JSON.parse(event.content);
}
export function verifyKeyRecord(actor: string, event: MeshEvent): string {
  if (!event)
    throw Error("Recipient has not published an encryption key: " + actor);
  const c = verifySignedEnvelope(event);
  if (new PublicKey(Buffer.from(event.pubkey, "hex")).toBase58() !== actor)
    throw Error("Invalid signed encryption key");
  if (
    c.action !== "key.publish" ||
    event.kind !== 30002 ||
    json(event.tags) !== '[["s","public"]]' ||
    !/^[a-f0-9]{64}$/.test(c.boxKey) ||
    c.algorithm !== PRIVATE_ALGORITHM
  )
    throw Error("Invalid encryption key binding");
  // Reject low-order Curve25519 keys rather than accepting a public shared secret.
  const probe = nacl.scalarMult(
    new Uint8Array(32).fill(7),
    Buffer.from(c.boxKey, "hex")
  );
  if (probe.every((x) => x === 0)) throw Error("Invalid encryption public key");
  return c.boxKey;
}
const binding = (e: Omit<Sealed, "ciphertext"> | Sealed) => ({
  version: e.version,
  algorithm: e.algorithm,
  sender: e.sender,
  project: e.project,
  job: e.job || "",
  purpose: e.purpose,
  ephemeral: e.ephemeral,
  nonce: e.nonce,
  recipients: e.recipients.map((r) => ({
    actor: r.actor,
    keyEvent: r.keyEvent,
    boxKey: r.boxKey,
  })),
});
export function validateSealed(e: Sealed) {
  if (
    !e ||
    e.version !== 1 ||
    e.algorithm !== PRIVATE_ALGORITHM ||
    !["note", "artifact"].includes(e.purpose) ||
    typeof e.project !== "string" ||
    !e.project ||
    !/^[a-f0-9]{64}$/.test(e.ephemeral) ||
    !Array.isArray(e.recipients) ||
    e.recipients.length < 1 ||
    e.recipients.length > 32 ||
    new Set(e.recipients.map((r) => r.actor)).size !== e.recipients.length
  )
    throw Error("Invalid sealed envelope");
  new PublicKey(e.sender);
  bytes(e.nonce, 24);
  if (bytes(e.ciphertext).length < 16 || e.ciphertext.length > 600000)
    throw Error("Invalid ciphertext size");
  for (const r of e.recipients) {
    new PublicKey(r.actor);
    if (!/^[a-f0-9]{64}$/.test(r.keyEvent) || !/^[a-f0-9]{64}$/.test(r.boxKey))
      throw Error("Invalid recipient key");
    bytes(r.nonce, 24);
    bytes(r.wrapped, 80);
  }
}
export function seal(
  data: any,
  scope: {
    sender: string;
    project: string;
    job?: string;
    purpose: "note" | "artifact";
  },
  recipients: string[],
  directory: KeyDirectory
): Sealed {
  const selected = [...new Set([scope.sender, ...recipients])].sort();
  if (selected.length > 32) throw Error("Maximum 32 encrypted recipients");
  const ephemeral = nacl.box.keyPair(),
    contentKey = nacl.randomBytes(32);
  const envelope: Sealed = {
    version: 1,
    algorithm: PRIVATE_ALGORITHM,
    ...scope,
    ephemeral: hex(ephemeral.publicKey),
    nonce: b64(nacl.randomBytes(24)),
    ciphertext: "",
    recipients: selected.map((actor) => ({
      actor,
      keyEvent: directory[actor]?.id,
      boxKey: verifyKeyRecord(actor, directory[actor]),
      nonce: b64(nacl.randomBytes(24)),
      wrapped: "",
    })),
  };
  const bound = binding(envelope),
    bindingHash = sha256(Buffer.from(json(bound)));
  for (const recipient of envelope.recipients)
    recipient.wrapped = b64(
      nacl.box(
        Buffer.concat([contentKey, bindingHash]),
        bytes(recipient.nonce),
        Buffer.from(recipient.boxKey, "hex"),
        ephemeral.secretKey
      )
    );
  envelope.ciphertext = b64(
    nacl.secretbox(
      Buffer.from(json({ binding: bound, data })),
      bytes(envelope.nonce),
      contentKey
    )
  );
  contentKey.fill(0);
  ephemeral.secretKey.fill(0);
  validateSealed(envelope);
  return envelope;
}
export function unseal(
  e: Sealed,
  actor: string,
  secretKey: Uint8Array,
  scope: {
    project: string;
    job?: string;
    purpose: "note" | "artifact";
    sender: string;
  }
) {
  validateSealed(e);
  if (
    e.project !== scope.project ||
    (e.job || "") !== (scope.job || "") ||
    e.sender !== scope.sender ||
    e.purpose !== scope.purpose
  )
    throw Error("Encrypted scope mismatch");
  const r = e.recipients.find((r) => r.actor === actor);
  if (
    !r ||
    r.boxKey !== hex(nacl.box.keyPair.fromSecretKey(secretKey).publicKey)
  )
    throw Error("No decryption key for this recipient/version");
  const bound = binding(e),
    expectedHash = sha256(Buffer.from(json(bound)));
  const wrapped = nacl.box.open(
    bytes(r.wrapped),
    bytes(r.nonce),
    Buffer.from(e.ephemeral, "hex"),
    secretKey
  );
  if (
    !wrapped ||
    wrapped.length !== 64 ||
    !nacl.verify(wrapped.subarray(32), expectedHash)
  )
    throw Error("Encrypted key authentication failed");
  const clear = nacl.secretbox.open(
    bytes(e.ciphertext),
    bytes(e.nonce),
    wrapped.subarray(0, 32)
  );
  wrapped.fill(0);
  if (!clear) throw Error("Ciphertext authentication failed");
  const result = JSON.parse(Buffer.from(clear).toString());
  clear.fill(0);
  if (json(result.binding) !== json(bound))
    throw Error("Encrypted payload binding mismatch");
  return result.data;
}
