import { address, Command, Entry, MeshEvent, verifyEvent } from "./events";
import nacl from "tweetnacl";
import { PublicKey } from "@solana/web3.js";
import { verifyWorkPackage } from "../proof";
import {
  KeyDirectory,
  SEALED_FILE,
  Sealed,
  validateSealed,
  verifyKeyRecord,
} from "./encryption";
export type Agent = {
  registration: MeshEvent;
  key: string;
  owner: string;
  name: string;
  skills: string[];
  description: string;
  rate: number;
};
export type Project = {
  id: string;
  owner: string;
  manager: string;
  reviewer: string;
  title: string;
  brief: string;
  allowance: number;
  committed: number;
  balance: number;
  expires: number;
  revision: number;
  address: string;
  closed?: boolean;
};
export type Offer = {
  event: MeshEvent;
  id: string;
  job: string;
  project: string;
  worker: string;
  recipient: string;
  amount: number;
  message: string;
};
export type Job = {
  id: string;
  project: string;
  title: string;
  brief: string;
  skills: string[];
  budget: number;
  deadline: number;
  dependencies: string[];
  revision: number;
  state: string;
  address: string;
  members: {
    worker: string;
    recipient: string;
    amount: number;
    leaseUntil: number;
    hash: string;
    paid: boolean;
  }[];
  root: string;
  reviewRoot: string;
  packages: Record<string, any>;
  reviews: any[];
  public: boolean;
  reclaimed?: boolean;
};
const states = [
  "open",
  "working",
  "review",
  "changes_requested",
  "accepted",
  "cancelled",
];
export class State {
  agents: Record<string, Agent> = {};
  projects: Record<string, Project> = {};
  jobs: Record<string, Job> = {};
  offers: Record<string, Offer> = {};
  timeline: Entry[] = [];
  encryptionKeys: KeyDirectory = {};
  apply(entry: Entry) {
    const c = verifyEvent(entry.event),
      actor = address(entry.event.pubkey),
      r = entry.receipt;
    if (c.action === "key.publish") this.encryptionKeys[actor] = entry.event;
    if (c.action === "agent.register")
      this.agents[c.agent] = {
        registration: entry.event,
        key: c.agent,
        owner: actor,
        name: c.name,
        skills: c.skills,
        description: c.description,
        rate: c.rate,
      };
    if (c.action === "project.create")
      this.projects[c.project!] = {
        id: c.project!,
        owner: actor,
        manager: c.manager,
        reviewer: c.reviewer,
        title: c.title,
        brief: c.brief,
        allowance: c.allowance,
        committed: 0,
        balance: c.amount,
        expires: c.expires,
        revision: 0,
        address: r.projectAddress!,
      };
    if (c.action === "project.policy") {
      const p = this.projects[c.project!];
      Object.assign(p, {
        manager: c.manager,
        reviewer: c.reviewer,
        allowance: c.allowance,
        expires: c.expires,
        revision: p.revision + 1,
      });
    }
    if (c.action === "job.open") {
      this.jobs[c.job!] = {
        id: c.job!,
        project: c.project!,
        title: c.title,
        brief: c.brief,
        skills: c.skills,
        budget: c.budget,
        deadline: c.deadline,
        dependencies: c.dependencies,
        revision: 0,
        state: "open",
        address: r.jobAddress!,
        members: [],
        root: "0".repeat(64),
        reviewRoot: "0".repeat(64),
        packages: {},
        reviews: [],
        public: c.public,
      };
      this.projects[c.project!].committed += c.budget;
      this.projects[c.project!].balance -= c.budget;
    }
    if (c.action === "offer.publish")
      this.offers[entry.event.id] = {
        event: entry.event,
        id: entry.event.id,
        job: c.job!,
        project: c.project!,
        worker: actor,
        recipient: this.agents[actor].owner,
        amount: c.amount,
        message: c.message,
      };
    const j = this.jobs[c.job!];
    if (c.action === "project.withdraw") {
      this.projects[c.project!].balance -= c.amount;
      this.projects[c.project!].revision++;
    }
    if (c.action === "job.cancel")
      this.projects[c.project!].balance += j.budget;
    if (c.action === "job.reclaim") {
      this.projects[c.project!].balance +=
        j.budget - j.members.reduce((sum, m) => sum + m.amount, 0);
      j.reclaimed = true;
    }
    if (j && r.chain)
      Object.assign(j, {
        revision: r.chain.revision,
        state: states[r.chain.state],
        root: r.chain.root,
        reviewRoot: r.chain.reviewRoot,
        members: r.chain.members,
      });
    if (c.action === "job.submit")
      j.packages[actor] = {
        eventId: entry.event.id,
        package: c.package,
        files: c.files,
        ...(c.encrypted ? { encrypted: true, event: entry.event } : {}),
      };
    if (c.action === "job.release") delete j.packages[c.worker];
    if (c.action === "job.review")
      j.reviews.push({
        actor,
        approved: c.approved,
        root: c.root,
        comment: c.comment,
        eventId: entry.event.id,
      });
    if (c.action === "epoch.close") {
      this.projects[c.project!].closed = true;
      this.projects[c.project!].revision++;
    }
    this.timeline.push(entry);
  }
  manager(p: Project, actor: string, now = Date.now() / 1000) {
    return actor === p.owner || (actor === p.manager && now <= p.expires);
  }
  canReadProject(id: string, actor: string, now = Date.now() / 1000) {
    const p = this.projects[id];
    return (
      !!p &&
      (actor === p.owner ||
        actor === p.reviewer ||
        (actor === p.manager && now <= p.expires))
    );
  }
  canReadJob(j: Job, actor: string, now = Date.now() / 1000) {
    return (
      this.canReadProject(j.project, actor, now) ||
      j.members.some(
        (m) => m.worker === actor || this.agents[m.worker]?.owner === actor
      )
    );
  }
  // A worker can read accepted dependency results used by their own assigned tasks.
  canReadDependency(j: Job, actor: string) {
    return Object.values(this.jobs).some(
      (t) =>
        t.project === j.project &&
        t.members.some((m) => m.worker === actor) &&
        t.dependencies.includes(j.id)
    );
  }
  canRead(entry: Entry, actor: string) {
    const c = JSON.parse(entry.event.content);
    if (["agent.register", "key.publish"].includes(c.action)) return true;
    if (
      c.action === "private.publish" &&
      !c.sealed.recipients.some((r: any) => r.actor === actor)
    )
      return false;
    if (c.action === "offer.publish")
      return (
        address(entry.event.pubkey) === actor ||
        this.canReadProject(c.project, actor)
      );
    if (!c.job) return this.canReadProject(c.project, actor);
    const j = this.jobs[c.job];
    return (
      !!j && (this.canReadJob(j, actor) || this.canReadDependency(j, actor))
    );
  }
  context(actor: string) {
    const jobs = Object.values(this.jobs).filter(
      (j) => this.canReadJob(j, actor) || this.canReadDependency(j, actor)
    );
    return {
      actor,
      encryptionKeys: this.encryptionKeys,
      signingProjects: Object.values(this.projects)
        .filter((p) => jobs.some((j) => j.project === p.id))
        .map((p) => ({
          id: p.id,
          address: p.address,
          owner: p.owner,
          manager: p.manager,
          reviewer: p.reviewer,
          expires: p.expires,
          revision: p.revision,
        })),
      projects: Object.values(this.projects)
        .filter((p) => this.canReadProject(p.id, actor))
        .map((p) => ({ ...p })),
      jobs: jobs.map((j) => ({
        ...j,
        blockedBy: j.dependencies.filter(
          (id) => this.jobs[id]?.state !== "accepted"
        ),
      })),
      agents: Object.values(this.agents),
      offers: Object.values(this.offers).filter(
        (o) => o.worker === actor || this.canReadProject(o.project, actor)
      ),
      cursor: this.timeline.at(-1)?.seq || 0,
    };
  }
  market() {
    return {
      agents: Object.values(this.agents),
      jobs: Object.values(this.jobs)
        .filter((j) => j.public && ["open", "working"].includes(j.state))
        .map((j) => ({
          id: j.id,
          project: j.project,
          title: j.title,
          brief: j.brief,
          skills: j.skills,
          budget: j.budget,
          awarded: j.members.reduce((s, m) => s + m.amount, 0),
          deadline: j.deadline,
          state: j.state,
        })),
    };
  }
  validate(
    event: MeshEvent,
    admissionTime = Math.floor(Date.now() / 1000)
  ): Command {
    const c = verifyEvent(event),
      actor = address(event.pubkey),
      now = admissionTime;
    if (Math.abs(event.created_at - now) > 300)
      throw Error("Event timestamp outside admission window");
    const must = (ok: any, msg: string) => {
      if (!ok) throw Error(msg);
    };
    const str = (v: any, max = 200) =>
      typeof v === "string" && v.length > 0 && v.length <= max;
    const number = (v: any) => Number.isSafeInteger(v) && v >= 0;
    if (c.action === "key.publish") {
      must(
        !c.project &&
          !c.job &&
          c.previous === (this.encryptionKeys[actor]?.id || ""),
        "Encryption key revision mismatch"
      );
      verifyKeyRecord(actor, event);
      return c;
    }
    if (c.action === "agent.register") {
      must(
        typeof c.binding === "string" &&
          nacl.sign.detached.verify(
            Buffer.from("ctrl-mesh:agent-owner:v1:" + actor),
            Buffer.from(c.binding, "hex"),
            new PublicKey(c.agent).toBytes()
          ),
        "Agent ownership proof required"
      );
      must(
        str(c.agent) &&
          str(c.name, 80) &&
          str(c.description, 1000) &&
          Array.isArray(c.skills) &&
          c.skills.length <= 20 &&
          c.skills.every((s: any) => str(s, 40)) &&
          number(c.rate),
        "Invalid agent profile"
      );
      must(
        !this.agents[c.agent] || this.agents[c.agent].owner === actor,
        "Agent belongs to another owner"
      );
      return c;
    }
    if (c.action === "project.create") {
      must(
        str(c.project, 80) &&
          !this.projects[c.project!] &&
          str(c.title) &&
          str(c.brief, 5000),
        "Invalid project"
      );
      must(
        this.agents[c.manager]?.owner === actor,
        "Manager must belong to project owner"
      );
      must(
        this.agents[c.reviewer] && c.reviewer !== c.manager,
        "Independent reviewer required"
      );
      must(
        number(c.amount) &&
          number(c.allowance) &&
          c.allowance <= c.amount &&
          number(c.expires) &&
          c.expires > now,
        "Invalid budget policy"
      );
      return c;
    }
    const p = this.projects[c.project!];
    must(p, "Unknown project");
    const validateAudience = (sealed: Sealed, purpose: "note" | "artifact") => {
      validateSealed(sealed);
      const task = this.jobs[c.job!];
      const access = (who: string) =>
        c.job
          ? !!task &&
            task.project === p.id &&
            (this.canReadJob(task, who, now) ||
              this.canReadDependency(task, who))
          : this.canReadProject(p.id, who, now);
      must(
        sealed.sender === actor &&
          sealed.project === p.id &&
          sealed.job === c.job &&
          sealed.purpose === purpose,
        "Encrypted scope mismatch"
      );
      must(
        access(actor) && sealed.recipients.some((r) => r.actor === actor),
        "Sender access required"
      );
      for (const r of sealed.recipients) {
        const record = this.encryptionKeys[r.actor];
        must(
          access(r.actor) &&
            record?.id === r.keyEvent &&
            verifyKeyRecord(r.actor, record) === r.boxKey,
          "Recipient access or encryption key changed"
        );
      }
      if (purpose === "artifact") {
        const required = [
          p.owner,
          p.reviewer,
          ...(now <= p.expires ? [p.manager] : []),
        ];
        must(
          required.every((who) =>
            sealed.recipients.some((r) => r.actor === who)
          ),
          "Encrypted artifacts require owner, reviewer and active coordinator access"
        );
      }
    };
    if (c.action === "private.publish") {
      must(!p.closed, "Project epoch is closed");
      validateAudience(c.sealed, "note");
      return c;
    }
    if (c.action === "project.withdraw") {
      must(
        actor === p.owner &&
          c.revision === p.revision &&
          number(c.amount) &&
          c.amount > 0 &&
          c.amount <= p.balance,
        "Owner, revision or available balance mismatch"
      );
      return c;
    }
    if (c.action === "project.policy") {
      must(
        actor === p.owner && c.revision === p.revision,
        "Owner or revision mismatch"
      );
      must(
        this.agents[c.manager]?.owner === p.owner &&
          this.agents[c.reviewer] &&
          c.reviewer !== c.manager,
        "Invalid roles"
      );
      must(
        number(c.allowance) && c.allowance >= p.committed && number(c.expires),
        "Invalid policy"
      );
      must(
        !Object.values(this.jobs).some(
          (j) =>
            j.project === p.id && j.members.some((m) => m.worker === c.reviewer)
        ),
        "Reviewer is a contributor"
      );
      return c;
    }
    must(!p.closed, "Project epoch is closed");
    if (c.action === "job.open") {
      must(this.manager(p, actor, now), "Manager permission required");
      must(
        str(c.job, 80) &&
          !this.jobs[c.job!] &&
          str(c.title) &&
          str(c.brief, 5000),
        "Invalid task"
      );
      must(
        number(c.budget) &&
          c.budget > 0 &&
          number(c.deadline) &&
          c.deadline > now &&
          Array.isArray(c.dependencies) &&
          c.dependencies.length <= 8 &&
          new Set(c.dependencies).size === c.dependencies.length,
        "Invalid task terms"
      );
      must(
        c.dependencies.every((id: string) => this.jobs[id]?.project === p.id),
        "Invalid dependency"
      );
      must(
        Array.isArray(c.skills) &&
          c.skills.every((s: any) => str(s, 40)) &&
          typeof c.public === "boolean",
        "Invalid listing"
      );
      must(
        actor === p.owner || p.committed + c.budget <= p.allowance,
        "Delegated budget exceeded"
      );
      return c;
    }
    if (c.action === "epoch.close") {
      must(this.manager(p, actor, now), "Manager required");
      const jobs = Object.values(this.jobs).filter((j) => j.project === p.id);
      must(
        jobs.length > 0 &&
          jobs.every((j) => ["accepted", "cancelled"].includes(j.state)),
        "Unfinished tasks"
      );
      must(
        jobs.every(
          (j) => j.state === "cancelled" || j.members.every((m) => m.paid)
        ),
        "Unpaid contributions"
      );
      must(
        str(c.report, 10000) &&
          Array.isArray(c.evidence) &&
          c.evidence.length > 0 &&
          c.evidence.every((id: string) =>
            this.timeline.some(
              (e) =>
                e.event.id === id &&
                JSON.parse(e.event.content).project === p.id
            )
          ),
        "Evidence required"
      );
      return c;
    }
    const j = this.jobs[c.job!];
    must(j && j.project === p.id, "Unknown task");
    if (c.action === "offer.publish") {
      must(
        j.public && ["open", "working"].includes(j.state) && j.deadline > now,
        "Task is not accepting offers"
      );
      must(
        this.agents[actor] && actor !== p.reviewer,
        "Registered independent provider required"
      );
      must(
        number(c.amount) &&
          c.amount > 0 &&
          c.amount <= j.budget &&
          str(c.message, 2000),
        "Invalid offer"
      );
      return c;
    }
    if (c.action === "progress") {
      must(
        this.canReadJob(j, actor, now) && str(c.message, 4000),
        "Task access required"
      );
      must(!["accepted", "cancelled"].includes(j.state), "Task is closed");
      return c;
    }
    must(c.revision === j.revision, "Stale revision; refresh context");
    if (c.action === "job.award") {
      const o = this.offers[c.offerId];
      must(
        this.manager(p, actor, now) &&
          o &&
          o.job === j.id &&
          o.project === p.id,
        "Invalid offer or manager permission"
      );
      must(
        number(c.leaseUntil) &&
          c.leaseUntil > now &&
          c.leaseUntil <= j.deadline,
        "Invalid lease"
      );
      must(!j.members.some((m) => m.worker === o.worker), "Already assigned");
      return c;
    }
    if (c.action === "job.submit") {
      if (c.encrypted !== undefined)
        must(c.encrypted === true, "Invalid encryption flag");
      if (c.encrypted) {
        must(
          Array.isArray(c.files) &&
            c.files.length === 1 &&
            c.files[0].path === SEALED_FILE,
          "Invalid encrypted artifact container"
        );
        validateAudience(
          JSON.parse(Buffer.from(c.files[0].base64, "base64").toString()),
          "artifact"
        );
      }
      must(
        j.members.some((m) => m.worker === actor),
        "Assigned worker required"
      );
      must(
        Array.isArray(c.files) &&
          c.files.length <= 30 &&
          c.package?.worker === actor &&
          c.package?.taskId === p.id + "/" + j.id,
        "Wrong package author or task"
      );
      must(
        verifyWorkPackage(
          c.package,
          c.files.map((f: any) => ({
            path: f.path,
            content: Buffer.from(f.base64, "base64"),
          }))
        ),
        "Invalid artifact bytes or signature"
      );
      return c;
    }
    if (c.action === "job.review") {
      must(
        actor === p.reviewer &&
          typeof c.approved === "boolean" &&
          str(c.comment, 4000) &&
          c.root === j.root,
        "Reviewer or version mismatch"
      );
      return c;
    }
    if (c.action === "job.accept") {
      must(
        this.manager(p, actor, now) && c.root === j.root,
        "Manager or version mismatch"
      );
      must(
        j.members.every(
          (m) => j.packages[m.worker]?.package.packageHash === m.hash
        ),
        "Missing signed evidence"
      );
      return c;
    }
    if (c.action === "job.claim") {
      must(
        j.state === "accepted" &&
          j.members.some((m) => m.worker === actor && !m.paid),
        "Unpaid accepted contribution required"
      );
      return c;
    }
    if (c.action === "job.reclaim") {
      must(
        actor === p.owner &&
          j.state === "accepted" &&
          j.members.every((m) => m.paid) &&
          !j.reclaimed &&
          j.budget > j.members.reduce((s, m) => s + m.amount, 0),
        "No reclaimable task reserve"
      );
      return c;
    }
    if (c.action === "job.cancel") {
      must(actor === p.owner, "Owner required");
      return c;
    }
    if (c.action === "job.release") {
      must(
        j.members.some((m) => m.worker === c.worker) &&
          (actor === c.worker || this.manager(p, actor, now)),
        "Worker or manager required"
      );
      return c;
    }
    if (c.action === "job.renew") {
      must(
        j.members.some((m) => m.worker === actor) && number(c.leaseUntil),
        "Assigned worker required"
      );
      return c;
    }
    throw Error("Unsupported command");
  }
}
