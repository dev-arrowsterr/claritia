// The stitch job against a real database built from the migrations (run by scripts/test-db.sh).
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import pg from "pg";
import { uuid7 } from "../../collect/ids.ts";
import { identifyToken, stitchDevice, type Settings } from "../../src/lib/identity/stitch.ts";

const url = process.env.PG_URL;
if (!url) throw new Error("PG_URL is not set");
const pool = new pg.Pool({ connectionString: url, max: 12 });
const q = async (sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows;
const WS = "55555555-5555-4555-8555-555555555555";
const SECRET = "identify-secret-for-tests-0123456789";
const settings: Settings = { own_domains: ["claritia-test.com"], partner_domains: ["partner.io"], secrets: [SECRET] };
let site = "";
const H = 3600_000;
const base = Date.now() - 48 * H;

before(async () => {
  await q(`insert into workspaces (id, name) values ($1, 'stitch test') on conflict do nothing`, [WS]);
  site = (await q(`insert into sites (workspace_id, domain) values ($1, 'stitch-test.com') returning id`, [WS]))[0].id;
});
after(() => pool.end());

async function device(): Promise<string> {
  const id = uuid7();
  await q(`insert into devices (id, workspace_id, site_id) values ($1, $2, $3)`, [id, WS, site]);
  return id;
}
async function session(dev: string, at: number, policy = "notice", extra: { is_bot?: boolean } = {}): Promise<string> {
  const id = uuid7(at);
  await q(`insert into sessions (id, workspace_id, site_id, device_id, started_at, ended_at, policy, is_bot) values ($1, $2, $3, $4, $5, $6, $7, $8)`, [
    id, WS, site, dev, new Date(at), new Date(at + 10 * 60_000), policy, extra.is_bot ?? false,
  ]);
  return id;
}
async function view(sessionId: string, at: number) {
  await q(`insert into events (id, workspace_id, session_id, day, kind, path, server_at) values ($1, $2, $3, $4, 'view', '/', $5)`, [uuid7(at), WS, sessionId, new Date(at).toISOString().slice(0, 10), new Date(at)]);
}
async function evidence(dev: string, sessionId: string | null, at: number, source: string, ids: { kind: string; value: string }[], extra: Record<string, unknown> = {}) {
  const id = uuid7(at);
  await q(`insert into identity_evidence (id, workspace_id, site_id, device_id, session_id, source, level, identifiers, extra, server_at) values ($1, $2, $3, $4, $5, $6, 'asserted', $7, $8, $9)`, [
    id, WS, site, dev, sessionId, source, JSON.stringify(ids), JSON.stringify(extra), new Date(at),
  ]);
  return id;
}
const form = (dev: string, s: string | null, at: number, email: string) => evidence(dev, s, at, "form", [{ kind: "email", value: email }]);
const run = (dev: string) => stitchDevice(pool, WS, dev, settings);
const personOf = async (kind: string, value: string) => (await q(`select person_id from identifiers where workspace_id = $1 and kind = $2 and value_clean = $3`, [WS, kind, value]))[0]?.person_id ?? null;
const devState = async (d: string) => (await q(`select state, no_backfill from devices where id = $1`, [d]))[0];

test("fresh device + form: a person, a link, and earlier visits backfilled", async () => {
  const d = await device();
  const s1 = await session(d, base);
  const s2 = await session(d, base + 2 * H, "notice", { is_bot: true });
  const s3 = await session(d, base + 4 * H);
  await form(d, s3, base + 4 * H + 60_000, "Jane.Doe+demo@Acme-Corp.com");
  const [r] = await run(d);
  assert.ok("person" in r && r.device === "linked");
  const p = await personOf("email", "jane.doe@acme-corp.com");
  assert.equal(r.person, p);
  assert.equal((await devState(d)).state, "linked");
  const rows = await q(`select id, person_id, person_source from sessions where device_id = $1 order by started_at`, [d]);
  assert.deepEqual(rows.map((x) => [x.person_id === p, x.person_source]), [[true, "backfill"], [false, null], [true, "live"]], "bots aren't backfilled");
  void s1;
  void s2;
  assert.equal((await q(`select count(*)::int n from device_links where device_id = $1 and to_at is null`, [d]))[0].n, 1);
  assert.deepEqual(await run(d), [], "nothing left to do");
});

test("the same email on a second device is the same person; no history crosses devices", async () => {
  const a = await device();
  const b = await device();
  await form(a, await session(a, base), base + 60_000, "sam@beta.io");
  const old = await session(b, base);
  const cur = await session(b, base + 3 * H);
  await form(b, cur, base + 3 * H + 1000, "SAM@beta.io");
  await run(a);
  await run(b);
  const p = await personOf("email", "sam@beta.io");
  assert.equal((await q(`select count(distinct person_id)::int n from device_links where device_id = any($1)`, [[a, b]]))[0].n, 1);
  assert.equal((await q(`select person_id from sessions where id = $1`, [old]))[0].person_id, p, "device b's own history backfills");
});

test("another person on a linked device: shared, the visit splits at that moment", async () => {
  const d = await device();
  const t0 = Date.now() - 30 * 60_000;
  const s = await session(d, t0);
  await view(s, t0 + 1000);
  await form(d, s, t0 + 2000, "first@gamma.io");
  await run(d);
  await view(s, t0 + 5 * 60_000);
  await form(d, s, t0 + 4 * 60_000, "second@gamma.io");
  const [r] = await run(d);
  assert.ok("device" in r && r.device === "shared" && r.split);
  assert.equal((await devState(d)).state, "shared");
  assert.equal((await devState(d)).no_backfill, true);
  const [oldS] = await q(`select person_id, split_to, pageviews from sessions where id = $1`, [s]);
  const [newS] = await q(`select person_id, split_from, pageviews, person_source from sessions where id = $1`, [r.split]);
  assert.equal(oldS.person_id, await personOf("email", "first@gamma.io"));
  assert.equal(newS.person_id, await personOf("email", "second@gamma.io"));
  assert.equal(oldS.split_to, r.split);
  assert.equal(newS.split_from, s);
  assert.deepEqual([oldS.pageviews, newS.pageviews], [1, 1], "the later view moved to the new part");
  assert.equal(newS.person_source, "split");
});

test("three people in a day: tainted, and the day's visits lose their person", async () => {
  const d = await device();
  const t0 = base + 20 * H;
  const s = await session(d, t0);
  for (const [i, e] of ["a@delta.io", "b@delta.io", "c@delta.io"].entries()) await form(d, s, t0 + (i + 1) * 60_000, e);
  const out = await run(d);
  assert.deepEqual(out.map((o) => ("device" in o ? o.device : o.ignored)), ["linked", "shared", "tainted"]);
  assert.equal((await devState(d)).state, "tainted");
  assert.equal((await q(`select person_id from sessions where id = $1`, [s]))[0].person_id, null);
  assert.equal((await q(`select count(*)::int n from device_links where device_id = $1 and to_at is null`, [d]))[0].n, 0);
  await form(d, s, t0 + 10 * 60_000, "d@delta.io");
  assert.equal(((await run(d))[0] as { device: string }).device, "tainted", "no links while tainted");
  assert.ok(await personOf("email", "d@delta.io"), "the person is still made");
});

test("two unsigned identities on one device: tainted", async () => {
  const d = await device();
  const s = await session(d, base);
  await evidence(d, s, base + 1000, "identify", [{ kind: "user", value: "u1" }], { unsigned: true });
  await evidence(d, s, base + 2000, "identify", [{ kind: "user", value: "u2" }], { unsigned: true });
  const out = await run(d);
  assert.equal((out[1] as { device: string }).device, "tainted");
});

test("signed identify: verified, a hard edge, and two people merge into the oldest", async () => {
  const a = await device();
  const b = await device();
  await form(a, await session(a, base), base + 1000, "kim@epsilon.io");
  await run(a);
  const pEmail = await personOf("email", "kim@epsilon.io");
  await evidence(b, await session(b, base + H), base + H + 1000, "identify", [{ kind: "user", value: "u_77" }], { unsigned: true });
  await run(b);
  const pUser = await personOf("user", "u_77");
  assert.notEqual(pEmail, pUser);
  const iat = Math.floor((base + 2 * H) / 1000);
  const token = identifyToken(SECRET, site, "u_77", "kim@epsilon.io", iat);
  await evidence(b, null, base + 2 * H, "identify", [{ kind: "email", value: "kim@epsilon.io" }, { kind: "user", value: "u_77" }], { iat, token, unsigned: false });
  const [r] = await run(b);
  assert.ok("merged" in r && r.merged?.length === 1);
  assert.equal(r.person, pEmail, "the oldest person survives");
  assert.equal(await personOf("user", "u_77"), pEmail);
  assert.equal((await q(`select new_id from person_aliases where old_id = $1`, [pUser]))[0].new_id, pEmail);
  const [ev] = await q(`select source, level, hard_edge, extra from identity_evidence where device_id = $1 order by server_at desc limit 1`, [b]);
  assert.deepEqual([ev.source, ev.level, ev.hard_edge, "token" in ev.extra], ["identify_signed", "verified", true, false], "the token is removed after the check");
});

test("a bad token is unsigned: no hard edge, only the first identifier counts", async () => {
  const d = await device();
  const iat = Math.floor((base + H) / 1000);
  await evidence(d, await session(d, base + H), base + H, "identify", [{ kind: "email", value: "lee@zeta.io" }, { kind: "user", value: "u_lee" }], { iat, token: "forged", unsigned: false });
  await run(d);
  assert.ok(await personOf("email", "lee@zeta.io"));
  assert.equal(await personOf("user", "u_lee"), null, "an unsigned call can't tie two identifiers");
});

test("merge guards: two user ids make a proposal, not a merge", async () => {
  const a = await device();
  const b = await device();
  const c = await device();
  const sign = (u: string, e: string, at: number) => {
    const iat = Math.floor(at / 1000);
    return { iat, token: identifyToken(SECRET, site, u, e, iat), unsigned: false };
  };
  await evidence(a, null, base + 1000, "identify", [{ kind: "email", value: "max@eta.io" }, { kind: "user", value: "u_max1" }], sign("u_max1", "max@eta.io", base + 1000));
  await evidence(b, null, base + 2000, "identify", [{ kind: "email", value: "max2@eta.io" }, { kind: "user", value: "u_max2" }], sign("u_max2", "max2@eta.io", base + 2000));
  await run(a);
  await run(b);
  await q(`insert into sessions (id, workspace_id, site_id, device_id, started_at, ended_at, policy) values ($1, $2, $3, $4, now(), now(), 'notice')`, [uuid7(), WS, site, c]);
  // Ties max2@ to u_max1: would give one person two user ids.
  await evidence(c, null, base + 3000, "identify", [{ kind: "email", value: "max2@eta.io" }, { kind: "user", value: "u_max1" }], sign("u_max1", "max2@eta.io", base + 3000));
  const [r] = await run(c);
  assert.ok("proposed" in r && r.proposed);
  assert.notEqual(await personOf("user", "u_max1"), await personOf("user", "u_max2"));
  assert.equal((await q(`select count(*)::int n from merge_proposals where workspace_id = $1 and reason = 'two_user_ids'`, [WS]))[0].n, 1);
});

test("own domain marks the device internal; role, disposable and policy are ignored", async () => {
  const d = await device();
  const s = await session(d, base);
  await form(d, s, base + 1000, "me@claritia-test.com");
  assert.deepEqual(await run(d), [{ ignored: "internal" }]);
  assert.equal((await devState(d)).state, "internal");
  assert.equal((await q(`select internal from sessions where id = $1`, [s]))[0].internal, true);
  await form(d, s, base + 2000, "x@theta.io");
  assert.deepEqual(await run(d), [{ ignored: "internal" }], "nothing links an internal device");

  const r = await device();
  await form(r, await session(r, base), base + 1000, "sales@iota.io");
  assert.deepEqual(await run(r), [{ ignored: "role" }]);
  const m = await device();
  await form(m, await session(m, base), base + 1000, "x@mailinator.com");
  assert.deepEqual(await run(m), [{ ignored: "invalid" }]);
  const c = await device();
  await form(c, await session(c, base, "cookieless"), base + 1000, "y@kappa.io");
  assert.deepEqual(await run(c), [{ ignored: "policy" }]);
  assert.equal(await personOf("email", "y@kappa.io"), null);
});

test("erased identifiers are never stitched again", async () => {
  const d = await device();
  const { hashOf } = await import("../../src/lib/identity/clean.ts");
  await q(`insert into erasures (workspace_id, value_hash) values ($1, $2)`, [WS, hashOf("gone@lambda.io")]);
  await form(d, await session(d, base), base + 1000, "gone@lambda.io");
  assert.deepEqual(await run(d), [{ ignored: "invalid" }]);
  assert.equal(await personOf("email", "gone@lambda.io"), null);
});

test("8 devices with the same new email at once: one person", async () => {
  const devs = await Promise.all(Array.from({ length: 8 }, () => device()));
  for (const d of devs) await form(d, await session(d, base), base + 1000, "race@mu.io");
  await Promise.all(devs.map((d) => run(d)));
  assert.equal((await q(`select count(*)::int n from identifiers where workspace_id = $1 and value_clean = 'race@mu.io'`, [WS]))[0].n, 1);
  assert.equal((await q(`select count(distinct person_id)::int n from device_links where device_id = any($1)`, [devs]))[0].n, 1);
  assert.equal((await q(`select count(*)::int n from persons where workspace_id = $1 and primary_email = 'race@mu.io'`, [WS]))[0].n, 1);
});

test("a job killed midway leaves the evidence for the next try", async () => {
  const d = await device();
  await form(d, await session(d, base), base + 1000, "kill@nu.io");
  const broken = {
    connect: async () => {
      const c = await pool.connect();
      let n = 0;
      return {
        query: async (sql: string, p?: unknown[]) => {
          if (++n === 12) throw new Error("connection lost");
          return c.query(sql, p);
        },
        release: () => c.release(),
      };
    },
  };
  await assert.rejects(stitchDevice(broken, WS, d, settings));
  assert.equal(await personOf("email", "kill@nu.io"), null, "the half-done work rolled back");
  assert.equal((await q(`select count(*)::int n from identity_evidence where device_id = $1 and stitched_at is null`, [d]))[0].n, 1);
  await run(d);
  assert.ok(await personOf("email", "kill@nu.io"));
});
