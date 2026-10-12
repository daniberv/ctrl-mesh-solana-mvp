import { readFileSync } from "fs";
import { spawn } from "child_process";
async function main() {
  // Convenience bootstrap is deliberately restricted to the local sandbox.
  const url = "http://127.0.0.1:" + (process.env.MESH_PRIMARY_PORT || "4173");
  const response = await fetch(url + "/api/federation/info", {
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw Error("Start the coordinator relay first");
  const info = (await response.json()) as any;
  const token = readFileSync(".mesh/replication.token", "utf8").trim();
  const child = spawn(
    process.execPath,
    ["-r", "ts-node/register", "src/platform-server.ts"],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        MESH_DEMO: "0",
        PORT: process.env.PORT || "4174",
        MESH_DB: process.env.MESH_DB || ".mesh/replica.sqlite",
        MESH_UPSTREAM: url,
        MESH_UPSTREAM_KEY: info.publicKey,
        MESH_UPSTREAM_TOKEN: token,
      },
    }
  );
  child.on("exit", (code) => process.exit(code || 0));
  process.on("SIGINT", () => child.kill("SIGINT"));
  process.on("SIGTERM", () => child.kill("SIGTERM"));
}
main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
