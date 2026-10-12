import nacl from "tweetnacl";
import * as anchor from "@coral-xyz/anchor";
import {
  PublicKey,
  SystemProgram,
  Transaction,
  Connection,
} from "@solana/web3.js";
import { sha256 } from "@noble/hashes/sha256";
import { Buffer } from "buffer";
import type { MeshEvent } from "./events";
import type { State } from "./state";
import idl from "../../target/idl/ctrl_mesh_mvp.json";
const bn = (v: number) => new anchor.BN(v);
const pk = (v: string | Buffer) => new PublicKey(v);
const hash = (v: string) => [...Buffer.from(v, "hex")];
const idNumber = (v: string) =>
  new anchor.BN(Buffer.from(sha256(Buffer.from(v))).subarray(0, 8), "le");
export function projectAddress(
  owner: string,
  id: string,
  programId: PublicKey
) {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("project"),
      pk(owner).toBuffer(),
      idNumber(id).toArrayLike(Buffer, "le", 8),
    ],
    programId
  )[0];
}
export function jobAddress(project: string, id: string, programId: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("job"),
      pk(project).toBuffer(),
      idNumber(id).toArrayLike(Buffer, "le", 8),
    ],
    programId
  )[0];
}
export async function buildTransaction(
  event: MeshEvent,
  state: State,
  program: anchor.Program,
  sponsor: PublicKey
): Promise<Transaction | null> {
  const c = JSON.parse(event.content),
    actor = pk(Buffer.from(event.pubkey, "hex")),
    eh = hash(event.id),
    m = program.methods;
  const p = state.projects[c.project!],
    j = state.jobs[c.job!];
  let method: any;
  if (c.action === "project.create")
    method = m
      .projectCreate(
        idNumber(c.project!),
        pk(c.manager),
        pk(c.reviewer),
        bn(c.allowance),
        bn(c.expires),
        bn(c.amount),
        eh
      )
      .accountsStrict({
        owner: actor,
        project: projectAddress(
          actor.toBase58(),
          c.project!,
          program.programId
        ),
        systemProgram: SystemProgram.programId,
      });
  if (c.action === "project.withdraw")
    method = m
      .projectWithdraw(bn(c.amount), bn(c.revision!), eh)
      .accountsStrict({ owner: actor, project: pk(p.address) });
  if (c.action === "project.policy")
    method = m
      .projectPolicy(
        pk(c.manager),
        pk(c.reviewer),
        bn(c.allowance),
        bn(c.expires),
        bn(c.revision!),
        eh
      )
      .accountsStrict({ owner: actor, project: pk(p.address) });
  if (c.action === "epoch.close")
    method = m
      .projectCheckpoint(bn(p.revision), eh)
      .accountsStrict({ actor, project: pk(p.address) });
  if (c.action === "job.open")
    method = m
      .jobOpen(
        idNumber(c.job!),
        bn(c.budget),
        bn(c.deadline),
        c.dependencies.map((id: string) => pk(state.jobs[id].address)),
        eh
      )
      .accountsStrict({
        payer: sponsor,
        actor,
        project: pk(p.address),
        job: jobAddress(p.address, c.job!, program.programId),
        systemProgram: SystemProgram.programId,
      });
  const accounts: Record<string, PublicKey> = j
    ? { actor, project: pk(p.address), job: pk(j.address) }
    : {};
  if (c.action === "job.award") {
    const o = state.offers[c.offerId];
    method = m
      .jobAward(
        pk(o.worker),
        pk(o.recipient),
        bn(o.amount),
        bn(c.leaseUntil),
        bn(c.revision!),
        eh
      )
      .accountsStrict(accounts);
  }
  if (c.action === "job.submit")
    method = m
      .jobSubmit(hash(c.package.packageHash), bn(c.revision!), eh)
      .accountsStrict(accounts);
  if (c.action === "job.review")
    method = m
      .jobReview(hash(c.root), c.approved, bn(c.revision!), eh)
      .accountsStrict(accounts);
  if (c.action === "job.accept")
    method = m
      .jobAccept(hash(c.root), bn(c.revision!), eh)
      .accountsStrict(accounts);
  if (c.action === "job.reclaim")
    method = m.jobReclaim(bn(c.revision!), eh).accountsStrict(accounts);
  if (c.action === "job.cancel")
    method = m.jobCancel(bn(c.revision!), eh).accountsStrict(accounts);
  if (c.action === "job.release")
    method = m
      .jobRelease(pk(c.worker), bn(c.revision!), eh)
      .accountsStrict(accounts);
  if (c.action === "job.renew")
    method = m
      .jobRenew(bn(c.leaseUntil), bn(c.revision!), eh)
      .accountsStrict(accounts);
  if (c.action === "job.claim") {
    const member = j.members.find((x) => x.worker === actor.toBase58())!;
    method = m.jobClaim(bn(c.revision!), eh).accountsStrict({
      actor,
      project: pk(p.address),
      job: pk(j.address),
      recipient: pk(member.recipient),
    });
  }
  if (!method) return null;
  if (["job.submit", "job.accept"].includes(c.action))
    method = method.remainingAccounts(
      j.dependencies.map((id) => ({
        pubkey: pk(state.jobs[id].address),
        isWritable: false,
        isSigner: false,
      }))
    );
  return method.transaction();
}

