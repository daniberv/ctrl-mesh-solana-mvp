import { Connection, PublicKey } from "@solana/web3.js";
import type { Store } from "./store";

export const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
export type NetworkConfig = { network: "localnet" | "devnet"; rpc: string };
export type NetworkInfo = NetworkConfig & { genesis: string; program: string };

export function networkConfig(
  env: NodeJS.ProcessEnv = process.env
): NetworkConfig {
  const network = env.SOLANA_NETWORK || "localnet";
  if (network !== "localnet" && network !== "devnet")
    throw Error("SOLANA_NETWORK must be localnet or devnet");
  const rpc =
    env.SOLANA_RPC ||
    (network === "devnet"
      ? "https://api.devnet.solana.com"
      : "http://127.0.0.1:8899");
  const url = new URL(rpc);
  if (url.username || url.password || url.hash)
    throw Error("Use an RPC URL without embedded credentials or fragments");
  if (
    network === "localnet" &&
    !/^http:\/\/(127\.0\.0\.1|localhost):\d+\/?$/.test(rpc)
  )
    throw Error(
      "Localnet requires a loopback validator; select SOLANA_NETWORK=devnet explicitly"
    );
  if (network === "devnet" && url.protocol !== "https:")
    throw Error("Devnet requires an HTTPS RPC endpoint");
  return { network, rpc };
}

export function verifyGenesis(config: NetworkConfig, genesis: string) {
  if (config.network === "devnet" && genesis !== DEVNET_GENESIS)
    throw Error(
      "RPC is not Solana Devnet; refusing to sign or submit transactions"
    );
  if (config.network === "localnet" && genesis === DEVNET_GENESIS)
    throw Error("RPC is Devnet but the workspace is configured for Localnet");
}

export async function inspectNetwork(
  connection: Connection,
  config: NetworkConfig,
  program: PublicKey,
  requireProgram = true
): Promise<NetworkInfo> {
  const genesis = await connection.getGenesisHash();
  verifyGenesis(config, genesis);
  if (requireProgram) {
    const account = await connection.getAccountInfo(program, "confirmed");
    if (!account?.executable)
      throw Error(
        `ctrl-mesh program is not deployed on ${config.network}. Run yarn devnet:deploy before starting Devnet.`
      );
  }
  return { ...config, genesis, program: program.toBase58() };
}

/** Check the existing pin before replaying any chain receipts or pending intents. */
export function pinNetwork(store: Store, info: NetworkInfo) {
  for (const [key, value] of Object.entries({
    genesis: info.genesis,
    "solana.network": info.network,
    "solana.program": info.program,
  })) {
    const saved = store.meta(key);
    if (saved && saved !== value)
      throw Error(
        "Journal belongs to a different Solana network or program. Use a separate database."
      );
  }
  store.setMeta("genesis", info.genesis);
  store.setMeta("solana.network", info.network);
  store.setMeta("solana.program", info.program);
}
