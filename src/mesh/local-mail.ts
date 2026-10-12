import { mkdirSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
export type LocalMessage = {
  to: string;
  subject: string;
  url: string;
  expires: number;
  mode: "local";
};
/** Explicit local development outbox. No messages leave this computer. */
export class LocalMail {
  constructor(readonly directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  private path(account: string, purpose: string) {
    if (
      !/^[a-f0-9-]{36}$/.test(account) ||
      !["verify", "reset"].includes(purpose)
    )
      throw Error("Invalid mail reference");
    return join(this.directory, `${account}-${purpose}.json`);
  }
  send(
    account: string,
    purpose: "verify" | "reset",
    mail: Omit<LocalMessage, "mode">
  ) {
    writeFileSync(
      this.path(account, purpose),
      JSON.stringify({ ...mail, mode: "local" }, null, 2),
      { mode: 0o600 }
    );
  }
  verification(account: string): LocalMessage | null {
    try {
      return JSON.parse(readFileSync(this.path(account, "verify"), "utf8"));
    } catch {
      return null;
    }
  }
}
