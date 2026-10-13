import { DatabaseSync } from "node:sqlite";

export type AccountCommand =
  | {
      op: "register";
      accountId: string;
      email: string;
      password: string;
      session: string;
      expires: number;
      // Retained for replaying registrations created before email confirmation was disabled.
      token?: string;
      tokenExpires?: number;
      previous?: string;
    }
  | {
      op: "login";
      accountId: string;
      password: string;
      session: string;
      expires: number;
      previous?: string;
    }
  | { op: "logout"; session: string }
  | {
      op: "wallet";
      accountId: string;
      wallet: string;
      previous: string;
      session: string;
      expires: number;
    }
  | { op: "disconnect"; session: string }
  | {
      op: "token";
      accountId: string;
      purpose: "verify" | "reset";
      token: string;
      expires: number;
    }
  | { op: "verify"; token: string }
  | { op: "reset"; token: string; password: string }
  | { op: "attempt"; key: string; limit: number; window: number };
export type AccountAction = {
  type: "account";
  id: string;
  now: number;
  command: AccountCommand;
};
export type Account = {
  id: string;
  email: string;
  password: string;
  verified: number;
  wallet: string | null;
};
export type AccountSession = {
  account: {
    id: string;
    email: string;
    verified: boolean;
    // The first wallet is retained for compatibility with older clients.
    wallet: string | null;
    wallets: string[];
  };
  actor: string;
  expires: number;
};
export const authError = (message: string, status = 400) =>
  Object.assign(Error(message), { status });

