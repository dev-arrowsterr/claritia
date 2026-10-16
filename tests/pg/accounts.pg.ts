// Accounts from work emails and networks, IP lookups and company data, on a real database.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import pg from "pg";
import { uuid7 } from "../../collect/ids.ts";
import { PgStore, type SessionRow } from "../../collect/store.ts";
import { accountForDomain, resolveSessions } from "../../src/lib/company/accounts.ts";
import { ipKey, sealIp, type NetworkMatch } from "../../src/lib/company/ipinfo.ts";
import { ipNet } from "../../collect/geo.ts";
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

const SECRET = "x".repeat(40);
const lookups = (table: Record<string, NetworkMatch>) => {
  const seen: string[] = [];
  const lookup = async (ip: string) => (seen.push(ip), table[ip] ?? { domain: null, name: null, kind: "isp" as const, confidence: 0, asnDomain: "comcast.net" });
  return { seen, deps: { ipinfoToken: "t", ipinfoCompany: true, ipSecret: SECRET, lookup } };
};
const biz = (domain: string, confidence = 75): NetworkMatch => ({ domain, name: domain, kind: "business", confidence, asnDomain: "comcast.net" });
const block = () => `198.${18 + Math.floor(Math.random() * 2)}.${Math.floor(Math.random() * 250)}`;
/** A visit from one IP, then its ip_lookup job as collect queues it (a real job row, so erasing the IP can be checked). */
async function visit(ws: string, site: string, d: string, ip: string, deps: Parameters<typeof ipLookup>[1] | null) {
  const net = ipNet(ip)!;
  const s = session(ws, site, d, net);
  await store.startSession(s, null, ipKey(ip, SECRET));
  if (!deps) return s.id;
  const payload = { net, ip: sealIp(ip, SECRET), session_id: s.id };
  await q(`select enqueue_job($1, 'ip_lookup', $2, $3)`, [ws, ipKey(ip, SECRET).toString("base64url") + s.id, JSON.stringify(payload)]);
  const [row] = await q(`select id from jobs where workspace_id = $1 and kind = 'ip_lookup' and payload->>'session_id' = $2`, [ws, s.id]);
  await ipLookup(pool, deps)({ ...job(ws, "ip_lookup", payload), id: row.id }, new AbortController().signal);
  return s.id;
}
const accountOf = async (id: string) => (await q(`select a.domain, s.account_source from sessions s left join accounts a on a.id = s.account_id where s.id = $1`, [id]))[0];

test("ip_lookup: a shared broadband block tags only the IP that is the business, never its neighbors", async () => {
  const { ws, site } = await workspace();
  const d = uuid7();
  await q(`insert into devices (id, workspace_id, site_id) values ($1, $2, $3)`, [d, ws, site]);
  const b = block();
  // .1 and .10 are Initech's static IPs on a broadband block; .20 is someone at home.
  const { seen, deps } = lookups({ [`${b}.1`]: biz("initech-test.com"), [`${b}.10`]: biz("initech-test.com") });
  const office = await visit(ws, site, d, `${b}.10`, deps);
  const home = await visit(ws, site, d, `${b}.20`, deps);
  const gateway = await visit(ws, site, d, `${b}.1`, deps);
  assert.deepEqual(seen, [`${b}.10`, `${b}.20`, `${b}.1`], "each visitor's own IP is looked up");
  assert.deepEqual(await accountOf(office), { domain: "initech-test.com", account_source: "vendor_network" });
  assert.deepEqual(await accountOf(gateway), { domain: "initech-test.com", account_source: "vendor_network" });
  assert.deepEqual(await accountOf(home), { domain: null, account_source: null }, "the neighbor on a home line gets no company");
  assert.equal((await q(`select kind from ip_cache where net = $1::cidr and scope = 'net'`, [ipNet(`${b}.1`)]))[0]?.kind, "mixed");
  // A new visitor on that block, never looked up: no company at the start (the old stand-in lookup gave them Initech).
  const stranger = session(ws, site, d, ipNet(`${b}.30`));
  await store.startSession(stranger, null, ipKey(`${b}.30`, SECRET));
  assert.equal((await accountOf(stranger.id)).domain, null);
  // The office IP comes back later: its company is known from the cache at the start, with no new lookup.
  const back = session(ws, site, d, ipNet(`${b}.10`));
  await store.startSession(back, null, ipKey(`${b}.10`, SECRET));
  assert.equal((await accountOf(back.id)).domain, "initech-test.com");
  assert.equal(seen.length, 3);
  // Re-resolving a visit later (a person stitched, say) keeps the company from its own IP.
  const c = await pool.connect();
  try {
    await resolveSessions(c, ws, [office, home]);
  } finally {
    c.release();
  }
  assert.equal((await accountOf(office)).domain, "initech-test.com");
  assert.equal((await accountOf(home)).domain, null);
});

