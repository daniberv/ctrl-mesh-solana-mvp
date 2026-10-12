import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { createHash } from "crypto";
import { strict as assert } from "assert";
import { Keypair, PublicKey, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { CtrlMeshMvp } from "../target/types/ctrl_mesh_mvp";
import { createWorkPackage, verifyWorkPackage } from "../src/proof";

describe("ctrl-mesh escrow", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.CtrlMeshMvp as Program<CtrlMeshMvp>;
  const owner = provider.wallet.publicKey;

  async function fund(key: PublicKey) {
    const signature = await provider.connection.requestAirdrop(key, LAMPORTS_PER_SOL / 10);
    const blockhash = await provider.connection.getLatestBlockhash();
    await provider.connection.confirmTransaction({ signature, ...blockhash }, "confirmed");
  }

  function taskAddress(id: number): PublicKey {
    const bytes = new anchor.BN(id).toArrayLike(Buffer, "le", 8);
    return PublicKey.findProgramAddressSync([Buffer.from("task"), owner.toBuffer(), bytes], program.programId)[0];
  }

  async function create(id: number, worker: Keypair, approver: Keypair, deadline: number) {
    const task = taskAddress(id);
    const amount = LAMPORTS_PER_SOL / 100;
    await program.methods.createTask(
      new anchor.BN(id), worker.publicKey, approver.publicKey,
      new anchor.BN(amount), new anchor.BN(deadline),
    ).accountsStrict({ owner, task, systemProgram: SystemProgram.programId }).rpc();
    return { task, amount };
  }

  it("links an accepted package hash to one payout and rejects tampering or replay", async () => {
    const worker = Keypair.generate();
    const approver = Keypair.generate();
    const outsider = Keypair.generate();
    await fund(worker.publicKey);
    await fund(approver.publicKey);
    await fund(outsider.publicKey);
    const id = Date.now();
    const { task, amount } = await create(id, worker, approver, Math.floor(Date.now() / 1000) + 120);
    const files = [{ path: "deliverables/summary.md", content: Buffer.from("real work package v1") }];
    const proof = createWorkPackage(String(id), worker, files);
    assert.equal(verifyWorkPackage(proof, files), true);
    const hash = [...Buffer.from(proof.packageHash, "hex")];
    const wrongHash = [...createHash("sha256").update("changed work package").digest()];
    const before = await provider.connection.getBalance(worker.publicKey);

    await program.methods.submitWork(hash).accountsStrict({ task, worker: worker.publicKey }).signers([worker]).rpc();
    await assert.rejects(
      program.methods.acceptWork(wrongHash).accountsStrict({ task, approver: approver.publicKey, worker: worker.publicKey }).signers([approver]).rpc(),
      /PackageHashMismatch|Package hash does not match/,
    );
    await assert.rejects(
      program.methods.acceptWork(hash).accountsStrict({ task, approver: outsider.publicKey, worker: worker.publicKey }).signers([outsider]).rpc(),
      /ConstraintHasOne|has_one/,
    );
    await program.methods.acceptWork(hash).accountsStrict({ task, approver: approver.publicKey, worker: worker.publicKey }).signers([approver]).rpc();
    const after = await provider.connection.getBalance(worker.publicKey);
    assert.equal(after - before, amount);
    const state = await program.account.task.fetch(task);
    assert.equal(state.state, 2);
    assert.deepEqual(state.packageHash, hash);
    await assert.rejects(
      program.methods.acceptWork(hash).accountsStrict({ task, approver: approver.publicKey, worker: worker.publicKey }).signers([approver]).rpc(),
      /WrongState|wrong state/,
    );
  });

  it("allows only the owner to refund an expired, unpaid task", async () => {
    const worker = Keypair.generate();
    const approver = Keypair.generate();
    await fund(worker.publicKey);
    const { task, amount } = await create(Date.now() + 1, worker, approver, Math.floor(Date.now() / 1000) + 3);
    await assert.rejects(
      program.methods.refundExpired().accountsStrict({ task, owner }).rpc(),
      /DeadlineNotPassed|Deadline has not passed/,
    );
    await new Promise((resolve) => setTimeout(resolve, 5000));
    const before = await provider.connection.getBalance(task);
    await program.methods.refundExpired().accountsStrict({ task, owner }).rpc();
    const after = await provider.connection.getBalance(task);
    assert.equal(before - after, amount);
    const state = await program.account.task.fetch(task);
    assert.equal(state.state, 3);
    await assert.rejects(
      program.methods.refundExpired().accountsStrict({ task, owner }).rpc(),
      /WrongState|wrong state/,
    );
  });
});
