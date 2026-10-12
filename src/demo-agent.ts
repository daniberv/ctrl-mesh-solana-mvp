// A deterministic example worker process. Real agent runtimes use the same SDK/MCP API.
import { readFileSync } from "fs";
import { Keypair } from "@solana/web3.js";
import { MeshClient } from "./mesh/sdk";
import { createWorkPackage, verifyWorkPackage } from "./proof";
const [role, project, job] = process.argv.slice(2);
const key = Keypair.fromSecretKey(
  Uint8Array.from(
    JSON.parse(readFileSync(".mesh/keys/" + role + ".json", "utf8"))
  )
);
const client = new MeshClient(
  process.env.MESH_URL || "http://127.0.0.1:4173",
  key,
  {
    replicas: (process.env.MESH_RELAYS || process.env.MESH_READ_REPLICAS)
      ?.split(",")
      .filter(Boolean),
    stream: process.env.MESH_STREAM,
  }
);
let working = false,
  again = false,
  finished = false;
async function tick() {
  if (finished) return;
  if (working) {
    again = true;
    return;
  }
  working = true;
  try {
    const context = await client.context(),
      task = context.jobs.find((j: any) => j.id === job);
    const command = (action: string, data: any = {}) =>
      client.publish({ action, project, job, ...data });
    if (role === "manager" && task) {
      const offers = context.offers
        .filter(
          (o: any) =>
            o.job === job &&
            !task.members.some((m: any) => m.worker === o.worker)
        )
        .sort((a: any, b: any) => a.amount - b.amount);
      if (task.members.length < 2 && offers.length) {
        await command("job.award", {
          offerId: offers[0].id,
          revision: task.revision,
          leaseUntil: Math.min(
            task.deadline,
            Math.floor(Date.now() / 1000) + 1800
          ),
        });
        again = true;
      } else if (task.state === "review" && task.root === task.reviewRoot)
        await command("job.accept", {
          root: task.root,
          revision: task.revision,
        });
      else if (
        task.state === "accepted" &&
        task.members.every((m: any) => m.paid)
      ) {
        finished = true;
        console.log("Coordinator: accepted and both provider owners paid");
      }
    } else if (role === "reviewer" && task) {
      if (task.state === "review" && task.reviewRoot !== task.root) {
        const packages = Object.values(task.packages) as any[];
        if (packages.length !== 2) throw Error("Expected two contributions");
        for (const p of packages) {
          if (
            !verifyWorkPackage(
              p.package,
              p.files.map((f: any) => ({
                path: f.path,
                content: Buffer.from(f.base64, "base64"),
              }))
            )
          )
            throw Error("Invalid artifact");
        }
        const schema = JSON.parse(
          Buffer.from(
            packages
              .flatMap((p) => p.files)
              .find((f) => f.path === "api-schema.json").base64,
            "base64"
          ).toString()
        );
        const ui = JSON.parse(
          Buffer.from(
            packages
              .flatMap((p) => p.files)
              .find((f) => f.path === "client-contract.json").base64,
            "base64"
          ).toString()
        );
        if (
          schema.endpoint !== ui.endpoint ||
          JSON.stringify(schema.fields) !== JSON.stringify(ui.fields)
        )
          throw Error("API/client contract mismatch");
        await command("job.review", {
          root: task.root,
          revision: task.revision,
          approved: true,
          comment:
            "Verified both signatures, all file bytes, and matching API/client contract fields.",
        });
      }
      if (task.state === "accepted") finished = true;
    } else if (role.startsWith("worker")) {
      if (!task) {
        const own = context.offers.some((o: any) => o.job === job);
        if (!own)
          await command("offer.publish", {
            amount: 15000000,
            message:
              role === "worker-a"
                ? "I will provide the API schema."
                : "I will provide a matching client contract.",
          });
      } else {
        const member = task.members.find(
          (m: any) => m.worker === key.publicKey.toBase58()
        );
        if (!member) return;
        if (member.hash === "0".repeat(64) && task.members.length === 2) {
          const path =
            role === "worker-a" ? "api-schema.json" : "client-contract.json";
          const file = {
            path,
            content: Buffer.from(
              JSON.stringify({
                endpoint: "/v1/tasks",
                fields: ["id", "title", "status", "revision"],
              })
            ),
          };
          await command("progress", {
            message:
              "Building " + path + " against the current shared task context.",
          });
          await command("job.submit", {
            revision: task.revision,
            package: createWorkPackage(project + "/" + job, key, [file]),
            files: [{ path, base64: file.content.toString("base64") }],
          });
        } else if (task.state === "accepted" && !member.paid)
          await command("job.claim", { revision: task.revision });
        else if (member.paid) {
          finished = true;
          console.log(role + ": owner received " + member.amount + " lamports");
        }
      }
    }
  } catch (e) {
    const message = (e as Error).message;
    if (!/Stale|revision|pending/.test(message))
      console.error(role + ": " + message);
  } finally {
    working = false;
    if (again && !finished) {
      again = false;
      setTimeout(tick, 100);
    }
  }
}
(async () => {
  const watch = await client.watch(() => void tick(), {
    project,
    onReady: () => void tick(),
    onError: (e) => console.error(e.message),
  });
  const timer = setInterval(async () => {
    await tick();
    if (finished) {
      clearInterval(timer);
      watch.close();
      process.exit(0);
    }
  }, 1000);
  process.on("SIGINT", () => {
    clearInterval(timer);
    watch.close();
    process.exit(0);
  });
})();
