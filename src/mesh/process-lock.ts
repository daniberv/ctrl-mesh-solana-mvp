import {
  mkdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { dirname, basename, join, resolve } from "path";
import { hostname } from "os";
/** One live process per durable voter. SIGKILL recovery is restricted to the same host. */
export function lockDatabase(path: string) {
  const directory = dirname(resolve(path));
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lock = join(realpathSync(directory), basename(path) + ".process-lock");
  const mine = JSON.stringify({ pid: process.pid, host: hostname() });
  const create = () => writeFileSync(lock, mine, { flag: "wx", mode: 0o600 });
  try {
    create();
  } catch (e) {
    if ((e as any).code !== "EEXIST") throw e;
    // Serialize stale-lock recovery. Without this guard two starters could each
    // delete the other's new lock after both observed the same dead PID.
    const recovery = lock + ".recovery";
    writeFileSync(recovery, mine, { flag: "wx", mode: 0o600 });
    try {
      const held = JSON.parse(readFileSync(lock, "utf8"));
      if (
        held.host !== hostname() ||
        !Number.isSafeInteger(held.pid) ||
        held.pid <= 0
      )
        throw Error(
          "HA database lock needs operator recovery on its original host"
        );
      try {
        process.kill(held.pid, 0);
        throw Error("HA database already has a live process");
      } catch (check) {
        if ((check as any).code !== "ESRCH") throw check;
      }
      unlinkSync(lock);
      create();
    } finally {
      unlinkSync(recovery);
    }
  }
  return () => {
    if (readFileSync(lock, "utf8") === mine) unlinkSync(lock);
  };
}
