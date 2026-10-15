// Rebuild equals incremental (docs/identity.md 7.9), and undo, erasure and export, on a real database.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import pg from "pg";
import { uuid7 } from "../../collect/ids.ts";
import { erasePerson, exportPerson } from "../../src/lib/identity/erase.ts";
import { rebuildWorkspace } from "../../src/lib/identity/rebuild.ts";
import { identifyToken, stitchDevice, stitchOne, workspaceLock, type Settings } from "../../src/lib/identity/stitch.ts";

const url = process.env.PG_URL;
if (!url) throw new Error("PG_URL is not set");
const pool = new pg.Pool({ connectionString: url, max: 6 });
const q = async (sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows;
after(() => pool.end());
const SECRET = "rebuild-secret-0123456789-0123456789";
const settings: Settings = { own_domains: ["own-co.com"], partner_domains: [], secrets: [SECRET] };

// A seeded random source, so a failure can be replayed.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0) / 2 ** 32);
}

async function workspace(name: string) {
  const ws = uuid7();
  await q(`insert into workspaces (id, name) values ($1, $2)`, [ws, name]);
  const site = (await q(`insert into sites (workspace_id, domain) values ($1, $2) returning id`, [ws, `${name}.com`]))[0].id;
  return { ws, site };
}

async function pending(ws: string) {
  return q(
    `select id, workspace_id, site_id, device_id, session_id, source, level, identifiers, hard_edge, extra, server_at
     from identity_evidence where workspace_id = $1 and stitched_at is null and revoked_at is null order by server_at, id`,
    [ws],
  );
}

async function stitchInOrder(ws: string) {
  for (const e of await pending(ws)) {
    const c = await pool.connect();
    try {
      await c.query("begin");
      await workspaceLock(c, ws);
      await stitchOne(c, e as never, settings);
      await c.query("commit");
    } finally {
      c.release();
    }
  }
}

/** The tables as people would compare them: persons by their identifiers, not by their ids. */
async function snapshot(ws: string) {
  const ids = await q(`select person_id, kind || ':' || value_clean as k from identifiers where workspace_id = $1 order by 2`, [ws]);
  const group = new Map<string, string[]>();
  for (const r of ids) if (r.person_id) group.set(r.person_id, [...(group.get(r.person_id) ?? []), r.k]);
  const name = (p: string | null) => (p ? (group.get(p) ?? ["(empty)"]).join(",") : "-");
  const links = (await q(`select device_id, person_id, level, from_at, to_at from device_links where workspace_id = $1`, [ws]))
    .map((l) => `${l.device_id} ${name(l.person_id)} ${l.level} ${+l.from_at} ${l.to_at ? +l.to_at : "open"}`)
    .sort();
  const sessions = (await q(`select id, person_id, person_level, person_source, internal, split_to from sessions where workspace_id = $1`, [ws]))
    .map((s) => `${s.id} ${name(s.person_id)} ${s.person_level} ${s.person_source} ${s.internal} ${s.split_to ?? ""}`)
    .sort();
  const devices = (await q(`select id, state, no_backfill, tainted_until from devices where workspace_id = $1`, [ws])).map((d) => `${d.id} ${d.state} ${d.no_backfill} ${d.tainted_until ? +d.tainted_until : ""}`).sort();
  const evidence = (await q(`select id, ignored, level, source, hard_edge from identity_evidence where workspace_id = $1`, [ws])).map((e) => `${e.id} ${e.ignored} ${e.level} ${e.source} ${e.hard_edge}`).sort();
  const proposals = (await q(`select person_a, person_b, reason from merge_proposals where workspace_id = $1 and status = 'open'`, [ws])).map((m) => [name(m.person_a), name(m.person_b)].sort().join(" | ") + " " + m.reason).sort();
  const people = [...group.values()].map((g) => g.join(",")).sort();
  return { people, links, sessions, devices, evidence, proposals };
}