test("ip_lookup: a whole network gets a company only after 3 different IPs agree; then its other visits get it", async () => {
  const { ws, site } = await workspace();
  const d = uuid7();
  await q(`insert into devices (id, workspace_id, site_id) values ($1, $2, $3)`, [d, ws, site]);
  const b = block();
  const net = ipNet(`${b}.5`)!;
  const { deps } = lookups(Object.fromEntries([5, 6, 7].map((n) => [`${b}.${n}`, biz("hooli-test.com", 90)])));
  // A visit on the network whose IP isn't looked up (it came in before the secret was set, say).
  const early = session(ws, site, d, net);
  await store.startSession(early, null);
  await visit(ws, site, d, `${b}.5`, deps);
  await visit(ws, site, d, `${b}.6`, deps);
  assert.equal((await accountOf(early.id)).domain, null, "two agreeing IPs aren't enough for the whole network");
  await visit(ws, site, d, `${b}.7`, deps);
  assert.equal((await accountOf(early.id)).domain, "hooli-test.com", "the network's recent visits get the agreed company");
  const later = session(ws, site, d, net);
  await store.startSession(later, null);
  assert.equal((await accountOf(later.id)).domain, "hooli-test.com", "new visits on the network start with it");
  assert.ok((await q(`select count(*)::int n from jobs where workspace_id = $1 and kind = 'score_account'`, [ws]))[0].n >= 1, "the account is queued for scoring");
});

test("ip_lookup: no secret, a tampered IP or one from another network means no lookup and no company; the IP is erased from the job", async () => {
  const { ws, site } = await workspace();
  const d = uuid7();
  await q(`insert into devices (id, workspace_id, site_id) values ($1, $2, $3)`, [d, ws, site]);
  const b = block();
  const { seen, deps } = lookups({ [`${b}.9`]: biz("umbrella-test.com"), [`10.0.0.9`]: biz("umbrella-test.com") });
  const noSecret = await visit(ws, site, d, `${b}.9`, { ...deps, ipSecret: undefined });
  assert.equal(seen.length, 0);
  assert.equal((await accountOf(noSecret)).domain, null);
  // An IP that isn't on the visit's network (a bug or a forged job) is never looked up.
  const s = session(ws, site, d, ipNet(`${b}.9`));
  await store.startSession(s, null);
  await ipLookup(pool, deps)(job(ws, "ip_lookup", { net: ipNet(`${b}.9`), ip: sealIp("10.0.0.9", SECRET), session_id: s.id }), new AbortController().signal);
  await ipLookup(pool, deps)(job(ws, "ip_lookup", { net: ipNet(`${b}.9`), ip: "garbage", session_id: s.id }), new AbortController().signal);
  assert.equal(seen.length, 0);
  assert.equal((await accountOf(s.id)).domain, null);
  // After a real lookup, the job no longer holds the IP.
  await visit(ws, site, d, `${b}.9`, deps);
  assert.equal(seen.length, 1);
  assert.equal((await q(`select count(*)::int n from jobs where workspace_id = $1 and kind = 'ip_lookup' and payload ? 'ip'`, [ws]))[0].n, 0, "no job keeps the IP");
});

test("ip_lookup: rows from the old stand-in lookups and networks flagged shared set nothing", async () => {
  const { ws, site } = await workspace();
  const d = uuid7();
  await q(`insert into devices (id, workspace_id, site_id) values ($1, $2, $3)`, [d, ws, site]);
  const legacy = `${block()}.0/24`;
  await accountForDomain(pool, ws, "old-test.com"); // the account exists, so only the legacy scope can keep it off
  await q(`insert into ip_cache (key, net, domain, kind, confidence, vendor, scope) values (sha256($1::bytea), $2::cidr, 'old-test.com', 'business', 90, 'ipinfo', 'legacy')`, [Buffer.from(legacy), legacy]);
  const s = session(ws, site, d, legacy);
  await store.startSession(s, null);
  assert.equal((await accountOf(s.id)).domain, null, "a legacy row doesn't set an account");
  // A coworking space flagged shared: even its own IP's business match sets nothing.
  const b = block();
  await q(`insert into network_flags (workspace_id, net, flag) values ($1, $2::cidr, 'shared')`, [ws, ipNet(`${b}.4`)]);
  await accountForDomain(pool, ws, "wework-test.com");
  const { deps } = lookups({ [`${b}.4`]: biz("wework-test.com", 90) });
  const cowork = await visit(ws, site, d, `${b}.4`, deps);
  assert.equal((await accountOf(cowork)).domain, null);
  const again = session(ws, site, d, ipNet(`${b}.4`));
  await store.startSession(again, null, ipKey(`${b}.4`, SECRET));
  assert.equal((await accountOf(again.id)).domain, null, "not at the start either");
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
