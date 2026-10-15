// The screens' read functions return the fields the screens use (src/components/app/views).
import assert from "node:assert/strict";
import { after, test } from "node:test";
import pg from "pg";
import { uuid7 } from "../../collect/ids.ts";
import { accountForDomain } from "../../src/lib/company/accounts.ts";

const url = process.env.PG_URL;
if (!url) throw new Error("PG_URL is not set");
const pool = new pg.Pool({ connectionString: url, max: 2 });
const q = async (sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows;
after(() => pool.end());

test("visitors, accounts, account page, timeline and site health", async () => {
  const ws = uuid7();
  const user = uuid7();
  await q(`insert into workspaces (id, name) values ($1, 'screens test')`, [ws]);
  await q(`insert into auth.users (id, email) values ($1, $2)`, [user, `${user}@t.io`]);
  await q(`insert into workspace_members (workspace_id, user_id, role) values ($1, $2, 'owner')`, [ws, user]);
  const site = (await q(`insert into sites (workspace_id, domain) values ($1, $2) returning id`, [ws, `scr-${ws.slice(-8)}.com`]))[0].id;
  const acc = (await accountForDomain(pool, ws, `wayne-${ws.slice(-6)}.com`))!;
  await q(`update accounts set name = 'Wayne', fit = 80, intent = 55, priority = 44.0, stage = 'researching', temperature = 'hot', why_now = 'This week: read pricing.', firmo = '{"industry":"Steel","employees":900,"size":"501-1,000","country":"US"}', firmo_at = now(), last_signal_at = now() where id = $1`, [acc]);
  const person = uuid7();
  await q(`insert into persons (id, workspace_id, primary_email) values ($1, $2, 'bruce@wayne.com')`, [person, ws]);
  const s = uuid7();
  await q(`insert into sessions (id, workspace_id, site_id, started_at, ended_at, policy, cookieless_key, account_id, account_source, person_id, person_level, pageviews, engaged_s, ref_class, referrer_host, country)
           values ($1, $2, $3, now() - interval '10 minutes', now(), 'notice', '\\x01', $4, 'email', $5, 'asserted', 4, 95, 'search', 'google.com', 'US')`, [s, ws, site, acc, person]);
  for (const [i, p] of ["/", "/pricing", "/security", "/docs/a"].entries())
    await q(`insert into events (id, workspace_id, session_id, day, kind, path, server_at) values ($1, $2, $3, current_date, 'view', $4, now() - make_interval(secs => $5))`, [uuid7(), ws, s, p, 60 - i * 10]);
  await q(`insert into signals (workspace_id, account_id, person_id, kind, weight, at, dedupe_key, evidence) values ($1, $2, $3, 'page_pricing', 10, now(), $4, $5)`, [ws, acc, person, `k-${s}`, JSON.stringify({ session_id: s })]);

  const c = await pool.connect();
  try {
    await c.query(`select set_config('request.jwt.claim.sub', $1, false)`, [user]);
    const rpc = async (fn: string, args: unknown[]) => (await c.query(`select ${fn}(${args.map((_, i) => `$${i + 1}`).join(", ")}) as r`, args)).rows[0].r;

    const [v] = await rpc("visitors_live", [ws, 24, 100]);
    for (const k of ["id", "device_id", "started_at", "account_id", "account_name", "account_domain", "account_source", "person_email", "person_level", "pageviews", "engaged_s", "pages", "page_times", "ref_class", "referrer_host", "country"]) assert.ok(k in v, `visitors_live.${k}`);
    assert.deepEqual(v.pages, ["/", "/pricing", "/security", "/docs/a"]);
    assert.equal(v.page_times.length, 4);

    for (const view of ["all", "hot", "evaluating", "new", "fit_quiet"]) await rpc("accounts_list", [ws, view, 50]);
    const [a] = await rpc("accounts_list", [ws, "hot", 50]);
    for (const k of ["id", "name", "domain", "fit", "intent", "priority", "stage", "temperature", "why_now", "last_signal_at", "industry", "size", "country", "people", "sessions_7d", "feedback"]) assert.ok(k in a, `accounts_list.${k}`);
    assert.deepEqual([a.name, a.people, a.sessions_7d], ["Wayne", 1, 1]);

    const d = await rpc("account_detail", [acc]);
    assert.equal(d.account.name, "Wayne");
    assert.ok(!("workspace_id" in d.account));
    assert.deepEqual(d.people.map((p: { email: string }) => p.email), ["bruce@wayne.com"]);
    assert.equal(d.signals[0].kind, "page_pricing");
    assert.deepEqual(Object.keys(d.unknown).sort(), ["devices", "sessions"]);

    const [t] = await rpc("account_timeline", [acc, 50]);
    assert.equal(t.events.length, 4);
    assert.deepEqual(t.signals, ["page_pricing"]);

    const [h] = await rpc("site_health", [ws]);
    for (const k of ["domain", "site_key", "proxy_secret", "install_mode", "last_event_at", "paused", "sessions_24h", "identified_24h", "with_account_24h"]) assert.ok(k in h, `site_health.${k}`);
    assert.equal(h.sessions_24h, 1);

    await rpc("set_icp", [ws, JSON.stringify({ industries: { values: ["Steel"], weight: 50 } })]);
    assert.equal((await q(`select count(*)::int n from jobs where workspace_id = $1 and kind = 'score_account'`, [ws]))[0].n, 1, "every account is rescored");
  } finally {
    await c.query(`select set_config('request.jwt.claim.sub', '', false)`);
    c.release();
  }
});
