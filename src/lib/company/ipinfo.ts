// IPinfo network lookups (docs/m1-website-intelligence.md 7.1). Company matches need a plan with company data
// (IPINFO_COMPANY=1); on the free Lite plan only the network owner is known, which never sets an account.

export type NetworkKind = "business" | "isp" | "hosting" | "vpn" | "mobile" | "education" | "government" | "unknown";
export type NetworkMatch = { domain: string | null; name: string | null; kind: NetworkKind; confidence: number; asnDomain: string | null };

/* eslint-disable @typescript-eslint/no-explicit-any */
/** Turns an IPinfo response (core API with company data, or Lite) into a network kind and confidence. */
export function readIpinfo(r: any): NetworkMatch {
  const company = r?.company ?? null;
  const asn = typeof r?.asn === "object" && r.asn ? r.asn : { domain: r?.as_domain ?? null, name: r?.as_name ?? null, type: null };
  const privacy = r?.privacy ?? {};
  const ctype = String(company?.type ?? "").toLowerCase();
  const atype = String(asn?.type ?? "").toLowerCase();
  let kind: NetworkKind = "unknown";
  if (privacy.vpn || privacy.proxy || privacy.relay || privacy.tor) kind = "vpn";
  else if (privacy.hosting || atype === "hosting" || ctype === "hosting") kind = "hosting";
  else if (r?.carrier || ctype === "mobile") kind = "mobile";
  else if (ctype === "education" || atype === "education") kind = "education";
  else if (ctype === "government" || atype === "government") kind = "government";
  else if (ctype === "business") kind = "business";
  else if (atype === "isp" || ctype === "isp") kind = "isp";
  else if (atype === "business") kind = "business";
  const domain = company?.domain ? String(company.domain).toLowerCase() : null;
  const asnDomain = asn?.domain ? String(asn.domain).toLowerCase() : null;
  let confidence = 60;
  if (domain && asnDomain && domain === asnDomain) confidence = 90;
  else if (ctype === "business" && atype === "isp") confidence = 75;
  if (!domain) confidence = 0;
  return { domain, name: company?.name ?? null, kind, confidence, asnDomain };
}

/** A representative address in the network: the first host. */
export function sampleIp(net: string): string | null {
  const [base, len] = net.split("/");
  if (!base || !len) return null;
  if (base.includes(".")) {
    const p = base.split(".").map(Number);
    if (p.length !== 4 || p.some((x) => !(x >= 0 && x <= 255))) return null;
    return `${p[0]}.${p[1]}.${p[2]}.1`;
  }
  return base.endsWith("::") ? `${base}1` : null;
}

export async function lookupNetwork(net: string, opts: { token: string; company: boolean; fetcher?: typeof fetch }): Promise<NetworkMatch | null> {
  const ip = sampleIp(net);
  if (!ip) return null;
  // Endpoints (check against the plan): the core API returns company data on Business plans; Lite has network only.
  const url = opts.company ? `https://ipinfo.io/${ip}/json` : `https://api.ipinfo.io/lite/${ip}`;
  const res = await (opts.fetcher ?? fetch)(url, { headers: { authorization: `Bearer ${opts.token}`, accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
  if (res.status === 404) return null;
  if (res.status === 429) throw Object.assign(new Error("IPinfo rate limit"), { retryAfterS: 300 });
  if (!res.ok) throw new Error(`IPinfo ${res.status}`);
  return readIpinfo(await res.json());
}
