// Test inboxes receive mail through a Mailgun route that forwards every message for the inbox domain to
// /api/inbox/mailgun. These helpers check the request really came from Mailgun and work out which project it's for.

import { createHmac, timingSafeEqual } from "node:crypto";

/** Mailgun signs each request: an HMAC-SHA256 of timestamp + token with the webhook signing key. Old requests are refused. */
export function verifyMailgun(signingKey: string, timestamp: string, token: string, signature: string, now = Date.now()) {
  if (!signingKey || !timestamp || !token || !/^[0-9a-f]{64}$/i.test(signature)) return false;
  const age = Math.abs(now / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > 15 * 60) return false;
  const want = createHmac("sha256", signingKey).update(timestamp + token).digest();
  return timingSafeEqual(want, Buffer.from(signature, "hex"));
}

/** <inbox id>-<anything>@<domain> → the inbox id and the full address, or null for mail that isn't ours. */
export function readRecipient(recipient: string, domain: string) {
  const address = recipient.split(",")[0]!.trim().toLowerCase().replace(/^.*</, "").replace(/>.*$/, "");
  const at = address.lastIndexOf("@");
  if (at < 1 || address.slice(at + 1) !== domain.toLowerCase()) return null;
  const local = address.slice(0, at);
  const inboxId = local.split("-")[0]!;
  if (!/^[0-9a-f]{8}$/.test(inboxId) || !/^[a-z0-9-]{1,64}$/.test(local)) return null;
  return { inboxId, address };
}
