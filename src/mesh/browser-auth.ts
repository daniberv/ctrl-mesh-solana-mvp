import { IncomingMessage, ServerResponse } from "http";
import { randomBytes, randomUUID, createHash } from "crypto";
import { PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";
import { Engine } from "./engine";
import { authError } from "./accounts";
import { checkPassword, hashPassword, normalizeEmail } from "./passwords";
import { LocalMail } from "./local-mail";
import { requestIP } from "./request-ip";

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const random = () => randomBytes(32).toString("hex");
const SESSION_MS = 8 * 60 * 60 * 1000;
/** Email sessions and wallet proofs are separate. Agent bearer authentication stays independent. */
export class BrowserAuth {
  private challenges = new Map<
    string,
    {
      actor: string;
      account: string;
      session: string;
      origin: string;
      message: string;
      expires: number;
    }
  >();
  readonly cookieName: string;
  constructor(
    private engine: Engine,
    private mail?: LocalMail,
    private trustProxy = false
  ) {
    // A new namespace deliberately invalidates old wallet-only browser sessions.
    this.cookieName =
      "mesh_account_" + hash(engine.store.meta("stream")!).slice(0, 12);
  }
  private cookie(req: IncomingMessage) {
    return (
      (req.headers.cookie || "")
        .split(";")
        .map((v) => v.trim())
        .find((v) => v.startsWith(this.cookieName + "="))
        ?.slice(this.cookieName.length + 1) || ""
    );
  }
  private setCookie(res: ServerResponse, value: string, origin: string) {
    res.setHeader(
      "Set-Cookie",
      `${
        this.cookieName
      }=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${
        value ? SESSION_MS / 1000 : 0
      }${origin.startsWith("https:") ? "; Secure" : ""}`
    );
  }
  sessionHash(req: IncomingMessage) {
    const value = this.cookie(req);
    return /^[a-f0-9]{64}$/.test(value) ? hash(value) : "";
  }
  session(req: IncomingMessage) {
    return this.engine.store.accounts.session(this.sessionHash(req));
  }
  private requireSession(req: IncomingMessage) {
    const s = this.session(req);
    if (!s) throw authError("Authentication required", 401);
    return s;
  }
  actor(req: IncomingMessage) {
    const s = this.requireSession(req);
    if (!s.actor)
      throw authError(
        "Connect and verify a wallet for this account to open the workspace.",
        403
      );
    return s.actor;
  }
  private previous(req: IncomingMessage) {
    const previous = this.sessionHash(req);
    return previous ? { previous } : {};
  }
  private mailer() {
    if (!this.mail)
      throw authError("Password reset delivery is not configured.", 503);
    return this.mail;
  }
  private async attempt(key: string, limit = 8, window = 15 * 60000) {
    await this.engine.account({ op: "attempt", key: hash(key), limit, window });
  }
  private send(
    accountId: string,
    email: string,
    token: string,
    expires: number,
    origin: string
  ) {
    this.mailer().send(accountId, "reset", {
      to: email,
      subject: "Reset your ctrl-mesh password",
      url: `${origin}/reset-password?token=${token}`,
      expires,
    });
  }
  async register(
    req: IncomingMessage,
    res: ServerResponse,
    input: any,
    origin: string
  ) {
    const email = normalizeEmail(input.email);
    await this.attempt(
      "register:" + requestIP(req, this.trustProxy),
      10,
      60 * 60000
    );
    const password = await hashPassword(input.password),
      accountId = randomUUID(),
      session = random(),
      expires = Date.now() + SESSION_MS;
    await this.engine.account({
      op: "register",
      accountId,
      email,
      password,
      session: hash(session),
      expires,
      ...this.previous(req),
    });
    this.setCookie(res, session, origin);
    return this.engine.store.accounts.session(hash(session));
  }
  async login(
    req: IncomingMessage,
    res: ServerResponse,
    input: any,
    origin: string
  ) {
    const email = normalizeEmail(input.email);
    await this.attempt("login-ip:" + req.socket.remoteAddress, 30);
    await this.attempt("login-email:" + email);
    const account = this.engine.store.accounts.byEmail(email);
    if (!(await checkPassword(input.password, account?.password)) || !account)
      throw authError("Email or password is incorrect.", 401);
    const session = random(),
      expires = Date.now() + SESSION_MS;
    // Recheck the hash under the mutation lock: a concurrent password reset wins.
    await this.engine.account({
      op: "login",
      accountId: account.id,
      password: account.password,
      session: hash(session),
      expires,
      ...this.previous(req),
    });
    this.setCookie(res, session, origin);
    return this.engine.store.accounts.session(hash(session));
  }
  async forgot(req: IncomingMessage, input: any, origin: string) {
    this.mailer();
    const email = normalizeEmail(input.email);
    await this.attempt("forgot-ip:" + req.socket.remoteAddress, 10);
    await this.attempt("forgot-email:" + email, 3);
    const account = this.engine.store.accounts.byEmail(email);
    if (account) {
      const token = random(),
        expires = Date.now() + 30 * 60000;
      await this.engine.account({
        op: "token",
        accountId: account.id,
        purpose: "reset",
        token: hash(token),
        expires,
      });
      this.send(account.id, account.email, token, expires, origin);
    }
    return { ok: true, localMail: !!this.mail };
  }
  async reset(input: any) {
    if (typeof input.token !== "string" || !/^[a-f0-9]{64}$/.test(input.token))
      throw authError("Invalid password reset link.");
    const password = await hashPassword(input.password);
    await this.engine.account({
      op: "reset",
      token: hash(input.token),
      password,
    });
    return { ok: true };
  }
  async challenge(
    req: IncomingMessage,
    _res: ServerResponse,
    input: any,
    origin: string
  ) {
    await this.engine.readBarrier();
    const s = this.requireSession(req);
    const actor = new PublicKey(input.actor).toBase58();
    if (actor !== input.actor) throw authError("Invalid wallet address");
    const now = Date.now();
    for (const [id, c] of this.challenges)
      if (c.expires < now) this.challenges.delete(id);
    if (this.challenges.size >= 1000)
      throw authError("Too many wallet requests; retry later", 429);
    const nonce = random(),
      expires = now + 120000;
    const message = `${
      new URL(origin).host
    } wants you to link your Solana wallet to ctrl-mesh:\n${actor}\n\nEmail: ${
      s.account.email
    }\nAccount: ${
      s.account.id
    }\n\nConfirm that this wallet belongs to your account. This signature does not authorize a transaction or payment.\n\nURI: ${origin}\nVersion: 1\nNonce: ${nonce}\nIssued At: ${new Date(
      now
    ).toISOString()}\nExpiration Time: ${new Date(expires).toISOString()}`;
    this.challenges.set(nonce, {
      actor,
      account: s.account.id,
      session: this.sessionHash(req),
      origin,
      message,
      expires,
    });
    return { nonce, message };
  }
  async connect(
    req: IncomingMessage,
    res: ServerResponse,
    input: any,
    origin: string
  ) {
    await this.engine.readBarrier();
    const c = this.challenges.get(input.nonce);
    this.challenges.delete(input.nonce);
    if (
      !c ||
      c.expires < Date.now() ||
      c.origin !== origin ||
      c.session !== this.sessionHash(req)
    )
      throw authError(
        "Wallet request expired or belongs to another browser. Try again."
      );
    if (
      typeof input.signature !== "string" ||
      !/^[a-f0-9]{128}$/.test(input.signature) ||
      !nacl.sign.detached.verify(
        Buffer.from(c.message),
        Buffer.from(input.signature, "hex"),
        new PublicKey(c.actor).toBytes()
      )
    )
      throw authError("Wallet signature is invalid");
    const session = random(),
      expires = Date.now() + SESSION_MS;
    await this.engine.account({
      op: "wallet",
      accountId: c.account,
      wallet: c.actor,
      previous: c.session,
      session: hash(session),
      expires,
    });
    this.setCookie(res, session, origin);
    return this.engine.store.accounts.session(hash(session));
  }
  async disconnect(req: IncomingMessage) {
    await this.engine.account({
      op: "disconnect",
      session: this.sessionHash(req),
    });
    return { ok: true };
  }
  async logout(req: IncomingMessage, res: ServerResponse, origin: string) {
    if (this.sessionHash(req))
      await this.engine.account({
        op: "logout",
        session: this.sessionHash(req),
      });
    this.setCookie(res, "", origin);
    return { ok: true };
  }
}
