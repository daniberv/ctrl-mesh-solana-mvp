import { EventEmitter } from "events";
import { SendTransactionError, Transaction } from "@solana/web3.js";
import bs58 from "bs58";
import { Chain } from "./chain";
import { Entry, MeshEvent } from "./events";
import { State } from "./state";
import { Store } from "./store";
import { Action, Consensus, Unavailable } from "./consensus";
import { verifyEvent } from "./events";
import { randomUUID } from "crypto";
import { AccountAction, AccountCommand } from "./accounts";
export class Engine extends EventEmitter {
  state = new State();
  consensus?: Consensus;
  private prepared = new Map<
    string,
    { message: Buffer; time: number; term?: number }
  >();
  private queue: Promise<any> = Promise.resolve();
  constructor(
    public store: Store,
    public chain: Chain,
    public readOnly = false,
    highAvailability = false
  ) {
    super();
    if (store.meta("ha.retired"))
      throw Error(
        "This journal was migrated to HA; start the configured cluster instead"
      );
    if (!highAvailability && store.meta("ha.config"))
      throw Error(
        "This journal requires its HA cluster; standalone writes are fenced"
      );
    if (!readOnly && store.meta("upstream") && !highAvailability)
      throw Error(
        "A replicated journal must stay read-only; automatic promotion is disabled"
      );
    for (const entry of store.entries()) this.state.apply(entry);
  }
  /** Only committed consensus actions reach the application journal or outbox. */
  applyConsensus(action: Action) {
    if (action.type === "barrier") return;
    if (action.type === "account") {
      for (const hash of this.store.accounts.apply(action))
        this.emit("session.revoked", hash);
      return;
    }
    if (action.type === "session.create") {
      this.store.saveBrowserSession(
        action.hash,
        action.actor,
        action.expires,
        action.previous
      );
      if (action.previous) this.emit("session.revoked", action.previous);
      return;
    }
    if (action.type === "session.revoke") {
      this.store.revokeBrowserSession(action.hash);
      this.emit("session.revoked", action.hash);
      return;
    }
    if (action.type === "failed") {
      this.store.fail(action.id);
      return;
    }
    verifyEvent(action.event);
    if (this.store.get(action.event.id)) return;
    this.state.validate(action.event, action.event.created_at);
    if (action.type === "intent") {
      const tx = Transaction.from(Buffer.from(action.transaction, "base64"));
      if (
        !tx.verifySignatures() ||
        bs58.encode(tx.signature!) !== action.signature
      )
        throw Error("Invalid replicated transaction signatures");
      this.store.saveCommand(
        action.event,
        action.transaction,
        action.signature
      );
    } else this.append(action.event, action.receipt);
  }
  async readBarrier() {
    await this.consensus?.barrier();
  }
  async account(command: AccountCommand) {
    if (this.readOnly) throw Error("Sign in through the coordinator relay");
    return this.serial(async () => {
      const term = await this.consensus?.barrier();
      const action: AccountAction = {
        type: "account",
        id: randomUUID(),
        now: Date.now(),
        command,
      };
      this.store.accounts.validate(action);
      if (this.consensus) await this.consensus.propose(action, term);
      else this.applyConsensus(action);
    });
  }
  async recordSession(
    action: Extract<Action, { type: "session.create" | "session.revoke" }>
  ) {
    if (this.readOnly) throw Error("Sign in through the coordinator relay");
    return this.serial(async () => {
      const term = await this.consensus?.barrier();
      if (this.consensus) await this.consensus.propose(action, term);
      else this.applyConsensus(action);
    });
  }
  private async record(event: MeshEvent, receipt: any, term?: number) {
    if (!this.consensus) return this.append(event, receipt);
    await this.consensus.propose({ type: "entry", event, receipt }, term);
    return this.store.get(event.id)!;
  }
  private async failed(id: string, term?: number) {
    if (this.consensus)
      await this.consensus.propose({ type: "failed", id }, term);
    else this.store.fail(id);
  }
  serial<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.queue.then(fn);
    this.queue = result.catch(() => {});
    return result;
  }
  async prepare(event: MeshEvent) {
    if (this.readOnly)
      throw Error(
        "Replica is read-only; publish through the coordinator relay"
      );
    return this.serial(async () => {
      const term = await this.consensus?.barrier();
      const prior = this.store.get(event.id);
      if (prior) return { entry: prior };
      await this.recover(term);
      if (this.store.get(event.id)) return { entry: this.store.get(event.id)! };
      this.state.validate(event);
      const tx = await this.chain.prepare(event, this.state);
      this.consensus?.assertLeader(term);
      if (!tx) return { transaction: null };
      this.prepared.set(event.id, {
        message: tx.serializeMessage(),
        time: Date.now(),
        term,
      });
      for (const [id, p] of this.prepared)
        if (Date.now() - p.time > 120000) this.prepared.delete(id);
      return {
        transaction: tx
          .serialize({ requireAllSignatures: false })
          .toString("base64"),
      };
    });
  }
  async commit(event: MeshEvent, serialized?: string): Promise<Entry> {
    if (this.readOnly)
      throw Error(
        "Replica is read-only; publish through the coordinator relay"
      );
    return this.serial(async () => {
      const term = await this.consensus?.barrier();
      const prior = this.store.get(event.id);
      if (prior) return prior;
      await this.recover(term);
      if (this.store.get(event.id)) return this.store.get(event.id)!;
      this.state.validate(event);
      const required = await this.chain.prepare(event, this.state);
      this.consensus?.assertLeader(term);
      let receipt = {};
      if (required) {
        const preparation = this.prepared.get(event.id);
        if (this.consensus && (!preparation || preparation.term !== term))
          throw new Unavailable(
            "Preparation expired after coordinator change; prepare the same signed event again"
          );
        if (!preparation || !serialized)
          throw Error("Prepare signed transaction first");
        const tx = Transaction.from(Buffer.from(serialized, "base64"));
        if (!tx.serializeMessage().equals(preparation.message))
          throw Error("Transaction differs from prepared command");
        if (!tx.verifySignatures(false))
          throw Error("Invalid transaction signature");
        // Never accept a missing actor signature; the sponsor supplies only the fee payer signature.
        const actor = Buffer.from(event.pubkey, "hex");
        const signer = tx.signatures.find((s) =>
          s.publicKey.toBuffer().equals(actor)
        );
        if (!signer?.signature) throw Error("Actor must sign transaction");
        tx.partialSign(this.chain.sponsor);
        const raw = tx.serialize();
        const signature = bs58.encode(tx.signature!);
        if (this.consensus) {
          await this.consensus.propose(
            {
              type: "intent",
              event,
              transaction: raw.toString("base64"),
              signature,
            },
            term
          );
          this.consensus.assertLeader(term);
        } else this.store.saveCommand(event, raw.toString("base64"), signature);
        try {
          await this.chain.connection.sendRawTransaction(raw, {
            skipPreflight: false,
          });
          await this.chain.connection.confirmTransaction(
            signature,
            "confirmed"
          );
        } catch (error) {
          if (
            error instanceof SendTransactionError &&
            error.message.includes("Simulation failed")
          ) {
            await this.failed(event.id, term);
            throw error;
          }
          await this.recover(term);
          const recovered = this.store.get(event.id);
          if (recovered) return recovered;
          throw error;
        }
        receipt = await this.chain.attachState(
          event,
          this.state,
          await this.chain.receipt(event, signature)
        );
      }
      return this.record(event, receipt, term);
    });
  }
  append(event: MeshEvent, receipt: any) {
    const prior = this.store.get(event.id);
    if (prior) return prior;
    const entry = this.store.append(event, receipt);
    this.state.apply(entry);
    this.prepared.delete(event.id);
    this.emit("event", entry);
    return entry;
  }
  async importEntry(entry: Entry) {
    if (!this.readOnly) throw Error("Replication requires a read-only engine");
    return this.serial(async () => {
      if (entry.seq !== this.store.head() + 1 || this.store.get(entry.event.id))
        throw Error("Replication sequence conflict");
      this.state.validate(entry.event, entry.event.created_at);
      const receipt = await this.chain.verifyHistorical(
        entry.event,
        this.state,
        entry.receipt
      );
      return this.append(entry.event, receipt);
    });
  }
  async verifyHeads() {
    const heads = new Map<string, Entry>();
    for (const entry of this.state.timeline) {
      if (!entry.receipt.signature) continue;
      const command = JSON.parse(entry.event.content);
      const scope = entry.receipt.chain
        ? "job:" + command.job
        : "project:" + command.project;
      heads.set(scope, entry);
    }
    for (const entry of heads.values()) {
      await this.chain.attachState(entry.event, this.state, {
        ...entry.receipt,
      });
    }
  }
  async recover(term = this.consensus?.assertLeader()) {
    for (const command of this.store.pending()) {
      const event = JSON.parse(command.event) as MeshEvent;
      const status = (
        await this.chain.connection.getSignatureStatuses([command.signature], {
          searchTransactionHistory: true,
        })
      ).value[0];
      if (status?.err) {
        await this.failed(event.id, term);
        continue;
      }
      if (
        status &&
        ["confirmed", "finalized"].includes(status.confirmationStatus || "")
      ) {
        await this.record(
          event,
          await this.chain.attachState(
            event,
            this.state,
            await this.chain.receipt(event, command.signature)
          ),
          term
        );
        continue;
      }
      const tx = Transaction.from(
        Buffer.from(command.transaction_bytes, "base64")
      );
      if (
        !status &&
        !(await this.chain.connection.isBlockhashValid(tx.recentBlockhash!))
          .value
      ) {
        await this.failed(event.id, term);
        continue;
      }
      this.consensus?.assertLeader(term);
      await this.chain.connection
        .sendRawTransaction(Buffer.from(command.transaction_bytes, "base64"))
        .catch(() => {});
      if (this.consensus)
        throw new Unavailable(
          "A prior transaction is pending; retry after reconciliation"
        );
      throw Error("A prior transaction is pending; retry after reconciliation");
    }
  }
}
