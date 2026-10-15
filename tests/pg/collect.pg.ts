// collect's Postgres writes against a real database built from the migrations (run by scripts/test-db.sh).
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import { WriteBuffer } from "../../collect/buffer.ts";
import { uuid7 } from "../../collect/ids.ts";
import { PgStore, type EventRow, type SessionRow } from "../../collect/store.ts";

const url = process.env.PG_URL;
if (!url) throw new Error("PG_URL is not set");
const store = new PgStore(url, 4);
const q = (sql: string, p: unknown[] = []) => store.pool.query(sql, p);
const WS = "33333333-3333-4333-8333-333333333333";
let siteId = "";
const today = new Date().toISOString().slice(0, 10);

before(async () => {
  await q(`insert into workspaces (id, name) values ($1, 'collect test') on conflict do nothing`, [WS]);
  siteId = (await q(`insert into sites (workspace_id, domain) values ($1, 'collect-test.com') returning id`, [WS])).rows[0].id;
});
after(() => store.pool.end());

const session = (device: string | null): SessionRow => ({
  id: uuid7(),
  workspace_id: WS,
  site_id: siteId,
  device_id: device,
  cookieless_key: device ? null : randomBytes(16),
  started_at: new Date(),
  ended_at: new Date(),
  policy: "notice",
  consent: "unknown",
  gpc: false,
  country: "US",
  region: "NY",
  city: null,
  device_type: "desktop",
  browser: "Chrome",
  os: "macOS",
  landing_path: "/",
  referrer_host: null,
  source: null,
  medium: null,
  campaign: null,
  term: null,
  content: null,
  ref_class: "direct",
  ip_net: "203.0.113.0/24",
  ip_kind: "direct",
  is_bot: false,
});
const ev = (sessionId: string, kind: string, data: Record<string, unknown> | null = null, day = today): EventRow => ({
  id: uuid7(),
  workspace_id: WS,
  session_id: sessionId,
  day,
  kind,
  path: "/pricing",
  title: null,
  data,
  client_at: null,
});

test("site lookup by key", async () => {
  const key = (await q(`select site_key from sites where id = $1`, [siteId])).rows[0].site_key;
  const s = await store.siteByKey(key);
  assert.equal(s?.id, siteId);
  assert.deepEqual(s?.url_param_allow.slice(0, 2), ["utm_source", "utm_medium"]);
  assert.equal(await store.siteByKey("0".repeat(32)), null);
});

test("a session with its device, then events counted once even when sent twice", async () => {
  const device = uuid7();
  const s = session(device);
  await store.startSession(s, { id: device, consent: "unknown" });
  const rows = [ev(s.id, "view"), ev(s.id, "view"), ev(s.id, "engage", { active_s: 12, scroll: 50 }), ev(s.id, "click", { text: "x" })];
  await store.writeEvents(rows);
  await store.writeEvents(rows); // the retry of an unclear failure
  await store.writeEvents([rows[0], rows[0], ev(s.id, "view")]); // duplicates inside one write, plus one new
  const r = (await q(`select pageviews, engaged_s from sessions where id = $1`, [s.id])).rows[0];
  assert.deepEqual(r, { pageviews: 3, engaged_s: 12 });
  assert.equal((await q(`select count(*)::int as n from events where session_id = $1`, [s.id])).rows[0].n, 5);
  assert.equal((await q(`select sessions from devices where id = $1`, [device])).rows[0].sessions, 1);
  const prior = await store.priorSession(siteId, { deviceId: device });
  assert.equal(prior?.id, s.id);
  assert.equal(prior?.pageviews, 3);
});

test("a cookieless session is found by its key", async () => {
  const s = session(null);
  await store.startSession(s, null);
  assert.equal((await store.priorSession(siteId, { ckey: s.cookieless_key! }))?.id, s.id);
  assert.equal(await store.priorSession(siteId, { ckey: randomBytes(16) }), null);
});

test("a missing day table is made on the spot", async () => {
  const s = session(uuid7());
  await store.startSession(s, { id: s.device_id!, consent: "unknown" });
  const day = new Date(Date.now() + 2 * 86400_000).toISOString().slice(0, 10);
  await q(`drop table if exists public.events_${day.replace(/-/g, "")}`);
  await store.writeEvents([ev(s.id, "view", null, day)]);
  assert.equal((await q(`select count(*)::int as n from events where session_id = $1`, [s.id])).rows[0].n, 1);
});

