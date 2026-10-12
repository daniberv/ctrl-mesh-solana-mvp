import { IncomingMessage, ServerResponse } from "http";
import { randomBytes, createHash } from "crypto";
import { PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";
import { Engine } from "./engine";

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const SESSION_MS = 8 * 60 * 60 * 1000;
/** Browser-only, domain-bound authentication. Agent bearer auth remains separate. */
export class BrowserAuth {
  private challenges = new Map<
    string,
    {
      actor: string;
      origin: string;
      message: string;
      expires: number;
      binding: string;
    }
  >();
  readonly cookieName: string;
  constructor(private engine: Engine) {
    this.cookieName =
      "mesh_session_" + hash(engine.store.meta("stream")!).slice(0, 12);
  }
  private cookie(req: IncomingMessage, name: string) {
    return (
      (req.headers.cookie || "")
        .split(";")
        .map((v) => v.trim())
        .find((v) => v.startsWith(name + "="))
        ?.slice(name.length + 1) || ""
    );
  }
  private setCookie(
    res: ServerResponse,
    name: string,
    value: string,
    maxAge: number,
    origin: string
  ) {
    const cookie = `${name}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${
      origin.startsWith("https:") ? "; Secure" : ""
    }`;
    const previous = res.getHeader("Set-Cookie");
    res.setHeader("Set-Cookie", [
      ...(Array.isArray(previous)
        ? previous
        : previous
        ? [String(previous)]
        : []),
      cookie,
    ]);
  }
  sessionHash(req: IncomingMessage) {
    const value = this.cookie(req, this.cookieName);
    return /^[a-f0-9]{64}$/.test(value) ? hash(value) : "";
  }
  session(req: IncomingMessage) {
    return this.engine.store.browserSession(this.sessionHash(req));
  }
  actor(req: IncomingMessage) {
    const session = this.session(req);
    if (!session) throw Error("Authentication required");
    return session.actor;
  }
  async challenge(
    req: IncomingMessage,
    res: ServerResponse,
    input: any,
    origin: string
  ) {
    await this.engine.readBarrier();
    const actor = new PublicKey(input.actor).toBase58();
    if (actor !== input.actor) throw Error("Invalid wallet address");
    const now = Date.now();
    for (const [id, c] of this.challenges)
      if (c.expires < now) this.challenges.delete(id);
    if (this.challenges.size >= 1000)
      throw Error("Too many sign-in requests; retry later");
    const nonce = randomBytes(24).toString("hex"),
      binding = randomBytes(24).toString("hex"),
      expires = now + 120000;
    const message = `${
      new URL(origin).host
    } wants you to sign in with your Solana account:\n${actor}\n\nSign in to ctrl-mesh. This request does not authorize a transaction or payment.\n\nURI: ${origin}\nVersion: 1\nNonce: ${nonce}\nIssued At: ${new Date(
      now
    ).toISOString()}\nExpiration Time: ${new Date(expires).toISOString()}`;
    this.challenges.set(nonce, {
      actor,
      origin,
      message,
      expires,
      binding: hash(binding),
    });
    this.setCookie(res, this.cookieName + "_challenge", binding, 120, origin);
    return { nonce, message };
  }
  async login(
    req: IncomingMessage,
    res: ServerResponse,
    input: any,
    origin: string
  ) {
    await this.engine.readBarrier();
    const c = this.challenges.get(input.nonce);
    // Consume even a failed attempt, preventing concurrent/replayed signatures.
    this.challenges.delete(input.nonce);
    if (
      !c ||
      c.expires < Date.now() ||
      c.origin !== origin ||
      c.binding !== hash(this.cookie(req, this.cookieName + "_challenge"))
    )
      throw Error(
        "Sign-in request expired or belongs to another browser. Try again."
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
      throw Error("Wallet signature is invalid");
    const token = randomBytes(32).toString("hex"),
      expires = Date.now() + SESSION_MS;
    await this.engine.recordSession({
      type: "session.create",
      hash: hash(token),
      actor: c.actor,
      expires,
      // Omit absent fields so JSON replication preserves the action hash.
      ...(this.sessionHash(req) ? { previous: this.sessionHash(req) } : {}),
    });
    this.setCookie(res, this.cookieName, token, SESSION_MS / 1000, origin);
    this.setCookie(res, this.cookieName + "_challenge", "", 0, origin);
    return { actor: c.actor, expires };
  }
  async logout(req: IncomingMessage, res: ServerResponse, origin: string) {
    const session = this.sessionHash(req);
    if (session)
      await this.engine.recordSession({
        type: "session.revoke",
        hash: session,
      });
    this.setCookie(res, this.cookieName, "", 0, origin);
    this.setCookie(res, this.cookieName + "_challenge", "", 0, origin);
    return { ok: true };
  }
}
