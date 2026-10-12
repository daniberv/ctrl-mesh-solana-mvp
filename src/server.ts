import * as anchor from "@coral-xyz/anchor";
import { createServer, IncomingMessage, ServerResponse } from "http";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { Connection, Keypair, PublicKey, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { createWorkPackage, verifyWorkPackage, WorkPackage } from "./proof";
import { CtrlMeshMvp } from "../target/types/ctrl_mesh_mvp";

const connection = new Connection("http://127.0.0.1:8899", "confirmed");
const owner = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(".demo/owner.json", "utf8"))));
const worker = Keypair.generate();
const approver = Keypair.generate();
const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(owner), { commitment: "confirmed" });
anchor.setProvider(provider);
const idl = JSON.parse(readFileSync("target/idl/ctrl_mesh_mvp.json", "utf8")) as CtrlMeshMvp;
const program = new anchor.Program<CtrlMeshMvp>(idl, provider);
const artifact = { path: "examples/product-update.md", content: readFileSync("examples/product-update.md") };
type Stage = "ready" | "open" | "submitted" | "accepted";
let stage: Stage = "ready";
let taskId = 0;
let task: PublicKey | null = null;
let work: WorkPackage | null = null;
let payoutLamports = 0;
let tamperRejected = false;
let replayRejected = false;
let onchainHash: string | null = null;
const tx: Record<string, string> = {};

function snapshot() {
  return {
    stage,
    network: "Solana localnet",
    programId: program.programId.toBase58(),
    owner: owner.publicKey.toBase58(), worker: worker.publicKey.toBase58(),
    approver: approver.publicKey.toBase58(), taskId,
    task: task?.toBase58() || null,
    amountSol: 0.01,
    artifact: artifact.path,
    fileHash: work?.artifacts[0].sha256 || null,
    packageHash: work?.packageHash || null,
    onchainHash,
    signature: work?.signature || null,
    verified: work ? verifyWorkPackage(work, [artifact]) : false,
    tamperRejected, replayRejected, payoutLamports,
    transactions: tx,
  };
}

async function airdrop(key: PublicKey) {
  const signature = await connection.requestAirdrop(key, LAMPORTS_PER_SOL / 10);
  await connection.confirmTransaction({ signature, ...(await connection.getLatestBlockhash()) }, "confirmed");
}

async function action(name: string) {
  if (name === "create" && stage === "ready") {
    await airdrop(worker.publicKey);
    await airdrop(approver.publicKey);
    taskId = Date.now();
    task = PublicKey.findProgramAddressSync(
      [Buffer.from("task"), owner.publicKey.toBuffer(), new anchor.BN(taskId).toArrayLike(Buffer, "le", 8)],
      program.programId,
    )[0];
    tx.opened = await program.methods.createTask(
      new anchor.BN(taskId), worker.publicKey, approver.publicKey,
      new anchor.BN(LAMPORTS_PER_SOL / 100), new anchor.BN(Math.floor(Date.now() / 1000) + 1800),
    ).accountsStrict({ owner: owner.publicKey, task, systemProgram: SystemProgram.programId }).rpc();
    stage = "open";
  } else if (name === "submit" && stage === "open" && task) {
    work = createWorkPackage(String(taskId), worker, [artifact]);
    if (!verifyWorkPackage(work, [artifact])) throw new Error("Work signature failed verification");
    tx.submitted = await program.methods.submitWork([...Buffer.from(work.packageHash, "hex")])
      .accountsStrict({ task, worker: worker.publicKey }).signers([worker]).rpc();
    stage = "submitted";
  } else if (name === "tamper" && work) {
    const changed = { ...artifact, content: Buffer.from(artifact.content.toString() + "\nchanged") };
    tamperRejected = !verifyWorkPackage(work, [changed]);
  } else if (name === "accept" && stage === "submitted" && task && work) {
    if (!verifyWorkPackage(work, [artifact])) throw new Error("Work signature failed verification");
    const before = await connection.getBalance(worker.publicKey);
    tx.accepted = await program.methods.acceptWork([...Buffer.from(work.packageHash, "hex")])
      .accountsStrict({ task, approver: approver.publicKey, worker: worker.publicKey })
      .signers([approver]).rpc();
    payoutLamports = (await connection.getBalance(worker.publicKey)) - before;
    if (payoutLamports !== LAMPORTS_PER_SOL / 100) throw new Error("Payout amount mismatch");
    onchainHash = Buffer.from((await program.account.task.fetch(task)).packageHash).toString("hex");
    if (onchainHash !== work.packageHash) throw new Error("On-chain package hash mismatch");
    stage = "accepted";
    mkdirSync(".demo", { recursive: true });
    writeFileSync(".demo/web-receipt.json", JSON.stringify(snapshot(), null, 2));
  } else if (name === "replay" && stage === "accepted" && task && work) {
    try {
      await program.methods.acceptWork([...Buffer.from(work.packageHash, "hex")])
        .accountsStrict({ task, approver: approver.publicKey, worker: worker.publicKey })
        .signers([approver]).rpc();
      throw new Error("Duplicate payout unexpectedly succeeded");
    } catch (error) {
      if (String(error).includes("unexpectedly succeeded")) throw error;
      replayRejected = true;
    }
  } else {
    throw new Error("Action is not available in the current task state");
  }
  return snapshot();
}

function json(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(data));
}

function handle(req: IncomingMessage, res: ServerResponse) {
  const path = new URL(req.url || "/", "http://localhost").pathname;
  if (req.method === "GET" && path === "/favicon.ico") { res.writeHead(204); res.end(); return; }
  if (req.method === "GET" && path === "/api/state") return json(res, 200, snapshot());
  if (req.method === "POST" && /^\/api\/(create|submit|tamper|accept|replay)$/.test(path)) {
    action(path.split("/")[2]).then((data) => json(res, 200, data))
      .catch((error) => json(res, 400, { error: String(error) }));
    return;
  }
  const files: Record<string, [string, string]> = {
    "/": ["web/index.html", "text/html; charset=utf-8"],
    "/style.css": ["web/style.css", "text/css; charset=utf-8"],
    "/app.js": ["web/app.js", "text/javascript; charset=utf-8"],
    "/graphic.png": ["web/graphic.png", "image/png"],
  };
  if (req.method !== "GET" || !files[path]) return json(res, 404, { error: "Not found" });
  res.writeHead(200, { "Content-Type": files[path][1], "Cache-Control": "no-store" });
  res.end(readFileSync(files[path][0]));
}

createServer(handle).listen(4173, "127.0.0.1", () => {
  console.log("ctrl-mesh demo: http://127.0.0.1:4173");
  console.log("Local validator required at http://127.0.0.1:8899");
});
