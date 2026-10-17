// Lead scoring and routing on a real database: fit from the ideal customer and the person, engagement that fades,
// probable visits that never count, MQL and owner on crossing the threshold, turns between owners, and owners kept.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import pg from "pg";
import { uuid7 } from "../../collect/ids.ts";
import { fitV0, type Icp } from "../../src/lib/web/scores.ts";

const url = process.env.PG_URL;
if (!url) throw new Error("PG_URL is not set");
const pool = new pg.Pool({ connectionString: url, max: 4 });
const q = async (sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows;
after(() => pool.end());

let ws = "";
let owner = "";
let rep1 = "";
let rep2 = "";
let site = "";
const c: Record<string, string> = {};
const as = async (sql: string, params: unknown[]) => {
  const k = await pool.connect();
  try {
    await k.query(`select set_config('request.jwt.claim.sub', $1, false)`, [owner]);
    await k.query("set role authenticated");
    return (await k.query(sql, params)).rows[0];
  } finally {
    await k.query("reset role");
    await k.query(`select set_config('request.jwt.claim.sub', '', false)`);
    k.release();
  }
};
const row = async (name: string) => (await q(`select score, fit_score, engagement_score, score_band, lifecycle, owner_user_id, owner_crm_id, qualified_at, score_reasons from contacts where id = $1`, [c[name]]))[0];
const ICP: Icp = { industries: { values: ["Software"], weight: 2 }, sizes: { values: ["51-200"], weight: 1 }, countries: { values: ["US"], weight: 1, required: true } };

before(async () => {
  ws = uuid7();
  owner = uuid7();
  rep1 = uuid7();
  rep2 = uuid7();
  await q(`insert into workspaces (id, name) values ($1, 'scoring')`, [ws]);
  for (const [u, role] of [[owner, "owner"], [rep1, "member"], [rep2, "member"]]) {
    await q(`insert into auth.users (id, email) values ($1, $2)`, [u, `${u}@t.io`]);
    await q(`insert into workspace_members (workspace_id, user_id, role) values ($1, $2, $3)`, [ws, u, role]);
  }
  await q(`insert into icp (workspace_id, rules) values ($1, $2)`, [ws, JSON.stringify(ICP)]);
  site = (await q(`insert into sites (workspace_id, domain) values ($1, $2) returning id`, [ws, `s${ws.slice(-8)}.com`]))[0].id;
  const good = (await q(`insert into companies (workspace_id, domain, name, industry, size, country) values ($1, $2, 'Good', 'Software', '51-200', 'US') returning id`, [ws, `good${ws.slice(-6)}.com`]))[0].id;
  const poor = (await q(`insert into companies (workspace_id, domain, name, industry, size, country) values ($1, $2, 'Poor', 'Retail', '1-10', 'DE') returning id`, [ws, `poor${ws.slice(-6)}.com`]))[0].id;
  const people: [string, string, string, string][] = [
    ["hot1", good, "work", "VP Marketing"],
    ["hot2", good, "work", "Head of Growth"],
    ["owned", good, "work", "CMO"],
    ["cold", poor, "free", "Student"],
    ["visitor", good, "work", "Engineer"],
  ];
  for (const [n, co, cls, title] of people) {
    c[n] = (await q(`insert into contacts (workspace_id, email, email_clean, email_class, title, company_id, country, lifecycle, person_id) values ($1, $2, $2, $3, $4, $5, 'US', 'lead', $6) returning id`, [ws, `${n}-${ws.slice(-6)}@x.com`, cls, title, co, uuid7()]))[0].id;
  }
  await q(`update contacts set owner_crm_id = 'crm-rep-9' where id = $1`, [c.owned]);
  const ev = (n: string, kind: string, daysAgo = 1) => q(`insert into contact_events (workspace_id, contact_id, kind, data, source, at) values ($1, $2, $3, '{}', 'test', now() - make_interval(days => $4))`, [ws, c[n], kind, daysAgo]);
  for (const n of ["hot1", "hot2", "owned"]) {
    await ev(n, "form.submitted");
    await ev(n, "meeting.booked");
    await ev(n, "email.clicked");
  }
  await ev("cold", "form.submitted", 80);
  await ev("cold", "email.unsubscribed");
});

test("the SQL fit matches the TypeScript one", async () => {
  const cases: [string | null, string | null, string | null][] = [["Software", "51-200", "US"], ["Software", "1-10", "US"], ["Retail", "51-200", "DE"], [null, null, null], ["software", "51-200", "US"]];
  for (const [industry, size, country] of cases) {
    const sql = (await q(`select icp_fit($1, $2, $3, $4) as f`, [JSON.stringify(ICP), industry, size, country]))[0].f;
    assert.equal(sql, fitV0({ industry, size, country }, ICP), `${industry}/${size}/${country}`);
  }
  assert.equal((await q(`select icp_fit('{}', 'Software', null, null) as f`))[0].f, null);
});

test("nothing scores until scoring is on; then fit and engagement add up", async () => {
  assert.deepEqual((await q(`select lead_scores_refresh($1, 100) as r`, [ws]))[0].r, { scored: 0, routed: 0 });
  await as(`select lead_settings_save($1, $2)`, [ws, JSON.stringify({ enabled: true, threshold: 70, titles: ["marketing", "growth", "cmo"], routing: { respect_owner: true, rules: [{ name: "US", countries: ["US"], industries: [], sizes: [], owners: [{ user_id: rep1, label: "Rep 1" }, { user_id: rep2, label: "Rep 2" }] }], default: { owners: [] } } })]);
  const r = (await q(`select lead_scores_refresh($1, 100) as r`, [ws]))[0].r;
  assert.equal(r.scored, 5);
  const hot = await row("hot1");
  assert.equal(hot.fit_score, 100, "Software, 51-200, US, work email, title match");
  assert.ok(hot.engagement_score >= 70, `engagement ${hot.engagement_score}`);
  assert.equal(hot.score_band, "hot");
  assert.deepEqual(hot.score_reasons.activity, { "form.submitted": 1, "meeting.booked": 1, "email.clicked": 1 });
  const cold = await row("cold");
  assert.equal(cold.engagement_score, 0, "an old form and an unsubscribe don't go below zero");
  assert.ok(cold.fit_score <= 30, `poor fit ${cold.fit_score}`);
  assert.equal(cold.score_band, "cold");
});

test("crossing the threshold makes an MQL with an owner, taking turns; an owner already set is kept", async () => {
  const h1 = await row("hot1");
  const h2 = await row("hot2");
  assert.equal(h1.lifecycle, "mql");
  assert.equal(h2.lifecycle, "mql");
  assert.ok(h1.qualified_at && h2.qualified_at);
  assert.deepEqual([h1.owner_user_id, h2.owner_user_id].sort(), [rep1, rep2].sort(), "one each");
  const owned = await row("owned");
  assert.equal(owned.owner_user_id, null);
  assert.equal(owned.owner_crm_id, "crm-rep-9", "the CRM's owner stays");
  assert.equal(owned.lifecycle, "mql");
  const events = await q(`select data->>'rule' rule from contact_events where workspace_id = $1 and kind = 'lead.qualified' order by contact_id`, [ws]);
  assert.equal(events.length, 3);
  assert.ok(events.some((e) => e.rule === "kept_owner"));
  // Scoring again routes nobody twice.
  await q(`update contacts set scored_at = null where workspace_id = $1`, [ws]);
  assert.equal((await q(`select lead_scores_refresh($1, 100) as r`, [ws]))[0].r.routed, 0);
  assert.equal((await q(`select count(*)::int n from contact_events where workspace_id = $1 and kind = 'lead.qualified'`, [ws]))[0].n, 3);
});

test("visits count only when the link to the person is verified or asserted", async () => {
  const pid = (await q(`select person_id from contacts where id = $1`, [c.visitor]))[0].person_id;
  const before = (await row("visitor")).engagement_score;
  const session = (level: string, path: string) =>
    q(
      `insert into sessions (id, workspace_id, site_id, cookieless_key, started_at, ended_at, policy, landing_path, person_id, person_level, pageviews)
       values ($1, $2, $3, '\\x01', now() - interval '1 hour', now(), 'cookieless', $4, $5, $6, 3)`,
      [uuid7(), ws, site, path, pid, level],
    );
  for (let i = 0; i < 4; i++) await session("probable", "/pricing");
  await q(`update contacts set scored_at = now() - interval '2 hours' where id = $1`, [c.visitor]);
  await q(`select lead_scores_refresh($1, 100)`, [ws]);
  assert.equal((await row("visitor")).engagement_score, before, "probable visits add nothing");
  await session("verified", "/pricing");
  await session("asserted", "/blog");
  await q(`update contacts set scored_at = now() - interval '2 hours' where id = $1`, [c.visitor]);
  await q(`select lead_scores_refresh($1, 100)`, [ws]);
  const after = await row("visitor");
  assert.ok(after.engagement_score >= before + 17, `pricing 15 + visit 3, faded a little: ${before} → ${after.engagement_score}`);
  assert.deepEqual(after.score_reasons.activity, { "visit.pricing": 1, visit: 1 });
});

test("only the owner changes scoring; owners must be teammates", async () => {
  const k = await pool.connect();
  try {
    await k.query(`select set_config('request.jwt.claim.sub', $1, false)`, [rep1]);
    await k.query("set role authenticated");
    await assert.rejects(k.query(`select lead_settings_save($1, '{"threshold": 5}')`, [ws]), /Only the workspace owner/);
    await assert.rejects(k.query(`select lead_rescore_now($1)`, [ws]), /Only the workspace owner/);
  } finally {
    await k.query("reset role");
    await k.query(`select set_config('request.jwt.claim.sub', '', false)`);
    k.release();
  }
  await assert.rejects(as(`select lead_settings_save($1, $2)`, [ws, JSON.stringify({ routing: { rules: [{ owners: [{ user_id: uuid7() }] }], default: { owners: [] } } })]), /pick a teammate/);
  await assert.rejects(as(`select lead_settings_save($1, $2)`, [ws, JSON.stringify({ weights: { "form.submitted": 500 } })]), /Weights are numbers/);
});