test("rebuild equals incremental: 1,500 random evidence rows, 80 devices, 50 identifiers", async () => {
  const { ws, site } = await workspace("prop");
  const rand = rng(20261015);
  const pick = <T,>(a: T[]) => a[Math.floor(rand() * a.length)];
  const emails = Array.from({ length: 35 }, (_, i) => (i === 34 ? "boss@own-co.com" : i === 33 ? "sales@corp.io" : `p${i}@${["a.io", "b.io", "c.io", "gmail.com"][i % 4]}`));
  const users = Array.from({ length: 15 }, (_, i) => `u${i}`);
  const devices: { id: string; sessions: { id: string; at: number }[]; emails: string[] }[] = [];
  const start = Date.now() - 20 * 3600_000;
  for (let i = 0; i < 80; i++) {
    const id = uuid7(start);
    await q(`insert into devices (id, workspace_id, site_id) values ($1, $2, $3)`, [id, ws, site]);
    devices.push({ id, sessions: [], emails: [pick(emails), pick(emails)] });
  }
  let t = start;
  const rows: unknown[][] = [];
  for (let n = 0; n < 1500; n++) {
    t += 1000 + Math.floor(rand() * 30_000);
    const d = pick(devices);
    if (!d.sessions.length || rand() < 0.2) {
      const sid = uuid7(t);
      await q(`insert into sessions (id, workspace_id, site_id, device_id, started_at, ended_at, policy, is_bot) values ($1, $2, $3, $4, $5, $5, $6, $7)`, [
        sid, ws, site, d.id, new Date(t), rand() < 0.05 ? "cookieless" : "notice", rand() < 0.03,
      ]);
      d.sessions.push({ id: sid, at: t });
    }
    const s = d.sessions[d.sessions.length - 1].id;
    const r = rand();
    const email = rand() < 0.85 ? pick(d.emails) : pick(emails);
    const user = pick(users);
    let source = "form";
    let ids: { kind: string; value: string }[] = [{ kind: "email", value: rand() < 0.2 ? email.toUpperCase() : email }];
    let extra: Record<string, unknown> = {};
    if (r < 0.15) {
      source = "identify";
      ids = [{ kind: "user", value: user }];
      extra = { unsigned: true };
    } else if (r < 0.3) {
      source = "identify";
      ids = [{ kind: "email", value: email }, { kind: "user", value: user }];
      const iat = Math.floor(t / 1000);
      extra = { iat, token: identifyToken(SECRET, site, user, email, iat), unsigned: false };
    }
    rows.push([uuid7(t), ws, site, d.id, s, source, JSON.stringify(ids), JSON.stringify(extra), new Date(t)]);
  }
  // Step by step, in random batch sizes, in arrival order.
  let i = 0;
  while (i < rows.length) {
    const size = 1 + Math.floor(rand() * 120);
    for (const r of rows.slice(i, i + size)) {
      await q(`insert into identity_evidence (id, workspace_id, site_id, device_id, session_id, source, level, identifiers, extra, server_at) values ($1, $2, $3, $4, $5, $6, 'asserted', $7, $8, $9)`, r);
    }
    await stitchInOrder(ws);
    i += size;
  }
  const incremental = await snapshot(ws);
  assert.ok(incremental.people.length > 10, "the data made people");
  assert.ok(incremental.devices.some((d) => d.includes(" shared ")), "some devices are shared");
  assert.ok(incremental.devices.some((d) => d.includes(" tainted ")), "some devices are tainted");
  assert.ok(incremental.devices.some((d) => d.includes(" internal ")), "some devices are internal");
  const r = await rebuildWorkspace(pool, ws, settings);
  assert.equal(r.replayed, 1500);
  const rebuilt = await snapshot(ws);
  for (const k of Object.keys(incremental) as (keyof typeof incremental)[]) assert.deepEqual(rebuilt[k], incremental[k], k);
});

// Undo -------------------------------------------------------------------------------------------------------

async function asMember(ws: string) {
  const user = uuid7();
  await q(`insert into auth.users (id, email) values ($1, $2)`, [user, `${user}@test.io`]);
  await q(`insert into workspace_members (workspace_id, user_id, role) values ($1, $2, 'owner')`, [ws, user]);
  return async (sql: string, p: unknown[] = []) => {
    const c = await pool.connect();
    try {
      await c.query(`select set_config('request.jwt.claim.sub', $1, false)`, [user]);
      return (await c.query(sql, p)).rows;
    } finally {
      await c.query(`select set_config('request.jwt.claim.sub', '', false)`);
      c.release();
    }
  };
}