test("shutdown right after 1,200 rows: all land, counts exact", async () => {
  const s = session(uuid7());
  await store.startSession(s, { id: s.device_id!, consent: "unknown" });
  const buf = new WriteBuffer(store, { batch: 500 });
  buf.push(Array.from({ length: 1200 }, () => ev(s.id, "view")));
  const left = await buf.close(20_000);
  assert.equal(left, 0);
  assert.equal((await q(`select pageviews from sessions where id = $1`, [s.id])).rows[0].pageviews, 1200);
});

test("database unreachable, then back: nothing lost, nothing doubled", async () => {
  const s = session(uuid7());
  await store.startSession(s, { id: s.device_id!, consent: "unknown" });
  const down = new PgStore("postgres://postgres:postgres@127.0.0.1:1/none", 1);
  let useDown = true;
  const flaky = new Proxy(store, { get: (t, k) => (k === "writeEvents" ? (rows: EventRow[]) => (useDown ? down.writeEvents(rows) : t.writeEvents(rows)) : Reflect.get(t, k)) });
  const buf = new WriteBuffer(flaky, { batch: 50 });
  buf.push(Array.from({ length: 120 }, () => ev(s.id, "view")));
  await buf.flush();
  assert.equal(buf.size, 120);
  useDown = false;
  assert.equal(await buf.close(10_000), 0);
  await down.pool.end();
  assert.equal((await q(`select pageviews from sessions where id = $1`, [s.id])).rows[0].pageviews, 120);
});

test("a statement killed mid-write rolls back whole and the retry lands once", async () => {
  const s = session(uuid7());
  await store.startSession(s, { id: s.device_id!, consent: "unknown" });
  const rows = Array.from({ length: 200 }, () => ev(s.id, "view"));
  // The write is cancelled by a statement timeout part way.
  const c = await store.pool.connect();
  await c.query("begin");
  await c.query("lock table sessions in exclusive mode");
  const killed = new PgStore(url, 1);
  (killed.pool as unknown as { options: { statement_timeout: number } }).options.statement_timeout = 300;
  await assert.rejects(killed.writeEvents(rows));
  await c.query("rollback");
  c.release();
  assert.equal((await q(`select count(*)::int as n from events where session_id = $1`, [s.id])).rows[0].n, 0, "nothing half-written");
  await store.writeEvents(rows);
  assert.equal((await q(`select pageviews from sessions where id = $1`, [s.id])).rows[0].pageviews, 200);
  await killed.pool.end();
});

test("hop nonces work once", async () => {
  const n = randomBytes(8);
  assert.equal(await store.useNonce(n), true);
  assert.equal(await store.useNonce(n), false);
});

test("salts: one per day, older than a day deleted", async () => {
  await q(`insert into salts (day, salt) values (current_date - 5, '\\x00')`);
  const a = await store.salt(today);
  const b = await store.salt(today);
  assert.deepEqual(a, b);
  assert.equal(a.length, 32);
  assert.equal((await q(`select count(*)::int as n from salts where day < current_date - 1`)).rows[0].n, 0);
});

test("opt-out marks the device and blocks it", async () => {
  const s = session(uuid7());
  await store.startSession(s, { id: s.device_id!, consent: "unknown" });
  const site = (await store.siteByKey((await q(`select site_key from sites where id = $1`, [siteId])).rows[0].site_key))!;
  assert.equal(await store.isOptedOut(siteId, s.device_id!), false);
  await store.optOut(site, s.device_id);
  assert.equal(await store.isOptedOut(siteId, s.device_id!), true);
  assert.equal((await q(`select state from devices where id = $1`, [s.device_id])).rows[0].state, "opted_out");
});

test("evidence and the stitch job", async () => {
  const device = uuid7();
  const id = uuid7();
  const e = { id, workspace_id: WS, site_id: siteId, device_id: device, session_id: null, source: "form", level: "asserted" as const, identifiers: [{ kind: "email", value: "jane@acme.com" }], extra: { page: "/demo" } };
  await store.addEvidence(e);
  await store.addEvidence(e);
  assert.equal((await q(`select count(*)::int as n from identity_evidence where id = $1`, [id])).rows[0].n, 1);
  await store.enqueue(WS, "stitch", device, { device_id: device });
  await store.enqueue(WS, "stitch", device, { device_id: device });
  assert.equal((await q(`select count(*)::int as n from jobs where kind = 'stitch' and key = $1 and status = 'queued'`, [device])).rows[0].n, 1, "one waiting job per device");
});
