// The time a form was shown, signed, so the submit route can tell a bot that posts at once (or replays an old page)
// from a person. Keyed from SECRETS_KEY.

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const key = (secret = process.env.SECRETS_KEY) => {
  const s = secret?.trim();
  if (!s || s.length < 32) throw new Error("Add SECRETS_KEY (32 or more random characters) on the server.");
  return createHash("sha256").update(`claritia-forms|${s}`).digest();
};

export function shownToken(formId: string, now = Date.now(), secret?: string): string {
  const body = `${formId}.${now}`;
  return `${now}.${createHmac("sha256", key(secret)).update(body).digest("base64url").slice(0, 22)}`;
}

/** How long ago the form was shown, in ms, or null when the token is missing, forged or for another form. */
export function shownAgo(formId: string, token: unknown, now = Date.now(), secret?: string): number | null {
  if (typeof token !== "string" || token.length > 80) return null;
  const [at, mac] = token.split(".");
  const t = Number(at);
  if (!Number.isFinite(t) || !mac) return null;
  const want = Buffer.from(createHmac("sha256", key(secret)).update(`${formId}.${t}`).digest("base64url").slice(0, 22));
  const got = Buffer.from(mac);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  return now - t;
}
