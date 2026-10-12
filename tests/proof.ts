import { strict as assert } from "assert";
import { Keypair } from "@solana/web3.js";
import { createWorkPackage, verifyWorkPackage } from "../src/proof";

describe("signed work package", () => {
  it("verifies the worker signature and exact file bytes", () => {
    const worker = Keypair.generate();
    const files = [{ path: "deliverables/summary.md", content: Buffer.from("Final review v1") }];
    const proof = createWorkPackage("task-1", worker, files);
    assert.equal(verifyWorkPackage(proof, files), true);
    assert.equal(verifyWorkPackage(proof, [{ ...files[0], content: Buffer.from("Final review v2") }]), false);
    assert.equal(verifyWorkPackage({ ...proof, taskId: "task-2" }, files), false);
    assert.equal(verifyWorkPackage({ ...proof, signature: "00" }, files), false);
  });
});
