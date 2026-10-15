// Does an email domain take mail? MX records, or an A record as the fallback (RFC 5321). Cached 7 days per domain.
// Catches typos like gmial.com before they become people (docs/identity.md 5.4).

import { promises as dns } from "node:dns";

const TTL = 7 * 86400_000;
const cache = new Map<string, { ok: boolean; at: number }>();

export type DomainCheck = (domain: string) => Promise<boolean>;

export const dnsCheck: DomainCheck = async (domain) => {
  const hit = cache.get(domain);
  if (hit && Date.now() - hit.at < TTL) return hit.ok;
  let ok: boolean;
  try {
    ok = (await dns.resolveMx(domain)).some((r) => r.exchange && r.exchange !== ".");
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "ENOTFOUND" || code === "ENODATA" || code === "ENONAME") {
      try {
        ok = (await dns.resolve4(domain)).length > 0;
      } catch {
        ok = false;
      }
    } else {
      // A DNS outage must not drop real people: let it through and don't cache.
      return true;
    }
  }
  if (cache.size > 50_000) cache.clear();
  cache.set(domain, { ok, at: Date.now() });
  return ok;
};
