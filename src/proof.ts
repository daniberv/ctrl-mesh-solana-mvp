import { createHash } from "crypto";
import { Keypair, PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";
import { verifyDigestSignature } from "./mesh/signatures";

export type Artifact = { path: string; sha256: string; bytes: number };
export type WorkPackage = {
  version: 1;
  taskId: string;
  worker: string;
  artifacts: Artifact[];
  packageHash: string;
  signature: string;
};

export function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalPayload(
  taskId: string,
  worker: string,
  artifacts: Artifact[]
): string {
  return JSON.stringify({
    version: 1,
    taskId,
    worker,
    artifacts: artifacts.map((a) => ({
      path: a.path,
      sha256: a.sha256,
      bytes: a.bytes,
    })),
  });
}

function validPath(path: string): boolean {
  return (
    path.length > 0 &&
    !path.startsWith("/") &&
    !path.split("/").includes("..") &&
    !path.includes("\\")
  );
}

export function createWorkPackage(
  taskId: string,
  worker: Keypair,
  files: Array<{ path: string; content: Buffer }>
): WorkPackage {
  if (files.length === 0)
    throw new Error("A work package needs at least one file");
  const artifacts = files
    .map(({ path, content }) => {
      if (!validPath(path)) throw new Error(`Invalid artifact path: ${path}`);
      return { path, sha256: sha256(content), bytes: content.length };
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (new Set(artifacts.map((a) => a.path)).size !== artifacts.length)
    throw new Error("Duplicate artifact path");
  const workerAddress = worker.publicKey.toBase58();
  const packageHash = sha256(
    canonicalPayload(taskId, workerAddress, artifacts)
  );
  const signature = Buffer.from(
    nacl.sign.detached(Buffer.from(packageHash, "hex"), worker.secretKey)
  ).toString("hex");
  return {
    version: 1,
    taskId,
    worker: workerAddress,
    artifacts,
    packageHash,
    signature,
  };
}

export function verifyWorkPackage(
  work: WorkPackage,
  files: Array<{ path: string; content: Buffer }>
): boolean {
  try {
    if (
      work.version !== 1 ||
      work.artifacts.length === 0 ||
      files.length !== work.artifacts.length
    )
      return false;
    if (work.artifacts.some((a) => !validPath(a.path))) return false;
    const paths = work.artifacts.map((a) => a.path);
    if (
      new Set(paths).size !== paths.length ||
      paths.some((p, i) => i > 0 && paths[i - 1] > p)
    )
      return false;
    const actual = new Map(
      files.map(({ path, content }) => [
        path,
        { sha256: sha256(content), bytes: content.length },
      ])
    );
    if (actual.size !== files.length) return false;
    if (
      work.artifacts.some(
        (a) =>
          actual.get(a.path)?.sha256 !== a.sha256 ||
          actual.get(a.path)?.bytes !== a.bytes
      )
    )
      return false;
    const expectedHash = sha256(
      canonicalPayload(work.taskId, work.worker, work.artifacts)
    );
    if (expectedHash !== work.packageHash) return false;
    return verifyDigestSignature(
      "work-package",
      work.packageHash,
      work.signature,
      new PublicKey(work.worker).toBytes()
    );
  } catch {
    return false;
  }
}
