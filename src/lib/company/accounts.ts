// Accounts (docs/identity.md Part 8, docs/account-intelligence.md 5.2): a company per domain per workspace. A
// session's account comes from, in order: the person's work email, a network the workspace learned, the IP vendor's
// match on the visit's own IP, then the vendor's match on its whole network (only when 3 IPs in it agree, see
// netVerdict). The person's account wins; the network's is kept beside it.

import type { Db } from "../identity/stitch.ts";
import { cleanDomain } from "./domains.ts";
import { ACCOUNT_KINDS, MIN_CONFIDENCE } from "./ipinfo.ts";

export { ACCOUNT_KINDS };

/** The account for a domain in this workspace, made if it's new (and then queued for enrichment). */
export async function accountForDomain(db: Db, ws: string, raw: string): Promise<string | null> {
  const clean = cleanDomain(raw);
  if (!clean) return null;
  const alias = (await db.query(`select canonical from domain_aliases where domain = $1`, [clean.domain])).rows[0]?.canonical as string | undefined;
  const domain = alias ?? clean.domain;
  const known = (await db.query(`select account_id from account_domains where workspace_id = $1 and domain = $2`, [ws, domain])).rows[0];
  if (known) return known.account_id;
  const made = await db.query(
    `insert into accounts (workspace_id, domain) values ($1, $2) on conflict (workspace_id, domain) do update set domain = excluded.domain returning id, (xmax = 0) as fresh`,
    [ws, domain],
  );
  const id = made.rows[0].id as string;
  await db.query(`insert into account_domains (workspace_id, domain, account_id, source) values ($1, $2, $3, 'primary') on conflict do nothing`, [ws, domain, id]);
  if (alias) await db.query(`insert into account_domains (workspace_id, domain, account_id, source) values ($1, $2, $3, 'alias') on conflict do nothing`, [ws, clean.domain, id]);
  if (made.rows[0].fresh) await db.query(`select enqueue_job($1, 'enrich_company', $2, $3)`, [ws, domain, JSON.stringify({ domain })]);
  return id;
}

/** The account a person's work email points to, or null for free mail, role inboxes, partners and own domains. */
export async function accountForPerson(db: Db, ws: string, person: string): Promise<string | null> {
  const r = await db.query(
    `select domain from identifiers where workspace_id = $1 and person_id = $2 and kind = 'email' and class = 'work' order by created_at limit 1`,
    [ws, person],
  );
  return r.rows[0] ? accountForDomain(db, ws, r.rows[0].domain) : null;
}

/** The network's account: learned from the workspace's own people first, then the IP vendor's business match. */
export async function accountForNetwork(db: Db, ws: string, net: string): Promise<{ account: string; source: "learned_network" | "vendor_network" } | null> {
  const learned = (await db.query(`select account_id from learned_networks where workspace_id = $1 and net = $2::cidr and account_id is not null`, [ws, net])).rows[0];
  if (learned) return { account: learned.account_id, source: "learned_network" };
  if (await flagged(db, ws, net)) return null;
  const hit = (
    await db.query(
      `select domain, kind, confidence from ip_cache where net = $1::cidr and scope = 'net' and fetched_at > now() - interval '30 days' order by fetched_at desc limit 1`,
      [net],
    )
  ).rows[0];
  if (!hit?.domain || !ACCOUNT_KINDS.includes(hit.kind) || (hit.confidence ?? 0) < MIN_CONFIDENCE) return null;
  const account = await accountForDomain(db, ws, hit.domain);
  return account ? { account, source: "vendor_network" } : null;
}

async function flagged(db: Db, ws: string, net: string | null) {
  if (!net) return false;
  return !!(await db.query(`select 1 from network_flags where workspace_id = $1 and net = $2::cidr and flag in ('shared', 'ignore')`, [ws, net])).rows[0];
}

/**
 * Sets account fields on sessions: by the person when there is one, else by the network. Returns the accounts that
 * changed, for scoring.
 */
export async function resolveSessions(db: Db, ws: string, sessionIds: string[]): Promise<string[]> {
  if (!sessionIds.length) return [];
  const rows = (
    await db.query(
      `select id, person_id, ip_net::text as net, ip_account_id, account_id, account_source, internal, is_bot from sessions where workspace_id = $1 and id = any($2)`,
      [ws, sessionIds],
    )
  ).rows;
  const touched = new Set<string>();
  const people = new Map<string, string | null>();
  const nets = new Map<string, Awaited<ReturnType<typeof accountForNetwork>>>();
  for (const s of rows) {
    if (s.internal) continue;
    let personAccount: string | null = null;
    if (s.person_id) {
      if (!people.has(s.person_id)) people.set(s.person_id, await accountForPerson(db, ws, s.person_id));
      personAccount = people.get(s.person_id) ?? null;
    }
    let network: Awaited<ReturnType<typeof accountForNetwork>> = null;
    if (s.net) {
      if (!nets.has(s.net)) nets.set(s.net, await accountForNetwork(db, ws, s.net));
      network = nets.get(s.net) ?? null;
    }
    // The visit's own IP beats its network's vendor match; the workspace's learned network still wins, and a network
    // flagged shared or ignore (a coworking space, a VPN exit) sets nothing.
    if (s.ip_account_id && network?.source !== "learned_network" && !(await flagged(db, ws, s.net))) network = { account: s.ip_account_id, source: "vendor_network" };
    const account = personAccount ?? network?.account ?? null;
    const source = personAccount ? "email" : (network?.source ?? null);
    if (account === s.account_id && source === s.account_source) continue;
    await db.query(`update sessions set account_id = $2, account_source = $3, network_account_id = $4 where id = $1`, [s.id, account, source, network?.account ?? null]);
    if (s.account_id) touched.add(s.account_id);
    if (account) touched.add(account);
  }
  return [...touched];
}