async function device(ws: string, site: string, at: number) {
  const d = uuid7(at);
  const s = uuid7(at);
  await q(`insert into devices (id, workspace_id, site_id) values ($1, $2, $3)`, [d, ws, site]);
  await q(`insert into sessions (id, workspace_id, site_id, device_id, started_at, ended_at, policy) values ($1, $2, $3, $4, $5, $5, 'notice')`, [s, ws, site, d, new Date(at)]);
  return { d, s };
}
const add = (ws: string, site: string, d: string | null, s: string | null, at: number, source: string, ids: object[], extra: object = {}) =>
  q(`insert into identity_evidence (id, workspace_id, site_id, device_id, session_id, source, level, identifiers, extra, server_at) values ($1, $2, $3, $4, $5, $6, 'asserted', $7, $8, $9)`, [
    uuid7(at), ws, site, d, s, source, JSON.stringify(ids), JSON.stringify(extra), new Date(at),
  ]);
const personOf = async (ws: string, v: string) => (await q(`select person_id from identifiers where workspace_id = $1 and value_clean = $2`, [ws, v]))[0]?.person_id ?? null;
const jobs = async (ws: string, kind: string) => (await q(`select count(*)::int n from jobs where workspace_id = $1 and kind = $2 and status = 'queued'`, [ws, kind]))[0].n;

test("unmerge splits people again, and the old id still resolves", async () => {
  const { ws, site } = await workspace("unmerge");
  const as = await asMember(ws);
  const t = Date.now() - 3600_000;
  const a = await device(ws, site, t);
  await add(ws, site, a.d, a.s, t + 1000, "form", [{ kind: "email", value: "ann@one.io" }]);
  const iat = Math.floor((t + 2000) / 1000);
  await add(ws, site, a.d, a.s, t + 2000, "identify", [{ kind: "email", value: "ann@one.io" }, { kind: "user", value: "u_ann" }], { iat, token: identifyToken(SECRET, site, "u_ann", "ann@one.io", iat) });
  await stitchDevice(pool, ws, a.d, settings);
  const p = await personOf(ws, "ann@one.io");
  assert.equal(await personOf(ws, "u_ann"), p);
  const uid = (await q(`select id from identifiers where workspace_id = $1 and value_clean = 'u_ann'`, [ws]))[0].id;
  const [{ unmerge_person: n }] = await as(`select unmerge_person($1, $2)`, [p, [uid]]);
  assert.equal(n, 1);
  assert.equal(await jobs(ws, "rebuild"), 1);
  await rebuildWorkspace(pool, ws, settings);
  assert.notEqual(await personOf(ws, "u_ann"), await personOf(ws, "ann@one.io"));
  assert.equal(await personOf(ws, "u_ann"), null, "an unsigned-style tie is gone; the user id only came with the edge");
  const alias = (await q(`select new_id from person_aliases where old_id = $1`, [p]))[0]?.new_id;
  assert.equal(alias, await personOf(ws, "ann@one.io"), "the old person id points to the new one");
  assert.ok((await q(`select 1 from audit_log where workspace_id = $1 and action = 'person.unmerge'`, [ws])).length);
});

test("unlink a device; mark a kiosk", async () => {
  const { ws, site } = await workspace("unlink");
  const as = await asMember(ws);
  const t = Date.now() - 3600_000;
  const a = await device(ws, site, t);
  await add(ws, site, a.d, a.s, t + 1000, "form", [{ kind: "email", value: "bo@two.io" }]);
  await stitchDevice(pool, ws, a.d, settings);
  const p = await personOf(ws, "bo@two.io");
  await as(`select unlink_device($1, $2)`, [a.d, p]);
  await rebuildWorkspace(pool, ws, settings);
  assert.equal((await q(`select count(*)::int n from device_links where device_id = $1`, [a.d]))[0].n, 0);
  assert.equal((await q(`select person_id from sessions where id = $1`, [a.s]))[0].person_id, null);
  const [dev] = await q(`select state, no_backfill from devices where id = $1`, [a.d]);
  assert.deepEqual([dev.state, dev.no_backfill], ["fresh", false], "a rebuild resets the device; the revoked evidence keeps it unlinked");

  const k = await device(ws, site, t);
  await add(ws, site, k.d, k.s, t + 1000, "form", [{ kind: "email", value: "cy@two.io" }]);
  await stitchDevice(pool, ws, k.d, settings);
  await as(`select mark_kiosk($1)`, [k.d]);
  await rebuildWorkspace(pool, ws, settings);
  assert.equal((await q(`select state from devices where id = $1`, [k.d]))[0].state, "tainted");
  assert.equal((await q(`select count(*)::int n from device_links where device_id = $1`, [k.d]))[0].n, 0, "a kiosk links no one, even after a rebuild");
});

