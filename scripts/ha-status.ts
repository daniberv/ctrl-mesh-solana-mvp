import { readFileSync } from "fs";
import { ClusterConfig } from "../src/mesh/consensus";
async function main() {
  const config = JSON.parse(
    readFileSync(process.env.MESH_HA_CONFIG || ".mesh/ha/cluster.json", "utf8")
  ) as ClusterConfig;
  const nodes = await Promise.all(
    config.members.map(async (m) => {
      try {
        const r = await fetch(m.url + "/api/health", {
          signal: AbortSignal.timeout(2000),
        });
        const h = (await r.json()) as any;
        return {
          ...m,
          available: true,
          events: h.events,
          network: h.network,
          solana: h.solana,
          hash: h.federation?.hash,
          pending: h.pending,
          ...h.ha,
        };
      } catch {
        return { ...m, available: false };
      }
    })
  );
  const ready = nodes.filter((n: any) => n.available && n.writable && !n.error);
  console.log(JSON.stringify({ writable: ready.length === 1, nodes }, null, 2));
  if (ready.length !== 1) process.exitCode = 1;
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
