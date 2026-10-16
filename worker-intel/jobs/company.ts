// Account jobs (docs/m1-website-intelligence.md Part 6): ip_lookup, enrich_company, identity_changed.

import { createHash } from "node:crypto";
import type pg from "pg";
import { accountForDomain, resolveSessions } from "../../src/lib/company/accounts.ts";
import { enrichDomain } from "../../src/lib/company/coresignal.ts";
import { cleanDomain, redirectAlias } from "../../src/lib/company/domains.ts";
import { ipKey, lookupIp, netVerdict, openIp, setsAccount, type NetworkMatch } from "../../src/lib/company/ipinfo.ts";
import { ipNet } from "../../collect/geo.ts";
import { JobError, type Handler } from "../../src/lib/jobs.ts";

export type CompanyDeps = {
  ipinfoToken?: string;
  ipinfoCompany?: boolean;
  /** CLR_IP_SECRET: opens the visitor's IP in the job and keys the per-IP cache. Same value as on collect. */
  ipSecret?: string;
  coresignalKey?: string;
  lookup?: typeof lookupIp;
  enrich?: typeof enrichDomain;
  alias?: (domain: string) => Promise<string | null>;
};

const retry = (e: unknown) => {
  const after = (e as { retryAfterS?: number }).retryAfterS;
  return after ? new JobError((e as Error).message, { retryAfterS: after }) : e;
};

async function scoreLater(pool: pg.Pool, ws: string, accounts: string[]) {
  for (const a of accounts) await pool.query(`select enqueue_job($1, 'score_account', $2, $3, 60)`, [ws, a, JSON.stringify({ account_id: a })]);
}

/**
 * ip_lookup: who the visitor's own IP belongs to (cached 30 days per IP, shared), then the visit's account. The IP
 * arrives encrypted (sealIp in collect) and is erased from the job once used. A whole network gets a company only
 * when 3 different IPs in it agree (netVerdict); then that network's recent visits get it too.
 */
export const ipLookup = (pool: pg.Pool, deps: CompanyDeps): Handler => async (job) => {
  const net = String(job.payload.net ?? "");
  if (!job.workspace_id || !/^[0-9a-f.:]+\/\d+$/i.test(net)) throw new JobError("ip_lookup needs a network", { retry: false });
  const sessionId = typeof job.payload.session_id === "string" && /^[0-9a-f-]{36}$/.test(job.payload.session_id) ? job.payload.session_id : null;
  const erase = () => (job.payload.ip ? pool.query(`update jobs set payload = payload - 'ip' where id = $1`, [job.id]) : null);
  // Without the secret, or with an IP from another network, nothing is looked up: no company beats a wrong one.
  const ip = deps.ipSecret ? openIp(job.payload.ip, deps.ipSecret) : null;
  const touched = new Set<string>();
  if (ip && deps.ipSecret && ipNet(ip) === net) {
    const key = ipKey(ip, deps.ipSecret);
    let hit = (await pool.query(`select domain, kind, confidence from ip_cache where key = $1 and scope = 'ip' and fetched_at > now() - interval '30 days'`, [key])).rows[0] as
      | Pick<NetworkMatch, "domain" | "kind" | "confidence">
      | undefined;
    if (!hit && deps.ipinfoToken) {
      let m: NetworkMatch | null;
      try {
        m = await (deps.lookup ?? lookupIp)(ip, { token: deps.ipinfoToken, company: !!deps.ipinfoCompany });
      } catch (e) {
        if (job.attempts >= job.max_attempts) await erase();
        throw retry(e);
      }
      hit = { domain: m?.domain ?? null, kind: m?.kind ?? "unknown", confidence: m?.confidence ?? 0 };
      await pool.query(
        `insert into ip_cache (key, net, domain, kind, confidence, vendor, scope, fetched_at) values ($1, $2::cidr, $3, $4, $5, 'ipinfo', 'ip', now())
         on conflict (key) do update set net = excluded.net, domain = excluded.domain, kind = excluded.kind, confidence = excluded.confidence, scope = 'ip', fetched_at = now()`,
        [key, net, hit.domain, hit.kind, hit.confidence],
      );
    }
    await saveNetVerdict(pool, net);
    if (sessionId && hit && setsAccount(hit)) {
      const account = await accountForDomain(pool, job.workspace_id, hit.domain!);
      if (account) await pool.query(`update sessions set ip_account_id = $3 where id = $1 and workspace_id = $2`, [sessionId, job.workspace_id, account]);
    }
  }
  await erase();
  const sessions = (
    await pool.query(`select id from sessions where workspace_id = $1 and ip_net = $2::cidr and started_at > now() - interval '1 hour' and not internal`, [job.workspace_id, net])
  ).rows.map((r) => r.id as string);
  if (sessionId && !sessions.includes(sessionId)) sessions.push(sessionId);
  const c = await pool.connect();
  try {
    for (const a of await resolveSessions(c, job.workspace_id, sessions)) touched.add(a);
  } finally {
    c.release();
  }
  await scoreLater(pool, job.workspace_id, [...touched]);
};

