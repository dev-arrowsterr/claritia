// The signals sweep and score_account on a real database.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import pg from "pg";
import { uuid7 } from "../../collect/ids.ts";
import { accountForDomain } from "../../src/lib/company/accounts.ts";
import type { Job } from "../../src/lib/jobs.ts";
import { scoreAccount, sweepSignals } from "../../worker-intel/jobs/signals.ts";

const url = process.env.PG_URL;
if (!url) throw new Error("PG_URL is not set");
const pool = new pg.Pool({ connectionString: url, max: 4 });
const q = async (sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows;
after(() => pool.end());

test("quiet visits with an account become signals once, and the account gets scored", async () => {
  const ws = uuid7();
  await q(`insert into workspaces (id, name) values ($1, 'signals test')`, [ws]);
  const site = (await q(`insert into sites (workspace_id, domain) values ($1, $2) returning id`, [ws, `sig-${ws.slice(-8)}.com`]))[0].id;
  const acc = (await accountForDomain(pool, ws, `hooli-${ws.slice(-6)}.com`))!;
  await q(`update accounts set firmo = '{"industry":"Software","size":"51-200","country":"US"}' where id = $1`, [acc]);
  await q(`insert into icp (workspace_id, rules) values ($1, '{"industries":{"values":["Software"],"weight":60},"countries":{"values":["US"],"weight":40}}')`, [ws]);
  const people = [uuid7(), uuid7()];
  for (const p of people) await q(`insert into persons (id, workspace_id) values ($1, $2)`, [p, ws]);
  const visits: string[] = [];
  for (const [i, p] of people.entries()) {
    const d = uuid7();
    await q(`insert into devices (id, workspace_id, site_id) values ($1, $2, $3)`, [d, ws, site]);
    const s = uuid7();
    const start = new Date(Date.now() - (30 - i) * 60_000);
    await q(
      `insert into sessions (id, workspace_id, site_id, device_id, started_at, ended_at, policy, person_id, person_level, account_id, account_source, ref_class)
       values ($1, $2, $3, $4, $5, $5::timestamptz + interval '5 minutes', 'notice', $6, 'asserted', $7, 'email', 'direct')`,
      [s, ws, site, d, start, p, acc],
    );
    for (const path of ["/pricing", "/security"]) {
      await q(`insert into events (id, workspace_id, session_id, day, kind, path, server_at) values ($1, $2, $3, current_date, 'view', $4, $5)`, [uuid7(), ws, s, path, start]);
    }
    visits.push(s);
  }
  // A bot visit on the same account makes nothing.
  const bot = uuid7();
  await q(`insert into sessions (id, workspace_id, site_id, started_at, ended_at, policy, cookieless_key, account_id, is_bot) values ($1, $2, $3, now() - interval '1 hour', now() - interval '50 minutes', 'cookieless', '\\x01', $4, true)`, [bot, ws, site, acc]);

  await sweepSignals(pool);
  const kinds = (await q(`select kind, count(*)::int n from signals where account_id = $1 group by kind order by kind`, [acc])).map((r) => `${r.kind}:${r.n}`);
  assert.deepEqual(kinds, ["new_person:2", "page_pricing:2", "page_security:1"], "security dedupes per account per day");
  assert.ok((await q(`select signaled_at from sessions where id = $1`, [visits[0]]))[0].signaled_at);
  await q(`update sessions set signaled_at = null where id = any($1)`, [visits]);
  await sweepSignals(pool);
  assert.equal((await q(`select count(*)::int n from signals where account_id = $1`, [acc]))[0].n, 5, "a second sweep adds nothing");
  assert.equal((await q(`select count(*)::int n from jobs where workspace_id = $1 and kind = 'score_account' and key = $2`, [ws, acc]))[0].n, 1);

  const job: Job = { id: uuid7(), workspace_id: ws, kind: "score_account", key: acc, payload: { account_id: acc }, attempts: 1, max_attempts: 3 };
  await scoreAccount(pool)(job, new AbortController().signal);
  const [a] = await q(`select fit, intent, stage, temperature, priority::float, why_now from accounts where id = $1`, [acc]);
  // Raw: pricing 10 + 10, security 9, new_person 6 + 6 = 41 (two people: cap 16.4 each, a = 10+9+6 = 25 → 16.4, b = 16 → 16;
  // breadth 1.15): (16.4 + 16) × 1.15 = 37.26. Intent = 100 × (1 − e^(−37.26/60)) = 46.
  assert.equal(a.fit, 100);
  assert.equal(a.intent, 46);
  assert.equal(a.stage, "evaluating", "pricing and security by two people");
  assert.equal(a.temperature, "hot");
  // 46 × (0.4 + 0.6) × 1.3 × 1.2 = 71.76
  assert.equal(a.priority, 71.8);
  assert.match(a.why_now, /^This week: 2 people read pricing/);
  assert.equal((await q(`select count(*)::int n from account_scores where account_id = $1`, [acc]))[0].n, 1);
});
