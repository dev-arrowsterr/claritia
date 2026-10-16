// Click and unsubscribe links (docs/marketing-platform.md M3). A token names one message and, for clicks, the
// link's place in the email's list, signed so nobody can make one up or unsubscribe someone else.
//   token = base64url(version | kind | message id (16 bytes) | link (2 bytes)) + base64url(HMAC-SHA256, first 16 bytes)
// The key comes from SECRETS_KEY, which the web app and the worker share.

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export type LinkToken = { kind: "click" | "unsub"; message: string; link: number };

const KINDS = ["click", "unsub"] as const;

function linkKey(secret = process.env.SECRETS_KEY): Buffer {
  const s = secret?.trim();
  if (!s || s.length < 32) throw new Error("Add SECRETS_KEY (32 or more random characters) on the server.");
  return createHash("sha256").update(`claritia-email-links|${s}`).digest();
}

export function makeToken(t: LinkToken, secret?: string): string {
  const body = Buffer.alloc(20);
  body[0] = 1;
  body[1] = KINDS.indexOf(t.kind);
  Buffer.from(t.message.replace(/-/g, ""), "hex").copy(body, 2);
  body.writeUInt16BE(t.link, 18);
  const mac = createHmac("sha256", linkKey(secret)).update(body).digest().subarray(0, 16);
  return `${body.toString("base64url")}.${mac.toString("base64url")}`;
}

/** The token's contents, or null when it's malformed or the signature doesn't match. */
export function readToken(token: string, secret?: string): LinkToken | null {
  const [b, m] = token.split(".");
  if (!b || !m || b.length > 40 || m.length > 30) return null;
  const body = Buffer.from(b, "base64url");
  const mac = Buffer.from(m, "base64url");
  if (body.length !== 20 || mac.length !== 16 || body[0] !== 1 || body[1] >= KINDS.length) return null;
  const want = createHmac("sha256", linkKey(secret)).update(body).digest().subarray(0, 16);
  if (!timingSafeEqual(mac, want)) return null;
  const hex = body.subarray(2, 18).toString("hex");
  const message = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return { kind: KINDS[body[1]], message, link: body.readUInt16BE(18) };
}

const HREF = /(<a\b[^>]*?\shref\s*=\s*)(?:"([^"]*)"|'([^']*)')/gi;
const decode = (s: string) => s.replace(/&amp;/gi, "&").replace(/&#38;/g, "&").trim();
const trackable = (url: string) => /^https?:\/\//i.test(url) && !url.includes("{{");

/** The http(s) links in an email's html, in order. Each one's place is what a click token carries. */
export function extractLinks(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(HREF)) {
    const url = decode(m[2] ?? m[3]);
    if (trackable(url)) out.push(url);
  }
  return out;
}

/** The html with each trackable link swapped for linkFor(its place). Same order as extractLinks. */
export function rewriteLinks(html: string, linkFor: (i: number) => string): string {
  let i = 0;
  return html.replace(HREF, (all, pre: string, dq: string | undefined, sq: string | undefined) => {
    const q = dq !== undefined ? '"' : "'";
    return trackable(decode(dq ?? sq ?? "")) ? `${pre}${q}${linkFor(i++)}${q}` : all;
  });
}

// Mail filters that open links to check them. Real browsers never send these.
const SCANNER = /bot\b|crawler|spider|scanner|preview|barracuda|mimecast|proofpoint|symantec|messagelabs|trendmicro|forcepoint|ironport|fortinet|sophos|safelinks|python|curl\/|wget|go-http|java\/|okhttp|headless|phantomjs|slurp|facebookexternalhit|linkedinbot|slackbot|skypeuripreview|whatsapp|discordbot/i;

/** Whether a click looks like a mail filter by its method and user agent. Timing rules live in email_click (SQL). */
export function looksLikeScanner(method: string, userAgent: string | null): boolean {
  if (method.toUpperCase() === "HEAD") return true;
  const ua = (userAgent ?? "").trim();
  return !ua || SCANNER.test(ua);
}
