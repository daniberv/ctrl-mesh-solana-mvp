import { createHash } from "crypto";
import { Keypair, PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";

export type MeshEvent = {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
};
export type Command = {
  action: string;
  project?: string;
  job?: string;
  revision?: number;
  [key: string]: any;
};
export type Receipt = {
  signature?: string;
  slot?: number;
  commitment?: string;
  projectAddress?: string;
  jobAddress?: string;
  chain?: any;
};
export type Entry = { seq: number; event: MeshEvent; receipt: Receipt };
export const kinds: Record<string, number> = {
  "project.withdraw": 30041,
  "job.reclaim": 30025,
  "agent.register": 30001,
  "project.create": 30000,
  "project.policy": 30040,
  "job.open": 30010,
  "offer.publish": 30011,
  "job.award": 30012,
  "job.submit": 30110,
  "job.review": 30020,
  "job.accept": 30021,
  "job.claim": 30085,
  "job.cancel": 30022,
  "job.release": 30023,
  "job.renew": 30024,
  progress: 1,
  "epoch.close": 30086,
};
export function canonical(value: any): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  return (
    "{" +
    Object.keys(value)
      .sort()
      .map((k) => JSON.stringify(k) + ":" + canonical(value[k]))
      .join(",") +
    "}"
  );
}
export const digest = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
export const address = (hex: string) =>
  new PublicKey(Buffer.from(hex, "hex")).toBase58();
export function signEvent(key: Keypair, command: Command): MeshEvent {
  const pubkey = Buffer.from(key.publicKey.toBytes()).toString("hex");
  const created_at = Math.floor(Date.now() / 1000);
  const kind = kinds[command.action] ?? 22242;
  const tags = [
    ["s", command.project || "public"],
    ...(command.job ? [["d", command.job]] : []),
  ];
  const content = canonical(command);
  const id = digest(
    JSON.stringify([0, pubkey, created_at, kind, tags, content])
  );
  return {
    id,
    pubkey,
    created_at,
    kind,
    tags,
    content,
    sig: Buffer.from(
      nacl.sign.detached(Buffer.from(id, "hex"), key.secretKey)
    ).toString("hex"),
  };
}
export function verifyEvent(e: MeshEvent): Command {
  if (
    !e ||
    !/^[a-f0-9]{64}$/.test(e.id) ||
    !/^[a-f0-9]{64}$/.test(e.pubkey) ||
    !/^[a-f0-9]{128}$/.test(e.sig) ||
    !Number.isSafeInteger(e.created_at) ||
    !Number.isSafeInteger(e.kind) ||
    !Array.isArray(e.tags) ||
    typeof e.content !== "string" ||
    Buffer.byteLength(e.content) > 512 * 1024
  )
    throw Error("Malformed event");
  if (
    e.tags.some(
      (t) => !Array.isArray(t) || t.some((v) => typeof v !== "string")
    )
  )
    throw Error("Malformed tags");
  if (
    digest(
      JSON.stringify([0, e.pubkey, e.created_at, e.kind, e.tags, e.content])
    ) !== e.id ||
    !nacl.sign.detached.verify(
      Buffer.from(e.id, "hex"),
      Buffer.from(e.sig, "hex"),
      Buffer.from(e.pubkey, "hex")
    )
  )
    throw Error("Invalid event signature");
  const c = JSON.parse(e.content) as Command;
  if (
    canonical(c) !== e.content ||
    typeof c.action !== "string" ||
    e.kind !== (kinds[c.action] ?? 22242)
  )
    throw Error("Noncanonical event");
  if (
    canonical(e.tags) !==
    canonical([["s", c.project || "public"], ...(c.job ? [["d", c.job]] : [])])
  )
    throw Error("Scope mismatch");
  return c;
}
