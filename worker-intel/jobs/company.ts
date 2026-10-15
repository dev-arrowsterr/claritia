// Account jobs (docs/m1-website-intelligence.md Part 6): ip_lookup, enrich_company, identity_changed.

import { createHash } from "node:crypto";
import type pg from "pg";
import { accountForDomain, resolveSessions } from "../../src/lib/company/accounts.ts";
import { enrichDomain } from "../../src/lib/company/coresignal.ts";
import { cleanDomain, redirectAlias } from "../../src/lib/company/domains.ts";
import { lookupNetwork, type NetworkMatch } from "../../src/lib/company/ipinfo.ts";
import { JobError, type Handler } from "../../src/lib/jobs.ts";

export type CompanyDeps = {
  ipinfoToken?: string;
  ipinfoCompany?: boolean;
  coresignalKey?: string;
  lookup?: typeof lookupNetwork;
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

/** ip_lookup: who owns a network (cached 30 days, shared), then the account on that network's recent visits. */
export const ipLookup = (pool: pg.Pool, deps: CompanyDeps): Handler => async (job) => {
  const net = String(job.payload.net ?? job.key ?? "");
  if (!job.workspace_id || !/^[0-9a-f.:]+\/\d+$/i.test(net)) throw new JobError("ip_lookup needs a network", { retry: false });
  const cached = (await pool.query(`select 1 from ip_cache where net = $1::cidr and fetched_at > now() - interval '30 days' limit 1`, [net])).rows[0];
  if (!cached && deps.ipinfoToken) {
    let m: NetworkMatch | null;
    try {
      m = await (deps.lookup ?? lookupNetwork)(net, { token: deps.ipinfoToken, company: !!deps.ipinfoCompany });
    } catch (e) {
      throw retry(e);
    }
    await pool.query(
      `insert into ip_cache (key, net, domain, kind, confidence, vendor, fetched_at) values ($1, $2::cidr, $3, $4, $5, 'ipinfo', now())
       on conflict (key) do update set domain = excluded.domain, kind = excluded.kind, confidence = excluded.confidence, fetched_at = now()`,
      [createHash("sha256").update(net).digest(), net, m?.domain ?? null, m?.kind ?? "unknown", m?.confidence ?? 0],
    );
  }
  const sessions = (
    await pool.query(`select id from sessions where workspace_id = $1 and ip_net = $2::cidr and started_at > now() - interval '1 hour' and not internal`, [job.workspace_id, net])
  ).rows.map((r) => r.id as string);
  const c = await pool.connect();
  try {
    await scoreLater(pool, job.workspace_id, await resolveSessions(c, job.workspace_id, sessions));
  } finally {
    c.release();
  }
};

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
