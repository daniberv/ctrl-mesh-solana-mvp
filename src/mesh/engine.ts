import { EventEmitter } from "events";
import { SendTransactionError, Transaction } from "@solana/web3.js";
import bs58 from "bs58";
import { Chain } from "./chain";
import { Entry, MeshEvent } from "./events";
import { State } from "./state";
import { Store } from "./store";
export class Engine extends EventEmitter {
  state = new State();
  private prepared = new Map<string, { message: Buffer; time: number }>();
  private queue: Promise<any> = Promise.resolve();
  constructor(
    public store: Store,
    public chain: Chain,
    public readOnly = false
  ) {
    super();
    if (!readOnly && store.meta("upstream"))
      throw Error(
        "A replicated journal must stay read-only; automatic promotion is disabled"
      );
    for (const entry of store.entries()) this.state.apply(entry);
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
      const prior = this.store.get(event.id);
      if (prior) return { entry: prior };
      await this.recover();
      this.state.validate(event);
      const tx = await this.chain.prepare(event, this.state);
      if (!tx) return { transaction: null };
      this.prepared.set(event.id, {
        message: tx.serializeMessage(),
        time: Date.now(),
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
      const prior = this.store.get(event.id);
      if (prior) return prior;
      await this.recover();
      this.state.validate(event);
      const required = await this.chain.prepare(event, this.state);
      let receipt = {};
      if (required) {
        const preparation = this.prepared.get(event.id);
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
        this.store.saveCommand(event, raw.toString("base64"), signature);
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
            this.store.fail(event.id);
            throw error;
          }
          await this.recover();
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
      return this.append(event, receipt);
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
  async recover() {
    for (const command of this.store.pending()) {
      const event = JSON.parse(command.event) as MeshEvent;
      const status = (
        await this.chain.connection.getSignatureStatuses([command.signature], {
          searchTransactionHistory: true,
        })
      ).value[0];
      if (status?.err) {
        this.store.fail(event.id);
        continue;
      }
      if (
        status &&
        ["confirmed", "finalized"].includes(status.confirmationStatus || "")
      ) {
        this.append(
          event,
          await this.chain.attachState(
            event,
            this.state,
            await this.chain.receipt(event, command.signature)
          )
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
        this.store.fail(event.id);
        continue;
      }
      await this.chain.connection
        .sendRawTransaction(Buffer.from(command.transaction_bytes, "base64"))
        .catch(() => {});
      throw Error("A prior transaction is pending; retry after reconciliation");
    }
  }
}