test("approving a merge proposal merges past the guards; denying keeps it closed", async () => {
  const { ws, site } = await workspace("proposal");
  const as = await asMember(ws);
  const t = Date.now() - 3600_000;
  const sign = (u: string, e: string, at: number) => {
    const iat = Math.floor(at / 1000);
    return { iat, token: identifyToken(SECRET, site, u, e, iat) };
  };
  for (const [i, [e, u]] of [["dee@x.io", "u1"], ["dee2@x.io", "u2"], ["dee2@x.io", "u1"]].entries()) {
    const dv = await device(ws, site, t + i);
    await add(ws, site, dv.d, dv.s, t + 1000 * (i + 1), "identify", [{ kind: "email", value: e }, { kind: "user", value: u }], sign(u, e, t + 1000 * (i + 1)));
    await stitchDevice(pool, ws, dv.d, settings);
  }
  const [mp] = await q(`select id from merge_proposals where workspace_id = $1 and status = 'open'`, [ws]);
  assert.ok(mp);
  await as(`select decide_merge($1, true)`, [mp.id]);
  assert.equal(await jobs(ws, "stitch_evidence"), 1);
  const [ev] = await q(`select * from identity_evidence where workspace_id = $1 and source = 'manual_merge'`, [ws]);
  const c = await pool.connect();
  await c.query("begin");
  await stitchOne(c, ev, settings);
  await c.query("commit");
  c.release();
  assert.equal(await personOf(ws, "u1"), await personOf(ws, "u2"));
  await assert.rejects(as(`select decide_merge($1, false)`, [mp.id]), /already decided/);
});

test("erasure removes every trace; export lists what's held", async () => {
  const { ws, site } = await workspace("erase");
  const t = Date.now() - 1800_000;
  const a = await device(ws, site, t);
  const b = await device(ws, site, t);
  await q(`insert into events (id, workspace_id, session_id, day, kind, path, server_at) values ($1, $2, $3, current_date, 'view', '/pricing', now())`, [uuid7(), ws, a.s]);
  await add(ws, site, a.d, a.s, t + 1000, "form", [{ kind: "email", value: "Eve.Smith+x@gmail.com" }]);
  await add(ws, site, b.d, b.s, t + 2000, "form", [{ kind: "email", value: "evesmith@gmail.com" }]);
  // Device b is shared with someone else.
  await add(ws, site, b.d, b.s, t + 3000, "form", [{ kind: "email", value: "other@three.io" }]);
  await stitchDevice(pool, ws, a.d, settings);
  await stitchDevice(pool, ws, b.d, settings);
  const p = await personOf(ws, "evesmith@gmail.com");
  const data = await exportPerson(pool, ws, p);
  assert.deepEqual(data.identifiers.map((i) => i.value), ["evesmith@gmail.com"]);
  assert.equal(data.evidence.length, 2);
  assert.ok(data.sessions.some((s) => s.pages.includes("/pricing")));

  const counts = await erasePerson(pool, ws, p);
  assert.equal(counts.devices, 1, "device a was only Eve's");
  assert.ok(counts.evidence >= 2);
  const everything = JSON.stringify(
    await q(
      `select (select json_agg(x) from identity_evidence x where workspace_id = $1) a, (select json_agg(x) from identifiers x where workspace_id = $1) b,
              (select json_agg(x) from persons x where workspace_id = $1) c, (select json_agg(x) from device_links x where workspace_id = $1) d`,
      [ws],
    ),
  ).toLowerCase();
  assert.ok(!/evesmith|eve\.smith/.test(everything), "no trace of Eve");
  assert.ok(everything.includes("other@three.io"), "the other person on the shared device stays");
  assert.equal((await q(`select count(*)::int n from devices where id = $1`, [a.d]))[0].n, 0);
  assert.equal((await q(`select count(*)::int n from events where session_id = $1`, [a.s]))[0].n, 0);
  assert.equal((await q(`select count(*)::int n from erasures where workspace_id = $1`, [ws]))[0].n, 1);
  // Coming back later starts fresh.
  const c2 = await device(ws, site, Date.now() - 1000);
  await add(ws, site, c2.d, c2.s, Date.now() - 500, "form", [{ kind: "email", value: "evesmith@gmail.com" }]);
  await stitchDevice(pool, ws, c2.d, settings);
  const fresh = await personOf(ws, "evesmith@gmail.com");
  assert.ok(fresh && fresh !== p);
});
