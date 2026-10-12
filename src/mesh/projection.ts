import { PublicKey } from "@solana/web3.js";
import { address, digest, MeshEvent, Receipt } from "./events";
import { State } from "./state";
const zero = "0".repeat(64);
const states = [
  "open",
  "working",
  "review",
  "changes_requested",
  "accepted",
  "cancelled",
];
/** Reconstruct historical account transitions from proven instructions, never peer snapshots. */
export function projectReceipt(
  event: MeshEvent,
  state: State,
  receipt: Receipt
): Receipt {
  const c = JSON.parse(event.content),
    actor = address(event.pubkey);
  if (!c.action.startsWith("job.")) return receipt;
  const j = state.jobs[c.job];
  const chain =
    c.action === "job.open"
      ? {
          revision: 0,
          state: 0,
          root: zero,
          reviewRoot: zero,
          members: [] as any[],
        }
      : {
          revision: j.revision + 1,
          state: states.indexOf(j.state),
          root: j.root,
          reviewRoot: j.reviewRoot,
          members: j.members.map((m) => ({ ...m })),
        };
  const member = () => {
    const m = chain.members.find((m) => m.worker === actor);
    if (!m) throw Error("Missing contributor in historical projection");
    return m;
  };
  switch (c.action) {
    case "job.award": {
      const offer = state.offers[c.offerId];
      chain.members.push({
        worker: offer.worker,
        recipient: offer.recipient,
        amount: offer.amount,
        leaseUntil: c.leaseUntil,
        hash: zero,
        paid: false,
      });
      chain.state = 1;
      break;
    }
    case "job.submit":
      member().hash = c.package.packageHash;
      chain.root = digest(
        Buffer.concat(
          chain.members.flatMap((m) => [
            new PublicKey(m.worker).toBuffer(),
            Buffer.from(m.hash, "hex"),
          ])
        )
      );
      chain.reviewRoot = zero;
      chain.state = chain.members.every((m) => m.hash !== zero) ? 2 : 1;
      break;
    case "job.review":
      chain.reviewRoot = c.approved ? c.root : zero;
      if (!c.approved) chain.state = 3;
      break;
    case "job.accept":
      chain.state = 4;
      break;
    case "job.cancel":
      chain.state = 5;
      break;
    case "job.claim":
      member().paid = true;
      break;
    case "job.renew":
      member().leaseUntil = c.leaseUntil;
      break;
    case "job.release":
      chain.members = chain.members.filter((m) => m.worker !== c.worker);
      chain.state = chain.members.length ? 1 : 0;
      chain.reviewRoot = zero;
      break;
  }
  return { ...receipt, chain };
}
