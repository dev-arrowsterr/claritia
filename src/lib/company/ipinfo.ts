// IPinfo lookups (docs/m1-website-intelligence.md 7.1). Each visitor's own IP is looked up, never a stand-in address
// from its network: on shared office and broadband blocks the neighbors are often other companies, and a wrong company
// costs more than none. A whole network (/24 or /48) gets a company only when 3 different IPs in it agree (netVerdict).
// Company matches need a plan with company data (IPINFO_COMPANY=1); on the free Lite plan only the network owner is
// known, which never sets an account.

import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";

export type NetworkKind = "business" | "isp" | "hosting" | "vpn" | "mobile" | "education" | "government" | "unknown";
export type NetworkMatch = { domain: string | null; name: string | null; kind: NetworkKind; confidence: number; asnDomain: string | null };

/** Kinds that can set an account. Broadband, mobile, hosting and VPN addresses never do. */
export const ACCOUNT_KINDS: NetworkKind[] = ["business", "education", "government"];
/** The lowest confidence that sets an account (docs/identity.md 8.1). */
export const MIN_CONFIDENCE = 70;
/** Different IPs in one network that must agree before the whole network gets their company. */
export const NET_AGREE = 3;

const low = (v: unknown) => (typeof v === "string" && v ? v.toLowerCase() : null);

/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Turns an IPinfo response into a network kind and confidence. Reads both shapes (check the field names against the
 * plan in use): the classic one (`company`, `asn`, `privacy`, `carrier`) and the newer Core, Plus and Max one
 * (`as`, `anonymous`, `is_hosting`, `is_mobile`, `is_anonymous`), and the Lite one (`as_domain`).
 */
export function readIpinfo(r: any): NetworkMatch {
  const company = r?.company ?? null;
  const asnObj = (typeof r?.asn === "object" && r.asn) || (typeof r?.as === "object" && r.as) || null;
  const asn = asnObj ?? { domain: r?.as_domain ?? null, name: r?.as_name ?? null, type: null };
  const privacy = r?.privacy ?? {};
  const anon = r?.anonymous ?? {};
  const ctype = String(company?.type ?? "").toLowerCase();
  const atype = String(asn?.type ?? "").toLowerCase();
  const vpn = privacy.vpn || privacy.proxy || privacy.relay || privacy.tor || anon.is_vpn || anon.is_proxy || anon.is_relay || anon.is_tor || r?.is_anonymous;
  let kind: NetworkKind = "unknown";
  if (vpn) kind = "vpn";
  else if (privacy.hosting || r?.is_hosting || atype === "hosting" || ctype === "hosting") kind = "hosting";
  else if (r?.carrier || r?.mobile || r?.is_mobile || ctype === "mobile") kind = "mobile";
  else if (ctype === "education" || atype === "education") kind = "education";
  else if (ctype === "government" || atype === "government") kind = "government";
  else if (ctype === "business") kind = "business";
  else if (atype === "isp" || ctype === "isp") kind = "isp";
  else if (atype === "business") kind = "business";
  const domain = low(company?.domain);
  const asnDomain = low(asn?.domain);
  let confidence = 60;
  if (domain && asnDomain && domain === asnDomain) confidence = 90;
  else if (ctype === "business" && atype === "isp") confidence = 75;
  if (!domain) confidence = 0;
  return { domain, name: company?.name ?? null, kind, confidence, asnDomain };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** True when this lookup alone may set an account for the visit it came from. */
export const setsAccount = (m: Pick<NetworkMatch, "domain" | "kind" | "confidence"> | null) => !!m?.domain && ACCOUNT_KINDS.includes(m.kind) && m.confidence >= MIN_CONFIDENCE;

export type NetVerdict = { state: "agreed"; domain: string; kind: NetworkKind; confidence: number } | { state: "mixed" } | { state: "undecided" };

/**
 * What a whole network is, from the lookups of different IPs in it (one row per IP, newest 30 days). A network
 * belongs to a company only when at least NET_AGREE IPs all name that company with enough confidence. One IP that
 * says anything else (another company, broadband, hosting) makes it mixed, and a mixed network never sets an account.
 */
export function netVerdict(rows: Pick<NetworkMatch, "domain" | "kind" | "confidence">[]): NetVerdict {
  if (!rows.length) return { state: "undecided" };
  const first = rows[0]!;
  const same = (r: (typeof rows)[number]) => setsAccount(r) && r.domain === first.domain && r.kind === first.kind;
  if (!rows.every(same)) return { state: "mixed" };
  if (rows.length < NET_AGREE) return { state: "undecided" };
  return { state: "agreed", domain: first.domain!, kind: first.kind, confidence: Math.min(...rows.map((r) => r.confidence)) };
}

// The visitor's IP travels from collect to intel inside the ip_lookup job, encrypted with CLR_IP_SECRET (set on both
// apps, never in the database), and is erased from the job once looked up. The cache keeps only an HMAC of it.

const keyFor = (secret: string, use: string) => createHash("sha256").update(`claritia-ip-${use}:${secret}`).digest();

/** The cache key for one IP: an HMAC, so the cache never holds the address itself. */
export const ipKey = (ip: string, secret: string) => createHmac("sha256", keyFor(secret, "key")).update(ip).digest();

export function sealIp(ip: string, secret: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", keyFor(secret, "seal"), iv);
  const body = Buffer.concat([c.update(ip, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), body].map((b) => b.toString("base64url")).join(".");
}

/** The IP, or null when it can't be opened (wrong or changed secret, or tampered). */
export function openIp(sealed: unknown, secret: string): string | null {
  if (typeof sealed !== "string") return null;
  try {
    const [iv, tag, body] = sealed.split(".").map((p) => Buffer.from(p, "base64url"));
    const d = createDecipheriv("aes-256-gcm", keyFor(secret, "seal"), iv!);
    d.setAuthTag(tag!);
    return Buffer.concat([d.update(body!), d.final()]).toString("utf8");
  } catch {
    return null;
  }
}

export async function lookupIp(ip: string, opts: { token: string; company: boolean; fetcher?: typeof fetch }): Promise<NetworkMatch | null> {
  // Endpoints (check against the plan): the classic API returns company data on plans that include it; Lite has the network owner only.
  const url = opts.company ? `https://ipinfo.io/${encodeURIComponent(ip)}/json` : `https://api.ipinfo.io/lite/${encodeURIComponent(ip)}`;
  const res = await (opts.fetcher ?? fetch)(url, { headers: { authorization: `Bearer ${opts.token}`, accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
  if (res.status === 404) return null;
  if (res.status === 429) throw Object.assign(new Error("IPinfo rate limit"), { retryAfterS: 300 });
  if (!res.ok) throw new Error(`IPinfo ${res.status}`);
  return readIpinfo(await res.json());
}