/** Signers validate the program, exact instruction data, accounts and requested authority before signing a relay-built transaction. */
export async function verifyPreparedTransaction(
  event: MeshEvent,
  transaction: Transaction,
  context: any
) {
  if (!transaction.feePayer) throw Error("Missing fee payer");
  const wallet: any = {
    publicKey: transaction.feePayer,
    signTransaction: () => {
      throw Error("Verification only");
    },
    signAllTransactions: () => {
      throw Error("Verification only");
    },
  };
  const program = new anchor.Program(
    idl as anchor.Idl,
    new anchor.AnchorProvider(
      new Connection("http://127.0.0.1:8899"),
      wallet,
      {}
    )
  );
  const verified = (event: MeshEvent) => {
    if (!event) throw Error("Missing signed context evidence");
    const id = Buffer.from(
      sha256(
        Buffer.from(
          JSON.stringify([
            0,
            event.pubkey,
            event.created_at,
            event.kind,
            event.tags,
            event.content,
          ])
        )
      )
    ).toString("hex");
    if (
      id !== event.id ||
      !nacl.sign.detached.verify(
        Buffer.from(id, "hex"),
        Buffer.from(event.sig, "hex"),
        Buffer.from(event.pubkey, "hex")
      )
    )
      throw Error("Invalid context evidence signature");
    return JSON.parse(event.content);
  };
  const profiles = new Map<string, any>();
  for (const profile of context.agents || []) {
    const data = verified(profile.registration);
    const owner = new PublicKey(
      Buffer.from(profile.registration.pubkey, "hex")
    ).toBase58();
    if (
      data.action !== "agent.register" ||
      data.agent !== profile.key ||
      owner !== profile.owner ||
      !nacl.sign.detached.verify(
        Buffer.from("ctrl-mesh:agent-owner:v1:" + owner),
        Buffer.from(data.binding, "hex"),
        new PublicKey(profile.key).toBytes()
      )
    )
      throw Error("Agent ownership context was altered");
    profiles.set(profile.key, profile);
  }
  for (const offer of context.offers || []) {
    const data = verified(offer.event);
    const worker = new PublicKey(
      Buffer.from(offer.event.pubkey, "hex")
    ).toBase58();
    if (
      data.action !== "offer.publish" ||
      offer.id !== offer.event.id ||
      worker !== offer.worker ||
      offer.amount !== data.amount ||
      offer.project !== data.project ||
      offer.job !== data.job ||
      profiles.get(worker)?.owner !== offer.recipient
    )
      throw Error("Provider offer context was altered");
  }
  const projects = Object.fromEntries(
    [...(context.projects || []), ...(context.signingProjects || [])].map(
      (p: any) => [p.id, p]
    )
  );
  const state = {
    projects,
    jobs: Object.fromEntries((context.jobs || []).map((j: any) => [j.id, j])),
    offers: Object.fromEntries(
      (context.offers || []).map((o: any) => [o.id, o])
    ),
  } as unknown as State;
  for (const p of Object.values(projects) as any[])
    if (
      projectAddress(p.owner, p.id, program.programId).toBase58() !== p.address
    )
      throw Error("Project address does not match its identity");
  for (const j of Object.values(state.jobs))
    if (
      jobAddress(
        state.projects[j.project].address,
        j.id,
        program.programId
      ).toBase58() !== j.address
    )
      throw Error("Task address does not match its identity");
  const expected = await buildTransaction(
    event,
    state,
    program,
    transaction.feePayer
  );
  if (
    !expected ||
    transaction.instructions.length !== expected.instructions.length
  )
    throw Error("Unexpected transaction instructions");
  expected.feePayer = transaction.feePayer;
  expected.recentBlockhash = transaction.recentBlockhash;
  if (!expected.serializeMessage().equals(transaction.serializeMessage()))
    throw Error("Prepared transaction differs from signed command");
}
