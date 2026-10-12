import nacl from "tweetnacl";
import { Keypair } from "@solana/web3.js";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { MeshClient } from "./mesh/sdk";
import { createWorkPackage } from "./proof";
async function main() {
  const [action, keyPath, ...args] = process.argv.slice(2);
  if (!action || !keyPath)
    throw Error(
      "Usage: yarn mesh <keygen|publish|context|market|watch|submit> KEY_FILE [arguments]"
    );
  if (action === "keygen") {
    if (existsSync(keyPath)) throw Error("Key file already exists");
    const key = Keypair.generate();
    writeFileSync(keyPath, JSON.stringify([...key.secretKey]), { mode: 0o600 });
    console.log(key.publicKey.toBase58());
    return;
  }
  const key = Keypair.fromSecretKey(
      Uint8Array.from(JSON.parse(readFileSync(keyPath, "utf8")))
    ),
    client = new MeshClient(
      process.env.MESH_URL || "http://127.0.0.1:4173",
      key
    );
  if (action === "bind")
    console.log(
      Buffer.from(
        nacl.sign.detached(
          Buffer.from("ctrl-mesh:agent-owner:v1:" + args[0]),
          key.secretKey
        )
      ).toString("hex")
    );
  else if (action === "publish")
    console.log(
      JSON.stringify(
        await client.publish(JSON.parse(readFileSync(args[0], "utf8"))),
        null,
        2
      )
    );
  else if (action === "context")
    console.log(JSON.stringify(await client.context(), null, 2));
  else if (action === "market")
    console.log(JSON.stringify(await client.market(), null, 2));
  else if (action === "watch") {
    const cursorFile = args[0];
    let cursor =
      cursorFile && existsSync(cursorFile)
        ? Number(readFileSync(cursorFile, "utf8"))
        : 0;
    const subscription = await client.watch(
      (entry) => {
        console.log(JSON.stringify(entry));
        cursor = entry.seq;
        if (cursorFile) writeFileSync(cursorFile, String(cursor));
      },
      {
        cursor,
        onReady: (c) => {
          cursor = c;
          if (cursorFile) writeFileSync(cursorFile, String(c));
        },
        onError: (e) => console.error(e.message),
      }
    );
    process.on("SIGINT", () => {
      subscription.close();
      process.exit(0);
    });
  } else if (action === "submit") {
    const [project, job, file] = args;
    const context = await client.context(),
      task = context.jobs.find(
        (j: any) => j.project === project && j.id === job
      );
    if (!task) throw Error("Task access required");
    const bytes = readFileSync(file),
      path = file.split("/").pop()!,
      files = [{ path, content: bytes }];
    console.log(
      JSON.stringify(
        await client.publish({
          action: "job.submit",
          project,
          job,
          revision: task.revision,
          package: createWorkPackage(project + "/" + job, key, files),
          files: [{ path, base64: bytes.toString("base64") }],
        }),
        null,
        2
      )
    );
  } else throw Error("Unknown action");
}
main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
