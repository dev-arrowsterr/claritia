// Device ids, hop tokens and cookieless keys (docs/identity.md 4.1, 4.7, 4.8). All signed with keys derived from
// CLR_ID_SECRET, so a crafted id or token is ignored.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const b64 = (b: Buffer) => b.toString("base64url");
const hmac = (key: Buffer | string, data: Buffer | string) => createHmac("sha256", key).update(data).digest();

/** Per-site key for device ids. */
export const siteKey = (secret: string, siteId: string) => hmac(secret, "site:" + siteId);
/** Per-workspace key for hop tokens, so a token works across all of a workspace's sites. */
export const hopKey = (secret: string, workspaceId: string) => hmac(secret, "hop:" + workspaceId);

/** A uuid v7: 48 bits of milliseconds, then random. */
export function uuid7(now = Date.now()): string {
  const b = randomBytes(16);
  b.writeUIntBE(now, 0, 6);
  b[6] = (b[6] & 0x0f) | 0x70;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function signDevice(key: Buffer, uuid: string): string {
  return `v1.${uuid}.${b64(hmac(key, uuid).subarray(0, 8))}`;
}

/** The uuid inside a signed device id, or null when it's not one we made for this site. */
export function verifyDevice(key: Buffer, id: unknown): string | null {
  if (typeof id !== "string" || id.length > 80) return null;
  const [v, uuid, sig] = id.split(".");
  if (v !== "v1" || !UUID.test(uuid ?? "") || !sig) return null;
  const want = hmac(key, uuid).subarray(0, 8);
  const got = Buffer.from(sig, "base64url");
  return got.length === want.length && timingSafeEqual(got, want) ? uuid : null;
}

/** When the device was made, from the uuid v7 time prefix. */
export function deviceBornAt(uuid: string): number {
  return parseInt(uuid.replace(/-/g, "").slice(0, 12), 16);
}

const HOP_S = 120;

/** t = base64url(uuid 16 | expiry 4 | nonce 8) . base64url(hmac 16) */
export function makeHop(key: Buffer, uuid: string, now = Date.now()): string {
  const p = Buffer.alloc(28);
  Buffer.from(uuid.replace(/-/g, ""), "hex").copy(p, 0);
  p.writeUInt32BE(Math.floor(now / 1000) + HOP_S, 16);
  randomBytes(8).copy(p, 20);
  return `${b64(p)}.${b64(hmac(key, p).subarray(0, 16))}`;
}

/** The device uuid and nonce from a hop token, or null when it's forged or expired. The caller checks the nonce. */
export function readHop(key: Buffer, t: unknown, now = Date.now()): { uuid: string; nonce: Buffer } | null {
  if (typeof t !== "string" || t.length > 100) return null;
  const [a, b] = t.split(".");
  if (!a || !b) return null;
  const p = Buffer.from(a, "base64url");
  const sig = Buffer.from(b, "base64url");
  if (p.length !== 28 || sig.length !== 16 || !timingSafeEqual(sig, hmac(key, p).subarray(0, 16))) return null;
  if (p.readUInt32BE(16) < Math.floor(now / 1000)) return null;
  const h = p.subarray(0, 16).toString("hex");
  return { uuid: `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`, nonce: p.subarray(20) };
}

/** Cookieless session key: HMAC(daily salt, site | network | user agent | language). Changes every day. */
export function cookielessKey(salt: Buffer, siteId: string, ipNet: string, ua: string, lang: string): Buffer {
  return hmac(salt, [siteId, ipNet, ua, lang].join("|")).subarray(0, 16);
}
