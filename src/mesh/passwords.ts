import { randomBytes, scrypt, timingSafeEqual } from "crypto";
import { authError } from "./accounts";
// OWASP scrypt baseline, bounded concurrency to avoid unbounded memory pressure.
let running = 0;
const derive = async (password: string, salt: Buffer) => {
  if (running >= 2)
    throw authError("Sign-in service is busy. Please retry shortly.", 503);
  running++;
  try {
    return await new Promise<Buffer>((resolve, reject) =>
      scrypt(
        password,
        salt,
        32,
        { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 },
        (e, key) => (e ? reject(e) : resolve(key))
      )
    );
  } finally {
    running--;
  }
};
export function normalizeEmail(value: unknown) {
  if (typeof value !== "string")
    throw authError("Enter a valid email address.");
  const email = value.trim().toLowerCase();
  if (
    email.length > 254 ||
    !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i.test(
      email
    )
  )
    throw authError("Enter a valid email address.");
  return email;
}
export function validatePassword(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length < 15 || value.length > 128)
    throw authError("Use a password between 15 and 128 characters.");
}
export async function hashPassword(password: unknown) {
  validatePassword(password);
  const salt = randomBytes(16),
    key = await derive(password, salt);
  return `scrypt:131072:8:1:${salt.toString("hex")}:${key.toString("hex")}`;
}
export async function checkPassword(password: unknown, stored?: string) {
  if (typeof password !== "string" || password.length > 128) return false;
  const fields = (
    stored || `scrypt:131072:8:1:${"00".repeat(16)}:${"00".repeat(32)}`
  ).split(":");
  if (
    fields.length !== 6 ||
    fields.slice(0, 4).join(":") !== "scrypt:131072:8:1"
  )
    return false;
  const expected = Buffer.from(fields[5], "hex"),
    actual = await derive(password, Buffer.from(fields[4], "hex"));
  return (
    expected.length === actual.length &&
    timingSafeEqual(actual, expected) &&
    !!stored
  );
}
