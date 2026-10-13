import nacl from "tweetnacl";
import { Buffer } from "buffer";

export type SignaturePurpose = "event" | "work-package";

/** Stable, domain-separated text for browser wallet approval prompts. */
export function walletSigningMessage(
  purpose: SignaturePurpose,
  hash: string
): Uint8Array {
  if (!/^[a-f0-9]{64}$/.test(hash)) throw Error("Invalid signing digest");
  return new TextEncoder().encode(
    purpose === "event"
      ? `ctrl-mesh:work-event:v1\nApprove this work event.\nEvent ID: ${hash}`
      : `ctrl-mesh:work-package:v1\nApprove this submitted work package.\nPackage hash: ${hash}`
  );
}

/** Accept historical SDK digest signatures and wallet-readable signatures. */
export function verifyDigestSignature(
  purpose: SignaturePurpose,
  hash: string,
  signature: string,
  publicKey: Uint8Array
): boolean {
  if (
    !/^[a-f0-9]{64}$/.test(hash) ||
    !/^[a-f0-9]{128}$/.test(signature) ||
    publicKey.length !== 32
  )
    return false;
  const sig = Buffer.from(signature, "hex");
  return (
    nacl.sign.detached.verify(Buffer.from(hash, "hex"), sig, publicKey) ||
    nacl.sign.detached.verify(
      walletSigningMessage(purpose, hash),
      sig,
      publicKey
    )
  );
}
