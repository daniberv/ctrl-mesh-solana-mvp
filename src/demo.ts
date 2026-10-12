import * as anchor from "@coral-xyz/anchor";
import { readFileSync, mkdirSync, writeFileSync } from "fs";
import { Connection, Keypair, PublicKey, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { createWorkPackage, verifyWorkPackage } from "./proof";
import { CtrlMeshMvp } from "../target/types/ctrl_mesh_mvp";

async function main() {
  const endpoint = process.env.ANCHOR_PROVIDER_URL || "http://127.0.0.1:8899";
  if (!endpoint.startsWith("http://127.0.0.1:") && !endpoint.startsWith("http://localhost:")) {
    throw new Error("This demo runs against a local validator only");
  }
  const connection = new Connection(endpoint, "confirmed");
  const owner = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(".demo/owner.json", "utf8"))));
  const worker = Keypair.generate();
  const approver = Keypair.generate();
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(owner), { commitment: "confirmed" });
  anchor.setProvider(provider);
  const idl = JSON.parse(readFileSync("target/idl/ctrl_mesh_mvp.json", "utf8")) as CtrlMeshMvp;
  const program = new anchor.Program<CtrlMeshMvp>(idl, provider);
  const taskId = Date.now();
  const amount = LAMPORTS_PER_SOL / 100;
  const task = PublicKey.findProgramAddressSync(
    [Buffer.from("task"), owner.publicKey.toBuffer(), new anchor.BN(taskId).toArrayLike(Buffer, "le", 8)],
    program.programId,
  )[0];
  const artifact = { path: "examples/product-update.md", content: readFileSync("examples/product-update.md") };
  const work = createWorkPackage(String(taskId), worker, [artifact]);
  const hash = [...Buffer.from(work.packageHash, "hex")];

  console.log("\nCTRL-MESH · LOCAL SOLANA DEMO\n");
  console.log(`Owner     ${owner.publicKey.toBase58()}`);
  console.log(`Worker    ${worker.publicKey.toBase58()}`);
  console.log(`Approver  ${approver.publicKey.toBase58()}`);
  console.log(`Task PDA  ${task.toBase58()}\n`);

  for (const key of [worker.publicKey, approver.publicKey]) {
    const signature = await connection.requestAirdrop(key, LAMPORTS_PER_SOL / 10);
    await connection.confirmTransaction({ signature, ...(await connection.getLatestBlockhash()) }, "confirmed");
  }
  const opened = await program.methods.createTask(
    new anchor.BN(taskId), worker.publicKey, approver.publicKey,
    new anchor.BN(amount), new anchor.BN(Math.floor(Date.now() / 1000) + 120),
  ).accountsStrict({ owner: owner.publicKey, task, systemProgram: SystemProgram.programId }).rpc();
  console.log(`1 · Escrow funded: 0.01 SOL · tx ${opened}`);

  if (!verifyWorkPackage(work, [artifact])) throw new Error("Signature verification failed");
  console.log(`2 · Signed artifact: ${artifact.path}`);
  console.log(`    File SHA-256: ${work.artifacts[0].sha256}`);
  console.log(`    Package hash: ${work.packageHash}`);
  console.log("    Ed25519 signature verified: yes");
  const submitted = await program.methods.submitWork(hash)
    .accountsStrict({ task, worker: worker.publicKey }).signers([worker]).rpc();
  console.log(`3 · Work submitted · tx ${submitted}`);

  const changed = { ...artifact, content: Buffer.from(artifact.content.toString() + "\nchanged") };
  console.log(`4 · Changed artifact rejected by verifier: ${!verifyWorkPackage(work, [changed])}`);
  const workerBefore = await connection.getBalance(worker.publicKey);
  const accepted = await program.methods.acceptWork(hash)
    .accountsStrict({ task, approver: approver.publicKey, worker: worker.publicKey })
    .signers([approver]).rpc();
  const workerAfter = await connection.getBalance(worker.publicKey);
  if (workerAfter - workerBefore !== amount) throw new Error("Payout balance did not match escrow amount");
  console.log(`5 · Human acceptance + payout: 0.01 SOL · tx ${accepted}`);
  console.log(`    Package hash on chain: ${Buffer.from((await program.account.task.fetch(task)).packageHash).toString("hex")}`);
  try {
    await program.methods.acceptWork(hash)
      .accountsStrict({ task, approver: approver.publicKey, worker: worker.publicKey })
      .signers([approver]).rpc();
    throw new Error("Duplicate payout was unexpectedly accepted");
  } catch (error) {
    if (String(error).includes("unexpectedly accepted")) throw error;
    console.log("6 · Duplicate payout rejected by program: yes");
  }
  mkdirSync(".demo", { recursive: true });
  writeFileSync(".demo/receipt.json", JSON.stringify({
    network: "localnet", task: task.toBase58(), package: work,
    transactions: { opened, submitted, accepted }, payoutLamports: amount,
  }, null, 2));
  console.log("\nReceipt: .demo/receipt.json\n");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
