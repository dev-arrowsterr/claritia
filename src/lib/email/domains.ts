// A sending domain's DNS records and their state (docs/marketing-platform.md M3, Settings › Sending).
//   DKIM: three CNAMEs from SES (Easy DKIM).
//   SPF and bounces: an MX and a TXT on the custom MAIL FROM subdomain.
//   DMARC: a TXT at _dmarc (or on a parent domain), p=none is enough.
// Sending stays blocked until SES confirms DKIM and MAIL FROM and a DMARC record exists.

import { promises as dns } from "node:dns";
import type { Identity } from "./ses.ts";

export type RecordState = "verified" | "waiting" | "wrong";
export type DnsRecord = { key: string; type: "CNAME" | "MX" | "TXT"; name: string; value: string; status: RecordState; seen?: string };
export type DomainRow = { id: string; domain: string; mail_from: string; dkim_tokens: string[] };

export type Resolver = {
  cname: (name: string) => Promise<string[]>;
  mx: (name: string) => Promise<{ exchange: string; priority: number }[]>;
  txt: (name: string) => Promise<string[][]>;
};

export const systemResolver: Resolver = { cname: (n) => dns.resolveCname(n), mx: (n) => dns.resolveMx(n), txt: (n) => dns.resolveTxt(n) };

/** The records to add, before any check. */
export function expectedRecords(d: DomainRow, region: string, tokens = d.dkim_tokens): Omit<DnsRecord, "status">[] {
  return [
    ...tokens.map((t, i) => ({ key: `dkim${i + 1}`, type: "CNAME" as const, name: `${t}._domainkey.${d.domain}`, value: `${t}.dkim.amazonses.com` })),
    { key: "mx", type: "MX" as const, name: d.mail_from, value: `10 feedback-smtp.${region}.amazonses.com` },
    { key: "spf", type: "TXT" as const, name: d.mail_from, value: "v=spf1 include:amazonses.com ~all" },
    { key: "dmarc", type: "TXT" as const, name: `_dmarc.${d.domain}`, value: `v=DMARC1; p=none; rua=mailto:dmarc@${d.domain}` },
  ];
}

// Empty answers and "no such name" mean the record isn't there yet. Anything else (a timeout) tells us nothing.
const missing = (e: unknown) => ["ENOTFOUND", "ENODATA", "ENONAME", "NXDOMAIN"].includes((e as { code?: string }).code ?? "");
async function look<T>(f: () => Promise<T[]>): Promise<T[] | null> {
  try {
    return await f();
  } catch (e) {
    return missing(e) ? [] : null;
  }
}
const same = (a: string, b: string) => a.toLowerCase().replace(/\.$/, "") === b.toLowerCase().replace(/\.$/, "");

/** Check every record. SES's word wins for DKIM and MAIL FROM; DNS tells "waiting" from "wrong". */
export async function checkRecords(d: DomainRow, identity: Identity, region: string, r: Resolver = systemResolver): Promise<{ records: DnsRecord[]; status: "pending" | "verified" | "failed" }> {
  const tokens = identity.dkimTokens.length ? identity.dkimTokens : d.dkim_tokens;
  const want = expectedRecords(d, region, tokens);
  const dkimOk = identity.dkimStatus === "SUCCESS";
  const mailFromOk = identity.mailFromStatus === "SUCCESS" && identity.mailFrom === d.mail_from;

  const records: DnsRecord[] = [];
  for (const w of want) {
    if (w.type === "CNAME") {
      if (dkimOk) {
        records.push({ ...w, status: "verified" });
        continue;
      }
      const got = await look(() => r.cname(w.name));
      records.push({ ...w, status: got?.length && !got.some((g) => same(g, w.value)) ? "wrong" : "waiting", ...(got?.length ? { seen: got.join(", ") } : {}) });
    } else if (w.key === "mx") {
      if (mailFromOk) {
        records.push({ ...w, status: "verified" });
        continue;
      }
      const got = await look(() => r.mx(w.name));
      const host = w.value.split(" ")[1];
      records.push({ ...w, status: got?.length && !got.some((g) => same(g.exchange, host)) ? "wrong" : "waiting", ...(got?.length ? { seen: got.map((g) => `${g.priority} ${g.exchange}`).join(", ") } : {}) });
    } else if (w.key === "spf") {
      const got = (await look(() => r.txt(w.name)))?.map((p) => p.join("")) ?? null;
      const spf = got?.filter((t) => /^v=spf1\b/i.test(t)) ?? [];
      const ok = spf.some((t) => /include:amazonses\.com\b/i.test(t));
      records.push({ ...w, status: ok && mailFromOk ? "verified" : spf.length && !ok ? "wrong" : "waiting", ...(spf.length ? { seen: spf.join(" | ") } : {}) });
    } else {
      const found = await dmarcOf(d.domain, r);
      records.push({ ...w, status: found.ok ? "verified" : found.seen ? "wrong" : "waiting", ...(found.seen ? { seen: found.seen } : {}) });
    }
  }
  const dmarc = records.find((x) => x.key === "dmarc")?.status === "verified";
  const status = identity.dkimStatus === "FAILED" ? "failed" : dkimOk && mailFromOk && dmarc ? "verified" : "pending";
  return { records, status };
}

/** A DMARC record at _dmarc.<domain>, or on a parent domain (DMARC falls back to the organizational domain). */
async function dmarcOf(domain: string, r: Resolver): Promise<{ ok: boolean; seen?: string }> {
  const parts = domain.split(".");
  for (let i = 0; i < parts.length - 1; i++) {
    const got = (await look(() => r.txt(`_dmarc.${parts.slice(i).join(".")}`)))?.map((p) => p.join("")) ?? [];
    if (!got.length) continue;
    const rec = got.find((t) => /^v=DMARC1\s*(;|$)/i.test(t));
    return rec ? { ok: true, seen: rec } : { ok: false, seen: got.join(" | ") };
  }
  return { ok: false };
}
