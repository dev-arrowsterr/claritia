// Account alerts: a hot account fires one Slack message per rule per day.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import pg from "pg";
import { uuid7 } from "../../collect/ids.ts";
import { accountForDomain } from "../../src/lib/company/accounts.ts";
import type { Job } from "../../src/lib/jobs.ts";
import { seal } from "../../src/lib/seal.ts";
import { accountAlert, scoreAccount } from "../../worker-intel/jobs/signals.ts";

process.env.SECRETS_KEY = "alerts-test-secrets-key-0123456789abcdef";
const url = process.env.PG_URL;
if (!url) throw new Error("PG_URL is not set");
const pool = new pg.Pool({ connectionString: url, max: 2 });
const q = async (sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows;
after(() => pool.end());
const job = (ws: string, kind: string, payload: Record<string, unknown>): Job => ({ id: uuid7(), workspace_id: ws, kind, key: "", payload, attempts: 1, max_attempts: 3 });

test("turning hot queues one alert; it posts to Slack and logs; a second score the same day sends nothing", async () => {
  const ws = uuid7();
  await q(`insert into workspaces (id, name) values ($1, 'alerts test')`, [ws]);
  const acc = (await accountForDomain(pool, ws, `stark-${ws.slice(-6)}.com`))!;
  const rule = (await q(`insert into account_alert_rules (workspace_id, rule, channel, slack_sealed, slack_hint) values ($1, '{"when":"hot"}', 'slack', $2, 'abcd') returning id`, [ws, seal("https://hooks.slack.com/services/T0/B0/xyz")]))[0].id;
  const p1 = uuid7();
  const p2 = uuid7();
  for (const [i, p] of [p1, p2].entries()) {
    await q(`insert into signals (workspace_id, account_id, person_id, kind, weight, at, dedupe_key, evidence) values ($1, $2, $3, 'page_pricing', 30, now() - interval '1 hour', $4, '{}')`, [ws, acc, p, `a${i}-${acc}`]);
  }
  const score = scoreAccount(pool);
  await score(job(ws, "score_account", { account_id: acc }), new AbortController().signal);
  assert.equal((await q(`select temperature from accounts where id = $1`, [acc]))[0].temperature, "hot");
  const queued = await q(`select payload from jobs where workspace_id = $1 and kind = 'account_alert'`, [ws]);
  assert.equal(queued.length, 1);
  const sent: { url: string; body: string }[] = [];
  const fake = (async (u: string, init: RequestInit) => (sent.push({ url: u, body: String(init.body) }), new Response("ok"))) as unknown as typeof fetch;
  await accountAlert(pool, fake)(job(ws, "account_alert", queued[0].payload), new AbortController().signal);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, "https://hooks.slack.com/services/T0/B0/xyz");
  assert.match(sent[0].body, /is hot/);
  assert.equal((await q(`select count(*)::int n from account_alert_log where rule_id = $1`, [rule]))[0].n, 1);
  // Cool down and heat up again the same day: no second alert.
  await q(`update accounts set temperature = 'steady' where id = $1`, [acc]);
  await q(`delete from jobs where workspace_id = $1`, [ws]);
  await score(job(ws, "score_account", { account_id: acc }), new AbortController().signal);
  assert.equal((await q(`select count(*)::int n from jobs where workspace_id = $1 and kind = 'account_alert'`, [ws]))[0].n, 0);
});