/** Private identity data is replicated by the quorum, never published as mesh events. */
export class Accounts {
  constructor(private db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS accounts(id TEXT PRIMARY KEY,email TEXT UNIQUE NOT NULL,password TEXT NOT NULL,verified INTEGER NOT NULL DEFAULT 0,wallet TEXT UNIQUE,created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS account_wallets(wallet TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES accounts(id),created INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS account_wallets_account ON account_wallets(account_id);
      INSERT OR IGNORE INTO account_wallets(wallet,account_id,created) SELECT wallet,id,created FROM accounts WHERE wallet IS NOT NULL;
      CREATE TABLE IF NOT EXISTS account_sessions(hash TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES accounts(id),wallet TEXT,expires INTEGER NOT NULL,revoked INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS account_tokens(hash TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES accounts(id),purpose TEXT NOT NULL,expires INTEGER NOT NULL,used INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS account_attempts(key TEXT PRIMARY KEY,count INTEGER NOT NULL,until INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS account_applied(id TEXT PRIMARY KEY);
    `);
  }
  byEmail(email: string) {
    return this.db
      .prepare("SELECT * FROM accounts WHERE email=?")
      .get(email) as Account | undefined;
  }
  byId(id: string) {
    return this.db.prepare("SELECT * FROM accounts WHERE id=?").get(id) as
      | Account
      | undefined;
  }
  wallets(accountId: string): string[] {
    return (
      this.db
        .prepare(
          "SELECT wallet FROM account_wallets WHERE account_id=? ORDER BY created,wallet"
        )
        .all(accountId) as { wallet: string }[]
    ).map((row) => row.wallet);
  }
  walletOwner(wallet: string): string | undefined {
    return (
      this.db
        .prepare("SELECT account_id FROM account_wallets WHERE wallet=?")
        .get(wallet) as { account_id: string } | undefined
    )?.account_id;
  }
  session(hash: string, now = Date.now()): AccountSession | undefined {
    const row = this.db
      .prepare(
        "SELECT a.*,s.wallet AS session_wallet,s.expires FROM account_sessions s JOIN accounts a ON a.id=s.account_id WHERE s.hash=? AND s.revoked=0 AND s.expires>?"
      )
      .get(hash, now) as any;
    return row
      ? {
          account: {
            id: row.id,
            email: row.email,
            verified: !!row.verified,
            wallet: row.wallet,
            wallets: this.wallets(row.id),
          },
          actor:
            row.session_wallet &&
            this.walletOwner(row.session_wallet) === row.id
              ? row.session_wallet
              : "",
          expires: row.expires,
        }
      : undefined;
  }
  private token(hash: string, purpose: string, now: number) {
    const row = this.db
      .prepare(
        "SELECT * FROM account_tokens WHERE hash=? AND purpose=? AND used=0 AND expires>?"
      )
      .get(hash, purpose, now) as any;
    if (!row)
      throw authError(
        "This email link has expired or has already been used. Request a new one."
      );
    return row;
  }
  validate({ command: c, now }: AccountAction) {
    if (c.op === "register" && this.byEmail(c.email))
      throw authError(
        "Unable to create this account. Try signing in or resetting your password.",
        409
      );
    if (c.op === "login" && this.byId(c.accountId)?.password !== c.password)
      throw authError("Email or password is incorrect.", 401);
    if (c.op === "wallet") {
      const session = this.session(c.previous, now),
        account = this.byId(c.accountId);
      if (!session || !account || session.account.id !== c.accountId)
        throw authError("Authentication required", 401);
      const owner = this.walletOwner(c.wallet);
      if (owner && owner !== account.id)
        throw authError(
          "This wallet is already linked to another account.",
          409
        );
    }
    if (c.op === "token" && !this.byId(c.accountId))
      throw authError("Account not found");
    if (c.op === "verify" || c.op === "reset") this.token(c.token, c.op, now);
    if (c.op === "attempt") {
      const row = this.db
        .prepare("SELECT * FROM account_attempts WHERE key=?")
        .get(c.key) as any;
      if (row && row.until > now && row.count >= c.limit)
        throw authError("Too many attempts. Please try again later.", 429);
    }
  }
  /** Idempotent even if a crash occurs between applying and advancing the Raft watermark. */
  apply(action: AccountAction): string[] {
    if (
      this.db
        .prepare("SELECT id FROM account_applied WHERE id=?")
        .get(action.id)
    )
      return [];
    const c = action.command,
      revoked: string[] = [];
    const revoke = (hash: string) => {
      this.db
        .prepare("UPDATE account_sessions SET revoked=1 WHERE hash=?")
        .run(hash);
      revoked.push(hash);
    };
    const session = (wallet: string | null) => {
      if (c.op !== "register" && c.op !== "login" && c.op !== "wallet") return;
      this.db
        .prepare(
          "INSERT INTO account_sessions(hash,account_id,wallet,expires) VALUES(?,?,?,?)"
        )
        .run(c.session, c.accountId, wallet, c.expires);
      if (c.previous) revoke(c.previous);
    };
    const token = (
      account: string,
      hash: string,
      purpose: string,
      expires: number
    ) => {
      this.db
        .prepare(
          "UPDATE account_tokens SET used=1 WHERE account_id=? AND purpose=?"
        )
        .run(account, purpose);
      this.db
        .prepare(
          "INSERT INTO account_tokens(hash,account_id,purpose,expires) VALUES(?,?,?,?)"
        )
        .run(hash, account, purpose, expires);
    };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (c.op === "register") {
        this.db
          .prepare(
            "INSERT INTO accounts(id,email,password,created) VALUES(?,?,?,?)"
          )
          .run(c.accountId, c.email, c.password, action.now);
        session(null);
        if (c.token !== undefined && c.tokenExpires !== undefined)
          token(c.accountId, c.token, "verify", c.tokenExpires);
      } else if (c.op === "login") session(null);
      else if (c.op === "logout") revoke(c.session);
      else if (c.op === "disconnect") {
        this.db
          .prepare("UPDATE account_sessions SET wallet=NULL WHERE hash=?")
          .run(c.session);
        revoked.push(c.session);
      } else if (c.op === "wallet") {
        this.db
          .prepare(
            "INSERT INTO account_wallets(wallet,account_id,created) VALUES(?,?,?) ON CONFLICT(wallet) DO NOTHING"
          )
          .run(c.wallet, c.accountId, action.now);
        this.db
          .prepare("UPDATE accounts SET wallet=COALESCE(wallet,?) WHERE id=?")
          .run(c.wallet, c.accountId);
        session(c.wallet);
      } else if (c.op === "token")
        token(c.accountId, c.token, c.purpose, c.expires);
      else if (c.op === "verify" || c.op === "reset") {
        const t = this.token(c.token, c.op, action.now);
        if (c.op === "verify")
          this.db
            .prepare("UPDATE accounts SET verified=1 WHERE id=?")
            .run(t.account_id);
        else {
          this.db
            .prepare("UPDATE accounts SET password=? WHERE id=?")
            .run(c.password, t.account_id);
          for (const row of this.db
            .prepare(
              "SELECT hash FROM account_sessions WHERE account_id=? AND revoked=0"
            )
            .all(t.account_id) as any[])
            revoke(row.hash);
        }
        this.db
          .prepare(
            "UPDATE account_tokens SET used=1 WHERE account_id=? AND purpose=?"
          )
          .run(t.account_id, c.op);
      } else if (c.op === "attempt") {
        this.db
          .prepare("DELETE FROM account_attempts WHERE until<=?")
          .run(action.now);
        this.db
          .prepare(
            "INSERT INTO account_attempts(key,count,until) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1"
          )
          .run(c.key, action.now + c.window);
      }
      this.db
        .prepare("INSERT INTO account_applied(id) VALUES(?)")
        .run(action.id);
      this.db.exec("COMMIT");
      return revoked;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}
