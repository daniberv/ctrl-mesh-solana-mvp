import type { IncomingMessage } from "http";
import { isIP } from "net";

/** The reverse proxy must overwrite X-Real-IP. Trust it only over loopback. */
export function requestIP(req: IncomingMessage, trustProxy = false) {
  const peer = req.socket.remoteAddress || "unknown";
  const forwarded = req.headers["x-real-ip"];
  return trustProxy &&
    ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(peer) &&
    typeof forwarded === "string" &&
    isIP(forwarded)
    ? forwarded
    : peer;
}
