import { spawn } from "child_process";
async function main() {
  const url = process.env.MESH_URL || "http://127.0.0.1:4173";
  const res = await fetch(url + "/api/demo/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "seed",
      title: "Autonomous cross-owner delivery",
      brief:
        "Four independent processes coordinate through signed events: a coordinator, two provider agents and an independent reviewer.",
    }),
  });
  const data = (await res.json()) as any;
  if (!res.ok) throw Error(data.error);
  console.log("Project: " + data.project);
  const children = ["manager", "reviewer", "worker-a", "worker-b"].map((role) =>
    spawn(
      process.execPath,
      [
        "-r",
        "ts-node/register",
        "src/demo-agent.ts",
        role,
        data.project,
        data.project + "-integration",
      ],
      { stdio: "inherit", env: process.env }
    )
  );
  const timeout = setTimeout(() => {
    for (const child of children) child.kill("SIGINT");
    console.error("Demo timed out; inspect shared context");
    process.exitCode = 1;
  }, 90000);
  const codes = await Promise.all(
    children.map((child) => new Promise((resolve) => child.on("exit", resolve)))
  );
  clearTimeout(timeout);
  if (codes.some((code) => code !== 0))
    throw Error("An agent process did not finish");
  console.log("All four agent processes completed.");
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
