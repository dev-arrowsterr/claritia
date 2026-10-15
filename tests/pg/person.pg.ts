// Person page and Privacy search on a real database, from a stitched person.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import pg from "pg";
import { uuid7 } from "../../collect/ids.ts";
import { PgStore, type SessionRow } from "../../collect/store.ts";
import { stitchDevice } from "../../src/lib/identity/stitch.ts";

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

test("person_detail shows identifiers, devices, evidence and sessions; privacy_find is for owners", async () => {
  const ws = uuid7();
  const owner = uuid7();
  const member = uuid7();
  await q(`insert into workspaces (id, name) values ($1, 'person test')`, [ws]);
  for (const [u, role] of [[owner, "owner"], [member, "member"]]) {
    await q(`insert into auth.users (id, email) values ($1, $2)`, [u, `${u}@t.io`]);
    await q(`insert into workspace_members (workspace_id, user_id, role) values ($1, $2, $3)`, [ws, u, role]);
  }
  const site = (await q(`insert into sites (workspace_id, domain) values ($1, $2) returning id`, [ws, `per-${ws.slice(-8)}.com`]))[0].id;
  const d = uuid7();
  await q(`insert into devices (id, workspace_id, site_id) values ($1, $2, $3)`, [d, ws, site]);
  const s: SessionRow = {
    id: uuid7(), workspace_id: ws, site_id: site, device_id: d, cookieless_key: null, started_at: new Date(), ended_at: new Date(), policy: "notice",
    consent: "unknown", gpc: false, country: "US", region: null, city: null, device_type: "desktop", browser: "Chrome", os: "macOS", landing_path: "/demo",
    referrer_host: null, source: null, medium: null, campaign: null, term: null, content: null, ref_class: "direct", ip_net: null, ip_kind: "direct", is_bot: false,
  };
  await store.startSession(s, null);
  const email = `jane_${ws.slice(-6)}@initech-test.com`;
  await q(`insert into identity_evidence (id, workspace_id, site_id, device_id, session_id, source, level, identifiers, extra) values ($1, $2, $3, $4, $5, 'form', 'asserted', $6, $7)`, [
    uuid7(), ws, site, d, s.id, JSON.stringify([{ kind: "email", value: email }]), JSON.stringify({ page: "/demo" }),
  ]);
  await stitchDevice(pool, ws, d, settings);
  const person = (await q(`select person_id from sessions where id = $1`, [s.id]))[0].person_id;
  assert.ok(person, "the visit has a person");

  const c = await pool.connect();
  const as = (u: string) => c.query(`select set_config('request.jwt.claim.sub', $1, false)`, [u]);
  const rpc = async (fn: string, args: unknown[]) => (await c.query(`select ${fn}(${args.map((_, i) => `$${i + 1}`).join(", ")}) as r`, args)).rows[0].r;
  try {
    await as(member);
    const p = await rpc("person_detail", [person]);
    assert.equal(p.person.email, email);
    assert.equal(p.person.level, "asserted");
    assert.deepEqual(p.identifiers.map((i: { kind: string; value: string }) => [i.kind, i.value]), [["email", email]]);
    assert.equal(p.identifiers[0].first.source, "form");
    assert.equal(p.identifiers[0].first.page, "/demo");
    assert.equal(p.devices.length, 1);
    assert.deepEqual([p.devices[0].id, p.devices[0].browser, p.devices[0].links[0].level], [d, "Chrome", "asserted"]);
    assert.equal(p.evidence.length, 1);
    assert.equal(p.evidence[0].linked, true);
    assert.deepEqual(p.sessions.map((x: { id: string }) => x.id), [s.id]);

    await assert.rejects(rpc("privacy_find", [ws, email]), /owner/, "members can't search privacy");
    await as(owner);
    const found = await rpc("privacy_find", [ws, email.toUpperCase()]);
    assert.deepEqual(found.map((f: { id: string; exact: boolean }) => [f.id, f.exact]), [[person, true]]);
    assert.equal((await rpc("privacy_find", [ws, email.slice(0, 6)])).length, 1, "a prefix finds them");
    assert.equal((await rpc("privacy_find", [ws, "j%"])).length, 0, "wildcards are taken as text");
    assert.equal((await rpc("privacy_find", [ws, "ja"])).length, 0, "too short");

    // A merged person points to where they went.
    const other = uuid7();
    await q(`insert into persons (id, workspace_id, merged_into) values ($1, $2, $3)`, [other, ws, person]);
    assert.deepEqual(await rpc("person_detail", [other]), { moved_to: person });
  } finally {
    await c.query(`select set_config('request.jwt.claim.sub', '', false)`);
    c.release();
  }
});
