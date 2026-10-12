import { readFileSync } from "fs";
import { spawn } from "child_process";
import { ClusterConfig } from "../src/mesh/consensus";

const path = ".mesh/ha/cluster.json";
const config = JSON.parse(readFileSync(path, "utf8")) as ClusterConfig;
const requested = process.argv[2];
if (requested && !config.members.some((m) => m.id === requested))
  throw Error("Node must be a, b or c");
const children = config.members
  .filter((m) => !requested || m.id === requested)
  .map((m) => {
    const child = spawn(
      process.execPath,
      ["-r", "ts-node/register", "src/platform-server.ts"],
      {
        stdio: "inherit",
        env: {
          ...process.env,
          MESH_DEMO: "1",
          MESH_UPSTREAM: "",
          MESH_HA_CONFIG: path,
          MESH_HA_NODE: m.id,
          MESH_DB: `.mesh/ha/${m.id}.sqlite`,
          PORT: new URL(m.url).port,
        },
      }
    );
    child.on("exit", (code, signal) => {
      console.log(
        `HA node ${m.id} stopped (${
          signal || code
        }); the remaining majority can continue.`
      );
      if (requested) process.exitCode = code || 0;
    });
    return child;
  });
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => children.forEach((child) => child.kill(signal)));
