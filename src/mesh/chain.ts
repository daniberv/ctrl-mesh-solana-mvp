import { buildTransaction } from "./transaction";
import * as anchor from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  VersionedTransaction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import { NetworkInfo } from "./network";
import { readFileSync } from "fs";
import {
  address,
  canonical,
  digest,
  MeshEvent,
  Receipt,
  verifyEvent,
} from "./events";
import { projectReceipt } from "./projection";
import { State } from "./state";
const bn = (v: number) => new anchor.BN(v);
const pk = (v: string) => new PublicKey(v);
const hash = (v: string) => [...Buffer.from(v, "hex")];
const idNumber = (v: string) =>
  new anchor.BN(Buffer.from(digest(v).slice(0, 16), "hex"), "le");
export class Chain {
  connection: Connection;
  program: anchor.Program;
  sponsor: Keypair;
  network?: NetworkInfo;
  constructor(rpc: string, sponsor: Keypair) {
    this.sponsor = sponsor;
    this.connection = new Connection(rpc, "confirmed");
    const provider = new anchor.AnchorProvider(
      this.connection,
      new anchor.Wallet(sponsor),
      { commitment: "confirmed" }
    );
    this.program = new anchor.Program(
      JSON.parse(readFileSync("target/idl/ctrl_mesh_mvp.json", "utf8")),
      provider
    );
  }
  projectAddress(owner: string, id: string) {
    return PublicKey.findProgramAddressSync(
      [
        Buffer.from("project"),
        pk(owner).toBuffer(),
        idNumber(id).toArrayLike(Buffer, "le", 8),
      ],
      this.program.programId
    )[0];
  }
  jobAddress(project: string, id: string) {
    return PublicKey.findProgramAddressSync(
      [
        Buffer.from("job"),
        pk(project).toBuffer(),
        idNumber(id).toArrayLike(Buffer, "le", 8),
      ],
      this.program.programId
    )[0];
  }
  async prepare(event: MeshEvent, state: State): Promise<Transaction | null> {
    const tx = await buildTransaction(
      event,
      state,
      this.program,
      this.sponsor.publicKey
    );
    if (!tx) return null;
    tx.feePayer = this.sponsor.publicKey;
    tx.recentBlockhash = (await this.connection.getLatestBlockhash()).blockhash;
    return tx;
  }
  async preflight(tx: Transaction) {
    if (this.network?.network !== "devnet") return;
    const fee = (
      await this.connection.getFeeForMessage(tx.compileMessage(), "confirmed")
    ).value;
    if (fee === null)
      throw Error("Devnet blockhash expired; prepare the transaction again");
    if ((await this.connection.getBalance(this.sponsor.publicKey)) < fee)
      throw Error(
        "The Devnet relay fee payer needs test SOL. Contact the workspace operator."
      );
    const simulation = await this.connection.simulateTransaction(
      new VersionedTransaction(tx.compileMessage()),
      {
        sigVerify: false,
        replaceRecentBlockhash: true,
        commitment: "confirmed",
      }
    );
    if (simulation.value.err) {
      const detail = simulation.value.logs
        ?.filter((line) => /Error Message:|insufficient|failed:/i.test(line))
        .slice(-3)
        .join(" ");
      throw Error(
        "Devnet transaction simulation failed: " +
          (detail || JSON.stringify(simulation.value.err))
      );
    }
  }
  async receipt(event: MeshEvent, signature: string): Promise<Receipt> {
    const c = verifyEvent(event),
      actor = address(event.pubkey);
    const status = await this.connection.getSignatureStatuses([signature], {
      searchTransactionHistory: true,
    });
    if (status.value[0]?.err)
      throw Error(
        "Chain transaction failed: " + JSON.stringify(status.value[0].err)
      );
    if (
      !status.value[0] ||
      !["confirmed", "finalized"].includes(
        status.value[0].confirmationStatus || ""
      )
    )
      throw Error("Transaction awaiting confirmation");
    const tx = await this.connection.getParsedTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    if (!tx || tx.meta?.err) throw Error("Transaction receipt unavailable");
    if (
      !tx.transaction.message.accountKeys.some(
        (k) => k.pubkey.toBase58() === actor && k.signer
      )
    )
      throw Error("Missing actor signature");
    const result: Receipt = {
      signature,
      slot: status.value[0].slot,
      commitment: status.value[0].confirmationStatus!,
    };
    if (c.action === "project.create")
      result.projectAddress = this.projectAddress(actor, c.project!).toBase58();
    return result;
  }
  async verifyHistorical(
    event: MeshEvent,
    state: State,
    supplied: Receipt
  ): Promise<Receipt> {
    const c = verifyEvent(event);
    const expected = await buildTransaction(
      event,
      state,
      this.program,
      this.sponsor.publicKey
    );
    if (!expected) {
      if (Object.keys(supplied).length)
        throw Error("Unexpected off-chain receipt");
      return {};
    }
    if (!supplied.signature)
      throw Error("Historical transaction proof required");
    const firstAvailable = await this.connection.getFirstAvailableBlock();
    if (typeof supplied.slot === "number" && supplied.slot < firstAvailable)
      throw Error(
        "Historical transaction was pruned by RPC; restore an archival ledger before backfill"
      );
    const confirmed = await this.receipt(event, supplied.signature);
    const record = await this.connection.getTransaction(supplied.signature, {
      commitment: "confirmed",
    });
    if (!record || record.meta?.err)
      throw Error("Historical transaction unavailable");
    const tx = Transaction.populate(
      record.transaction.message,
      record.transaction.signatures
    );
    if (!tx.verifySignatures())
      throw Error("Historical transaction signature invalid");
    const rebuilt = (await buildTransaction(
      event,
      state,
      this.program,
      tx.feePayer!,
      // Journals from before explicit fee preparation remain verifiable.
      // Any present budget still has to match our exact limit and price.
      tx.instructions.some((ix) =>
        ix.programId.equals(ComputeBudgetProgram.programId)
      )
    ))!;
    rebuilt.feePayer = tx.feePayer;
    rebuilt.recentBlockhash = tx.recentBlockhash;
    if (!rebuilt.serializeMessage().equals(tx.serializeMessage()))
      throw Error("Historical transaction differs from signed event");
    if (c.action.startsWith("job.")) {
      confirmed.jobAddress =
        state.jobs[c.job!]?.address ||
        this.jobAddress(state.projects[c.project!].address, c.job!).toBase58();
    } else {
      confirmed.projectAddress =
        confirmed.projectAddress || state.projects[c.project!].address;
    }
    const projected = projectReceipt(event, state, confirmed);
    const { commitment: oldFinality, ...old } = supplied;
    const { commitment: newFinality, ...actual } = projected;
    if (canonical(old) !== canonical(actual))
      throw Error("Historical receipt projection mismatch");
    return projected;
  }
  async attachState(
    event: MeshEvent,
    state: State,
    receipt: Receipt
  ): Promise<Receipt> {
    const c = verifyEvent(event);
    if (c.job && c.action.startsWith("job.")) {
      const project = state.projects[c.project!].address;
      const job =
        state.jobs[c.job!]?.address ||
        this.jobAddress(project, c.job!).toBase58();
      const data: any = await (this.program.account as any).job.fetch(pk(job));
      // A pending command is reconciled before subsequent commands are admitted.
      if (Buffer.from(data.lastEvent).toString("hex") !== event.id)
        throw Error("Chain event hash mismatch; reconciliation required");
      receipt.jobAddress = job;
      receipt.chain = {
        revision: data.revision.toNumber(),
        state: data.state,
        root: Buffer.from(data.resultRoot).toString("hex"),
        reviewRoot: Buffer.from(data.reviewRoot).toString("hex"),
        members: data.members.map((x: any) => ({
          worker: x.worker.toBase58(),
          recipient: x.recipient.toBase58(),
          amount: x.amount.toNumber(),
          leaseUntil: x.leaseUntil.toNumber(),
          hash: Buffer.from(x.hash).toString("hex"),
          paid: x.paid,
        })),
      };
    } else if (
      [
        "project.create",
        "project.policy",
        "project.withdraw",
        "epoch.close",
      ].includes(c.action)
    ) {
      const project =
        receipt.projectAddress || state.projects[c.project!].address;
      const data: any = await (this.program.account as any).project.fetch(
        pk(project)
      );
      if (Buffer.from(data.lastEvent).toString("hex") !== event.id)
        throw Error("Project chain event mismatch");
      receipt.projectAddress = project;
    }
    return receipt;
  }
}
