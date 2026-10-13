import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  statSync,
} from "fs";
import { spawn } from "child_process";
import {
  Keypair,
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { Chain } from "../src/mesh/chain";
import {
  inspectNetwork,
  networkConfig,
  NetworkConfig,
} from "../src/mesh/network";
import { bootstrapDevnet } from "../src/mesh/devnet-bootstrap";
import { ClusterConfig } from "../src/mesh/consensus";
import { deploymentRPC } from "../src/mesh/deploy-rpc";
import { uploadProgramBuffer } from "../src/mesh/deploy-buffer";

const root = ".mesh/devnet",
  clusterDir = root + "/ha";
const binary = "target/deploy/ctrl_mesh_mvp.so";
const programKey = "target/deploy/ctrl_mesh_mvp-keypair.json";
const sponsorTarget = 50_000_000;
function key(path: string, create = false) {
  if (!existsSync(path) && create)
    writeFileSync(path, JSON.stringify([...Keypair.generate().secretKey]), {
      mode: 0o600,
      flag: "wx",
    });
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(path, "utf8")))
  );
}
function savedConfig(): NetworkConfig {
  if (!existsSync(root + "/network.json"))
    throw Error("Run yarn devnet:prepare first");
  const config = JSON.parse(readFileSync(root + "/network.json", "utf8"));
  if (config.network !== "devnet")
    throw Error("Devnet commands cannot target another network");
  return networkConfig({
    SOLANA_NETWORK: config.network,
    SOLANA_RPC: process.env.SOLANA_RPC || config.rpc,
  });
}
async function deploymentPlan(chain: Chain, config: NetworkConfig) {
  const info = await inspectNetwork(
    chain.connection,
    config,
    chain.program.programId,
    false
  );
  const bytes = statSync(binary).size;
  const [bufferRent, programRent, dataRent, balance, bufferBalance, deployed] =
    await Promise.all([
      chain.connection.getMinimumBalanceForRentExemption(bytes + 37),
      chain.connection.getMinimumBalanceForRentExemption(36),
      chain.connection.getMinimumBalanceForRentExemption(bytes + 45),
      chain.connection.getBalance(chain.sponsor.publicKey),
      chain.connection.getBalance(key(root + "/buffer.json").publicKey),
      chain.connection.getAccountInfo(chain.program.programId),
    ]);
  const sponsorBalances = await Promise.all(
    ["a", "b", "c"].map((id) =>
      chain.connection.getBalance(key(`${root}/sponsor-${id}.json`).publicKey)
    )
  );
  const relayFunding = sponsorBalances.reduce(
    (n, v) => n + Math.max(0, sponsorTarget - v),
    0
  );
  const required =
    (deployed?.executable
      ? 0
      : Math.max(0, bufferRent - bufferBalance) + dataRent + programRent) +
    relayFunding +
    30_000_000;
  return {
    ...info,
    deployer: chain.sponsor.publicKey.toBase58(),
    binaryBytes: bytes,
    programDeployed: !!deployed?.executable,
    balanceSOL: balance / 1e9,
    requiredSOL: required / 1e9,
    missingSOL: Math.max(0, required - balance) / 1e9,
    bufferRentSOL: bufferRent / 1e9,
    programDataRentSOL: dataRent / 1e9,
    sponsorTargetSOL: sponsorTarget / 1e9,
    sponsorBalancesSOL: sponsorBalances.map((n) => n / 1e9),
  };
}
async function verifyDeployment(chain: Chain) {
  const account = await chain.connection.getAccountInfo(
    chain.program.programId,
    "confirmed"
  );
  const loader = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
  if (
    !account?.executable ||
    !account.owner.equals(loader) ||
    account.data.readUInt32LE(0) !== 2
  )
    throw Error("Devnet program is missing or uses an unexpected loader");
  const dataAddress = new PublicKey(account.data.subarray(4, 36));
  const data = await chain.connection.getAccountInfo(dataAddress, "confirmed");
  const artifact = readFileSync(binary);
  if (
    !data ||
    !data.owner.equals(loader) ||
    data.data.readUInt32LE(0) !== 3 ||
    data.data[12] !== 1 ||
    !new PublicKey(data.data.subarray(13, 45)).equals(
      chain.sponsor.publicKey
    ) ||
    !data.data.subarray(45, 45 + artifact.length).equals(artifact)
  )
    throw Error(
      "Deployed binary or upgrade authority does not match this workspace"
    );
  return {
    program: chain.program.programId.toBase58(),
    programData: dataAddress.toBase58(),
    binaryVerified: true,
  };
}
async function runCLI(args: string[]) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("solana", args, { stdio: "inherit" });
    const interrupt = () => child.kill("SIGINT"),
      terminate = () => child.kill("SIGTERM");
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", terminate);
    child.once("exit", () => {
      process.removeListener("SIGINT", interrupt);
      process.removeListener("SIGTERM", terminate);
    });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0
        ? resolve()
        : reject(
            Error(
              `Solana deploy exited with ${code}; the saved buffer can be resumed`
            )
          )
    );
  });
}
async function main() {
  const command = process.argv[2] || "prepare";
  if (command === "start" && existsSync(root + "/production-migration.json"))
    throw Error(
      "This Devnet cluster was moved to production. Open https://1mesh.xyz; do not run a second copy of its voters. Restore the latest production state before a planned rollback."
    );
  if (command === "prepare") {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const config = networkConfig({
      SOLANA_NETWORK: "devnet",
      SOLANA_RPC: process.env.SOLANA_RPC,
    });
    if (!existsSync(root + "/network.json"))
      writeFileSync(
        root + "/network.json",
        JSON.stringify(config, null, 2) + "\n",
        { mode: 0o600, flag: "wx" }
      );
    for (const name of [
      "deployer",
      "buffer",
      ...["a", "b", "c"].flatMap((id) => [`sponsor-${id}`, `relay-${id}`]),
    ])
      key(`${root}/${name}.json`, true);
  }
  const config = savedConfig();
  const chain = new Chain(config.rpc, key(root + "/deployer.json"));
  if (!key(programKey).publicKey.equals(chain.program.programId))
    throw Error("Program keypair and IDL address do not match");
  if (command === "prepare" || command === "status") {
    console.log(JSON.stringify(await deploymentPlan(chain, config), null, 2));
    return;
  }
  if (command === "deploy") {
    const plan = await deploymentPlan(chain, config);
    if (plan.missingSOL > 0)
      throw Error(
        `Fund Devnet deployer ${
          plan.deployer
        } with at least ${plan.missingSOL.toFixed(
          4
        )} test SOL (4.2 SOL for a fresh deployment). No wallet secrets are needed.`
      );
    if (!plan.programDeployed) {
      const proxy = await deploymentRPC(config.rpc);
      try {
        await uploadProgramBuffer(
          new Connection(proxy.url, "confirmed"),
          key(root + "/buffer.json"),
          chain.sponsor,
          readFileSync(binary)
        );
        await runCLI([
          "program",
          "deploy",
          binary,
          "--url",
          proxy.url,
          "--ws",
          config.rpc.replace(/^https:/, "wss:"),
          "--keypair",
          root + "/deployer.json",
          "--fee-payer",
          root + "/deployer.json",
          "--upgrade-authority",
          root + "/deployer.json",
          "--program-id",
          programKey,
          "--buffer",
          root + "/buffer.json",
          "--max-len",
          String(plan.binaryBytes),
          "--use-rpc",
          "--max-sign-attempts",
          "10",
        ]);
      } finally {
        proxy.close();
      }
    }
    console.log(JSON.stringify(await verifyDeployment(chain), null, 2));
    for (const id of ["a", "b", "c"]) {
      const sponsor = key(`${root}/sponsor-${id}.json`);
      const balance = await chain.connection.getBalance(sponsor.publicKey);
      if (balance < sponsorTarget)
        await sendAndConfirmTransaction(
          chain.connection,
          new Transaction().add(
            SystemProgram.transfer({
              fromPubkey: chain.sponsor.publicKey,
              toPubkey: sponsor.publicKey,
              lamports: sponsorTarget - balance,
            })
          ),
          [chain.sponsor],
          { commitment: "confirmed" }
        );
    }
    console.log(
      "Devnet program verified and all three relay fee payers funded."
    );
    return;
  }
  chain.network = await inspectNetwork(
    chain.connection,
    config,
    chain.program.programId
  );
  await verifyDeployment(chain);
  if (command === "bootstrap") {
    if (existsSync(clusterDir + "/cluster.json")) {
      console.log("Devnet cluster already exists; its history is preserved.");
      return;
    }
    const members = ["a", "b", "c"].map((id, i) => ({
      id,
      url: `http://127.0.0.1:${4173 + i}`,
    }));
    const source =
      process.env.MESH_IDENTITY_SOURCE ||
      (existsSync(".mesh/ha/a.sqlite") ? ".mesh/ha/a.sqlite" : undefined);
    const result = bootstrapDevnet(clusterDir, chain.network, members, source);
    console.log(
      JSON.stringify(
        {
          importedAccounts: result.accounts,
          importedAgentRegistrations: result.agents,
          chainEvents: 0,
          sessions: 0,
          members,
        },
        null,
        2
      )
    );
    return;
  }
  if (command !== "start")
    throw Error("Use prepare, status, deploy, bootstrap or start");
  const cluster: ClusterConfig = JSON.parse(
    readFileSync(clusterDir + "/cluster.json", "utf8")
  );
  if (
    cluster.genesis !== chain.network.genesis ||
    cluster.program !== chain.network.program
  )
    throw Error("Devnet cluster does not match the selected RPC and program");
  const requested = process.argv[3];
  if (requested && !cluster.members.some((m) => m.id === requested))
    throw Error("Node must be a, b or c");
  for (const m of cluster.members)
    if (
      (await chain.connection.getBalance(
        key(`${root}/sponsor-${m.id}.json`).publicKey
      )) < 1_000_000
    )
      throw Error(
        `Devnet node ${m.id} needs test SOL; run yarn devnet:deploy to top up the fee payers`
      );
  const children = cluster.members
    .filter((m) => !requested || m.id === requested)
    .map((m) => {
      const child = spawn(
        process.execPath,
        ["-r", "ts-node/register", "src/platform-server.ts"],
        {
          stdio: "inherit",
          env: {
            ...process.env,
            SOLANA_NETWORK: "devnet",
            SOLANA_RPC: config.rpc,
            MESH_DEMO: "0",
            MESH_UPSTREAM: "",
            MESH_HOST: "127.0.0.1",
            MESH_HA_CONFIG: clusterDir + "/cluster.json",
            MESH_HA_NODE: m.id,
            MESH_HA_TOKEN_FILE: clusterDir + "/peer.token",
            MESH_DB: `${clusterDir}/${m.id}.sqlite`,
            MESH_SPONSOR_KEY: `${root}/sponsor-${m.id}.json`,
            MESH_RELAY_KEY: `${root}/relay-${m.id}.json`,
            MESH_MAIL_MODE: "local",
            MESH_MAIL_DIR: root + "/mail",
            PORT: new URL(m.url).port,
          },
        }
      );
      console.log(`Devnet node ${m.id}: PID ${child.pid}, ${m.url}`);
      child.on("exit", (code, signal) => {
        console.log(
          `Devnet node ${m.id} stopped (${
            signal || code
          }); the remaining majority can continue.`
        );
        if (requested) process.exitCode = code || 0;
      });
      return child;
    });
  const previousRun = existsSync(root + "/run.json")
    ? JSON.parse(readFileSync(root + "/run.json", "utf8"))
    : {};
  const pids = previousRun.cluster === cluster.cluster ? previousRun.pids : {};
  cluster.members
    .filter((m) => !requested || m.id === requested)
    .forEach((m, i) => (pids[m.id] = children[i].pid));
  writeFileSync(
    root + "/run.json",
    JSON.stringify({ cluster: cluster.cluster, pids }, null, 2) + "\n",
    { mode: 0o600 }
  );
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.on(signal, () => children.forEach((child) => child.kill(signal)));
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
