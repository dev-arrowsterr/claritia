// Accounts from work emails and networks, IP lookups and company data, on a real database.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import pg from "pg";
import { uuid7 } from "../../collect/ids.ts";
import { PgStore, type SessionRow } from "../../collect/store.ts";
import { accountForDomain } from "../../src/lib/company/accounts.ts";
import type { Job } from "../../src/lib/jobs.ts";
import { stitchDevice } from "../../src/lib/identity/stitch.ts";
import { enrichCompany, identityChanged, ipLookup } from "../../worker-intel/jobs/company.ts";

const url = process.env.PG_URL;
if (!url) throw new Error("PG_URL is not set");
const pool = new pg.Pool({ connectionString: url, max: 4 });
const store = new PgStore(url, 2);
const q = async (sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows;
after(async () => {
  await pool.end();
  await store.pool.end();
});
const settings = { own_domains: [], partner_domains: [], secrets: [] };
const job = (ws: string, kind: string, payload: Record<string, unknown>): Job => ({ id: uuid7(), workspace_id: ws, kind, key: "", payload, attempts: 1, max_attempts: 3 });

async function workspace() {
  const ws = uuid7();
  await q(`insert into workspaces (id, name) values ($1, 'accounts test')`, [ws]);
  const site = (await q(`insert into sites (workspace_id, domain) values ($1, $2) returning id`, [ws, `acc-${ws.slice(-8)}.com`]))[0].id;
  return { ws, site };
}
const session = (ws: string, site: string, device: string, net: string | null): SessionRow => ({
  id: uuid7(), workspace_id: ws, site_id: site, device_id: device, cookieless_key: null, started_at: new Date(), ended_at: new Date(), policy: "notice",
  consent: "unknown", gpc: false, country: "US", region: null, city: null, device_type: "desktop", browser: "Chrome", os: "macOS", landing_path: "/",
  referrer_host: null, source: null, medium: null, campaign: null, term: null, content: null, ref_class: "direct", ip_net: net, ip_kind: "direct", is_bot: false,
});

test("a domain makes one account, queued for company data; aliases point to it", async () => {
  const { ws } = await workspace();
  const a = await accountForDomain(pool, ws, "https://www.Acme-Corp.com/pricing");
  const b = await accountForDomain(pool, ws, "app.acme-corp.com");
  assert.ok(a && a === b);
  assert.equal((await q(`select count(*)::int n from jobs where workspace_id = $1 and kind = 'enrich_company' and key = 'acme-corp.com'`, [ws]))[0].n, 1);
  await q(`insert into domain_aliases (domain, canonical) values ('acmecorp.io', 'acme-corp.com') on conflict do nothing`);
  assert.equal(await accountForDomain(pool, ws, "acmecorp.io"), a, "an alias lands on the same account");
  assert.equal(await accountForDomain(pool, ws, "localhost"), null);
});

test("a person's work email sets the account on their visits; free mail doesn't", async () => {
  const { ws, site } = await workspace();
  const devs = [uuid7(), uuid7()];
  const emails = ["kim@globex-test.com", "kim.home@gmail.com"];
  const sessions: string[] = [];
  for (const [i, d] of devs.entries()) {
    await q(`insert into devices (id, workspace_id, site_id) values ($1, $2, $3)`, [d, ws, site]);
    const s = session(ws, site, d, null);
    await store.startSession(s, null);
    sessions.push(s.id);
    await q(`insert into identity_evidence (id, workspace_id, site_id, device_id, session_id, source, level, identifiers) values ($1, $2, $3, $4, $5, 'form', 'asserted', $6)`, [
      uuid7(), ws, site, d, s.id, JSON.stringify([{ kind: "email", value: emails[i] }]),
    ]);
    await stitchDevice(pool, ws, d, settings);
  }
  const people = await q(`select payload->>'person_id' as p from jobs where workspace_id = $1 and kind = 'identity_changed'`, [ws]);
  assert.equal(people.length, 2, "stitch queues identity_changed");
  for (const p of people) await identityChanged(pool)(job(ws, "identity_changed", { person_id: p.p }), new AbortController().signal);
  const [work] = await q(`select s.account_id, s.account_source, a.domain from sessions s join accounts a on a.id = s.account_id where s.id = $1`, [sessions[0]]);
  assert.deepEqual([work?.domain, work?.account_source], ["globex-test.com", "email"]);
  assert.equal((await q(`select account_id from sessions where id = $1`, [sessions[1]]))[0].account_id, null, "free mail makes no account");
  assert.ok((await q(`select count(*)::int n from jobs where workspace_id = $1 and kind = 'score_account'`, [ws]))[0].n >= 1, "the account is queued for scoring");

  // A new visit on that device starts with the person and the account.
  const next = session(ws, site, devs[0], null);
  await store.startSession(next, { id: devs[0], consent: "unknown" });
  const [n] = await q(`select person_id, person_source, account_id, account_source from sessions where id = $1`, [next.id]);
  assert.ok(n.person_id && n.person_source === "live" && n.account_id === work.account_id && n.account_source === "email");
});

test("ip_lookup: a business network sets the network account; a broadband one doesn't; lookups are cached", async () => {
  const { ws, site } = await workspace();
  const d = uuid7();
  await q(`insert into devices (id, workspace_id, site_id) values ($1, $2, $3)`, [d, ws, site]);
  const net = `198.18.${Math.floor(Math.random() * 250)}.0/24`;
  const s = session(ws, site, d, net);
  await store.startSession(s, null);
  let calls = 0;
  const deps = { ipinfoToken: "t", ipinfoCompany: true, lookup: async () => (calls++, { domain: "initech-test.com", name: "Initech", kind: "business" as const, confidence: 90, asnDomain: "initech-test.com" }) };
  await ipLookup(pool, deps)(job(ws, "ip_lookup", { net }), new AbortController().signal);
  await ipLookup(pool, deps)(job(ws, "ip_lookup", { net }), new AbortController().signal);
  assert.equal(calls, 1, "the second lookup comes from the cache");
  const [r] = await q(`select s.account_source, a.domain, s.network_account_id = s.account_id as same from sessions s join accounts a on a.id = s.account_id where s.id = $1`, [s.id]);
  assert.deepEqual([r?.domain, r?.account_source, r?.same], ["initech-test.com", "vendor_network", true]);
  // The next visit from that network gets the account at the start.
  const next = session(ws, site, d, net);
  await store.startSession(next, null);
  assert.equal((await q(`select account_source from sessions where id = $1`, [next.id]))[0].account_source, "vendor_network");

  const isp = `198.19.${Math.floor(Math.random() * 250)}.0/24`;
  const s2 = session(ws, site, d, isp);
  await store.startSession(s2, null);
  await ipLookup(pool, { ipinfoToken: "t", lookup: async () => ({ domain: "acme-home.com", name: "Acme", kind: "isp" as const, confidence: 60, asnDomain: "comcast.net" }) })(job(ws, "ip_lookup", { net: isp }), new AbortController().signal);
  assert.equal((await q(`select account_id from sessions where id = $1`, [s2.id]))[0].account_id, null, "an ISP network sets nothing");
});

test("enrich_company: company data lands on accounts, from the cache the second time; redirects become aliases", async () => {
  const { ws } = await workspace();
  const domain = `umbrella-${uuid7().slice(-6)}.com`;
  const acc = await accountForDomain(pool, ws, domain);
  let calls = 0;
  const deps = {
    enrich: async (d: string) => (calls++, { name: `Umbrella (${d})`, employees: 300, size: "201-500", industry: "Pharma", country: "US", founded: 1990, type: "Public" }),
    alias: async () => `umbrella-group-${domain}`,
  };
  await enrichCompany(pool, deps)(job(ws, "enrich_company", { domain }), new AbortController().signal);
  await enrichCompany(pool, deps)(job(ws, "enrich_company", { domain }), new AbortController().signal);
  assert.equal(calls, 1);
  const [a] = await q(`select name, firmo from accounts where id = $1`, [acc]);
  assert.equal(a.firmo.employees, 300);
  assert.match(a.name, /^Umbrella \(umbrella-group-/, "looked up by where the domain lands");
  assert.equal((await q(`select canonical from domain_aliases where domain = $1`, [domain]))[0].canonical, `umbrella-group-${domain}`);
  const missing = `nobody-${uuid7().slice(-6)}.com`;
  await accountForDomain(pool, ws, missing);
  await enrichCompany(pool, { enrich: async () => null, alias: async () => null })(job(ws, "enrich_company", { domain: missing }), new AbortController().signal);
  assert.deepEqual((await q(`select data from company_cache where domain = $1`, [missing]))[0].data, { not_found: true });
});
