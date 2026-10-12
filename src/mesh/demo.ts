import nacl from "tweetnacl";
import { createWorkPackage } from "../proof";
import { Keypair } from "@solana/web3.js";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "fs";
import { MeshClient } from "./sdk";
import { Engine } from "./engine";
import { signEvent } from "./events";
export function localKey(name: string) {
  mkdirSync(".mesh/keys", { recursive: true });
  const path = ".mesh/keys/" + name + ".json";
  if (!existsSync(path))
    writeFileSync(path, JSON.stringify([...Keypair.generate().secretKey]), {
      mode: 0o600,
    });
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(path, "utf8")))
  );
}
export const roles = [
  {
    id: "owner",
    name: "You",
    role: "Project owner",
    company: "Your workspace",
  },
  {
    id: "manager",
    name: "Atlas",
    role: "Delegating agent",
    company: "Your workspace",
  },
  {
    id: "reviewer",
    name: "Sentinel",
    role: "Independent reviewer",
    company: "Your workspace",
  },
  {
    id: "vendor-a",
    name: "Northstar Studio",
    role: "Provider owner",
    company: "Northstar Studio",
  },
  {
    id: "worker-a",
    name: "Forge",
    role: "Backend agent",
    company: "Northstar Studio",
  },
  {
    id: "vendor-b",
    name: "Parallel Labs",
    role: "Provider owner",
    company: "Parallel Labs",
  },
  {
    id: "worker-b",
    name: "Pixel",
    role: "Frontend agent",
    company: "Parallel Labs",
  },
];
export function demoControl(url: string, engine: Engine, replicas?: string[]) {
  const keys = new Map(roles.map((r) => [r.id, localKey(r.id)]));
  const client = (id: string) =>
    new MeshClient(url, keys.get(id)!, {
      replicas: replicas?.filter((r) => r !== url),
      stream: engine.store.meta("stream"),
    });
  return {
    actors: () =>
      roles.map((r) => ({ ...r, key: keys.get(r.id)!.publicKey.toBase58() })),
    async run(action: string, input: any) {
      if (action === "seed") {
        for (const [owner, agent, name, skills, description] of [
          [
            "owner",
            "manager",
            "Atlas",
            ["planning", "delegation"],
            "Plans work, selects providers, controls the delegated budget.",
          ],
          [
            "owner",
            "reviewer",
            "Sentinel",
            ["review", "qa"],
            "Reviews the exact submitted artifact version.",
          ],
          [
            "vendor-a",
            "worker-a",
            "Forge",
            ["typescript", "api", "backend"],
            "API engineer operated by Northstar Studio.",
          ],
          [
            "vendor-b",
            "worker-b",
            "Pixel",
            ["typescript", "ui", "frontend"],
            "Frontend engineer operated by Parallel Labs.",
          ],
        ] as const)
          await client(owner).publish({
            action: "agent.register",
            agent: keys.get(agent)!.publicKey.toBase58(),
            name,
            skills: [...skills],
            description,
            rate: 10000000,
            binding: Buffer.from(
              nacl.sign.detached(
                Buffer.from(
                  "ctrl-mesh:agent-owner:v1:" +
                    keys.get(owner)!.publicKey.toBase58()
                ),
                keys.get(agent)!.secretKey
              )
            ).toString("hex"),
          });
        const project = "workspace-" + Date.now(),
          now = Math.floor(Date.now() / 1000);
        await client("owner").publish({
          action: "project.create",
          project,
          title: input.title || "Build the next release",
          brief:
            input.brief ||
            "Delegate an API and frontend integration to independent agent providers. Review signed artifacts and settle accepted contributions.",
          manager: keys.get("manager")!.publicKey.toBase58(),
          reviewer: keys.get("reviewer")!.publicKey.toBase58(),
          amount: 250000000,
          allowance: 150000000,
          expires: now + 86400,
        });
        await client("manager").publish({
          action: "job.open",
          project,
          job: project + "-integration",
          title: "Ship API + interface integration",
          brief:
            "Two contributors work on an API schema and its user interface. Deliver source files with a signed manifest. Independent review is required.",
          skills: ["typescript", "api", "ui"],
          budget: 30000000,
          deadline: now + 7200,
          dependencies: [],
          public: true,
        });
        return { project };
      }
      const key = keys.get(input.actor);
      if (!key) throw Error("Unknown sandbox role");
      if (action === "context") return client(input.actor).context();
      if (action === "session")
        return { token: await client(input.actor).authenticate() };
      if (action === "publish" && input.event)
        return client(input.actor).publishEvent(input.event);
      if (action === "publish" || action === "sign") {
        const command = input.command;
        if (command.action === "job.submit" && !command.package) {
          command.package = createWorkPackage(
            command.project + "/" + command.job,
            key,
            command.files.map((f: any) => ({
              path: f.path,
              content: Buffer.from(f.base64, "base64"),
            }))
          );
        }
        return action === "sign"
          ? { event: signEvent(key, command) }
          : client(input.actor).publish(command);
      }
      throw Error("Unknown sandbox action");
    },
  };
}
