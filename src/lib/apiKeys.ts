// API keys for the REST API and the CLI. A key is "clr_" and 40 random characters. Only its SHA-256 is stored.

import { createHash, randomBytes } from "node:crypto";

export const KEY_PATTERN = /^clr_[A-Za-z0-9_-]{40}$/;

/** A new key, its hash and the prefix shown in Settings. */
export function makeKey() {
  const key = `clr_${randomBytes(30).toString("base64url")}`;
  return { key, hash: hashKey(key), prefix: key.slice(0, 8) };
}

export const hashKey = (key: string) => createHash("sha256").update(key).digest("hex");

/** The key in an Authorization header ("Bearer clr_..."), or null. */
export function keyFromHeader(header: string | null): string | null {
  const key = header?.replace(/^Bearer\s+/i, "").trim() ?? "";
  return KEY_PATTERN.test(key) ? key : null;
}