/** Saves what a whole network is, from its IPs' lookups: a company when 3+ agree, "mixed" when any disagrees. */
async function saveNetVerdict(pool: pg.Pool, net: string) {
  const rows = (
    await pool.query(`select domain, kind, confidence from ip_cache where net = $1::cidr and scope = 'ip' and fetched_at > now() - interval '30 days'`, [net])
  ).rows as Pick<NetworkMatch, "domain" | "kind" | "confidence">[];
  const v = netVerdict(rows);
  const key = createHash("sha256").update(net).digest();
  if (v.state === "undecided") {
    await pool.query(`delete from ip_cache where key = $1 and scope = 'net'`, [key]);
    return;
  }
  const [domain, kind, confidence] = v.state === "agreed" ? [v.domain, v.kind, v.confidence] : [null, "mixed", 0];
  await pool.query(
    `insert into ip_cache (key, net, domain, kind, confidence, vendor, scope, fetched_at) values ($1, $2::cidr, $3, $4, $5, 'ipinfo', 'net', now())
     on conflict (key) do update set domain = excluded.domain, kind = excluded.kind, confidence = excluded.confidence, scope = 'net', fetched_at = now()`,
    [key, net, domain, kind, confidence],
  );
}

/** enrich_company: company data by domain (shared cache, 30 days), written to every account on that domain. */
export const enrichCompany = (pool: pg.Pool, deps: CompanyDeps): Handler => async (job) => {
  const clean = cleanDomain(String(job.payload.domain ?? job.key ?? ""));
  if (!clean) throw new JobError("enrich_company needs a domain", { retry: false });
  const domain = clean.domain;
  let row = (await pool.query(`select data from company_cache where domain = $1 and fetched_at > now() - interval '30 days'`, [domain])).rows[0];
  if (!row) {
    // A domain that redirects (acme.io → acme.com) is looked up by where it lands.
    const alias = clean.hosted ? null : await (deps.alias ?? ((d: string) => redirectAlias(d)))(domain).catch(() => null);
    if (alias) await pool.query(`insert into domain_aliases (domain, canonical) values ($1, $2) on conflict (domain) do update set canonical = excluded.canonical, checked_at = now()`, [domain, alias]);
    if (!deps.coresignalKey && !deps.enrich) return;
    let firmo;
    try {
      firmo = await (deps.enrich ?? enrichDomain)(alias ?? domain, { apiKey: deps.coresignalKey });
    } catch (e) {
      throw retry(e);
    }
    const data = firmo ?? { not_found: true };
    await pool.query(
      `insert into company_cache (domain, data, vendor, fetched_at) values ($1, $2, 'coresignal', now()) on conflict (domain) do update set data = excluded.data, fetched_at = now()`,
      [domain, JSON.stringify(data)],
    );
    row = { data };
  }
  const d = row.data as { not_found?: boolean; name?: string | null };
  if (d.not_found) return;
  await pool.query(`update accounts set name = coalesce($2, name), firmo = $3, firmo_at = now() where domain = $1`, [domain, d.name ?? null, JSON.stringify(d)]);
};

/** identity_changed: a person's visits get their account again (90 days), and changed accounts are rescored. */
export const identityChanged = (pool: pg.Pool): Handler => async (job) => {
  const person = String(job.payload.person_id ?? job.key ?? "");
  if (!job.workspace_id || !/^[0-9a-f-]{36}$/.test(person)) throw new JobError("identity_changed needs a person", { retry: false });
  const sessions = (
    await pool.query(`select id from sessions where workspace_id = $1 and person_id = $2 and started_at > now() - interval '90 days'`, [job.workspace_id, person])
  ).rows.map((r) => r.id as string);
  const c = await pool.connect();
  try {
    await scoreLater(pool, job.workspace_id, await resolveSessions(c, job.workspace_id, sessions));
  } finally {
    c.release();
  }
};

export { accountForDomain };
