// claritia-intel's claim loop over Postgres: queued stitch jobs run once and finish.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import pg from "pg";
import { uuid7 } from "../../collect/ids.ts";
import { jobLoop } from "../../src/lib/jobs.ts";
import { deviceReset, stitch } from "../../worker-intel/jobs/stitch.ts";
import { pgRpc } from "../../worker-intel/rpc.ts";

const url = process.env.PG_URL;
if (!url) throw new Error("PG_URL is not set");
const pool = new pg.Pool({ connectionString: url, max: 8 });
const q = async (sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows;
after(() => pool.end());

test("stitch and device_reset jobs run through the queue", async () => {
  const ws = "66666666-6666-4666-8666-666666666666";
  await q(`insert into workspaces (id, name) values ($1, 'intel test') on conflict do nothing`, [ws]);
  const site = (await q(`insert into sites (workspace_id, domain) values ($1, 'intel-test.com') returning id`, [ws]))[0].id;
  const devices = Array.from({ length: 6 }, () => uuid7());
  for (const [i, d] of devices.entries()) {
    await q(`insert into devices (id, workspace_id, site_id) values ($1, $2, $3)`, [d, ws, site]);
    await q(`insert into sessions (id, workspace_id, site_id, device_id, started_at, ended_at, policy) values ($1, $2, $3, $4, now(), now(), 'notice')`, [uuid7(), ws, site, d]);
    await q(`insert into identity_evidence (id, workspace_id, site_id, device_id, source, level, identifiers) values ($1, $2, $3, $4, 'form', 'asserted', $5)`, [
      uuid7(), ws, site, d, JSON.stringify([{ kind: "email", value: `p${i % 2}@intel.io` }]),
    ]);
    await q(`select enqueue_job($1, 'stitch', $2, $3)`, [ws, d, JSON.stringify({ device_id: d })]);
    await q(`select enqueue_job($1, 'stitch', $2, $3)`, [ws, d, JSON.stringify({ device_id: d })]);
  }
  const rpc = pgRpc(pool);
  const stop = new AbortController();
  const handlers = { stitch: stitch(pool), device_reset: deviceReset(pool) };
  const loops = [1, 2, 3].map((i) => jobLoop({ rpc, worker: `test-${i}`, handlers, idleMs: 50, signal: stop.signal }));
  const end = Date.now() + 10_000;
  while (Date.now() < end && (await q(`select count(*)::int n from jobs where workspace_id = $1 and status <> 'done'`, [ws]))[0].n > 0) await new Promise((r) => setTimeout(r, 100));
  assert.equal((await q(`select count(*)::int n from jobs where workspace_id = $1 and status = 'done'`, [ws]))[0].n, 6, "one job per device, each done");
  assert.equal((await q(`select count(*)::int n from persons where workspace_id = $1`, [ws]))[0].n, 2);
  assert.equal((await q(`select count(*)::int n from device_links where workspace_id = $1 and to_at is null`, [ws]))[0].n, 6);

  await q(`select enqueue_job($1, 'device_reset', $2, $3)`, [ws, devices[0], JSON.stringify({ device_id: devices[0], at: new Date().toISOString() })]);
  const end2 = Date.now() + 5000;
  while (Date.now() < end2 && (await q(`select count(*)::int n from jobs where workspace_id = $1 and kind = 'device_reset' and status <> 'done'`, [ws]))[0].n > 0) await new Promise((r) => setTimeout(r, 100));
  assert.equal((await q(`select count(*)::int n from device_links where device_id = $1 and to_at is null`, [devices[0]]))[0].n, 0, "reset closes the link");
  stop.abort();
  await Promise.all(loops);
});
