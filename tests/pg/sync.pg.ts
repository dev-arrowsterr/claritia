// Two-way sync, part 2, on a real database: a rep's change in HubSpot lands even over an old edit here, both-side
// changes follow each field's setting, the score goes out once with no loop, and activity goes out once per event,
// with a worker killed mid-write never writing twice.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import pg from "pg";
import { uuid7 } from "../../collect/ids.ts";
import { writeContacts } from "../../src/lib/contacts/contacts.ts";
import { seal } from "../../src/lib/seal.ts";
import { runActivity, runPull, type RunOpts } from "../../src/lib/sources/run.ts";
import { ctxFor } from "../../worker-intel/jobs/imports.ts";
import { pgRpc } from "../../worker-intel/rpc.ts";
import { FakeHubspot, rng } from "../sources/fakeHubspot.ts";

process.env.SECRETS_KEY ||= "test-secrets-key-that-is-long-enough-1234";
const url = process.env.PG_URL;
if (!url) throw new Error("PG_URL is not set");
const pool = new pg.Pool({ connectionString: url, max: 4 });
const q = async (sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows;
after(() => pool.end());
const rpc = pgRpc(pool);

let ws = "";
let user = "";
let id = "";
const hs = new FakeHubspot(rng(7), { portal: 4242 });
const opts: RunOpts = { rpc, clean: (w) => ctxFor(pool, w), fetcher: hs.fetch, sleep: async () => {} };
const pullAll = async () => {
  for (let more = true; more; ) more = !!(await runPull(opts, id))?.more;
};
const local = async (email: string) => (await q(`select id, title, phone, score from contacts where workspace_id = $1 and email_clean = $2`, [ws, email]))[0] as { id: string; title: string | null; phone: string | null; score: number | null };
const remote = (email: string) => hs.live().find((c) => c.properties.email === email)!;
const asOwner = async (sql: string, params: unknown[]) => {
  const c = await pool.connect();
  try {
    await c.query(`select set_config('request.jwt.claim.sub', $1, false)`, [user]);
    await c.query("set role authenticated");
    await c.query(sql, params);
  } finally {
    await c.query("reset role");
    await c.query(`select set_config('request.jwt.claim.sub', '', false)`);
    c.release();
  }
};
const setWins = async (wins: Record<string, string>) => {
  const rows = [
    ["email", "email"],
    ["firstname", "first_name"],
    ["lastname", "last_name"],
    ["jobtitle", "title"],
    ["phone", "phone"],
    ["lifecyclestage", "lifecycle"],
    ["claritia_score", "score"],
    ["claritia_band", "score_band"],
    ["hubspot_owner_id", "owner_crm"],
  ].map(([col, target]) => ({ col, target, wins: wins[target] ?? "claritia" }));
  await asOwner(`select mapping_save($1, 'contact', $2)`, [id, JSON.stringify(rows)]);
};

before(async () => {
  ws = uuid7();
  user = uuid7();
  await q(`insert into workspaces (id, name) values ($1, 'sync2')`, [ws]);
  await q(`insert into auth.users (id, email) values ($1, $2)`, [user, `${user}@t.io`]);
  await q(`insert into workspace_members (workspace_id, user_id, role) values ($1, $2, 'owner')`, [ws, user]);
  for (const n of ["ann", "bob", "cy", "dee", "eli"]) hs.create({ email: `${n}@acme.com`, firstname: n, jobtitle: "Engineer", phone: "+14155550100", lifecyclestage: "lead" }, true);
  const creds = { type: "oauth", access: "t1", refresh: "r1", expiresAt: Date.now() + 3_600_000 };
  id = (await q(`select source_connect($1, $2, 'hubspot', 'HubSpot', '4242', $3, $4) as id`, [ws, user, seal(JSON.stringify(creds)), JSON.stringify({ objects: { contacts: "both", companies: "off", lists: "off" }, push_new: "lifecycle", basis: "legitimate_interest" })]))[0].id;
  await pullAll();
  await pullAll();
});

test("a rep's change in HubSpot lands even where a person edited the field here before", async () => {
  const ann = await local("ann@acme.com");
  // An old edit here, already synced.
  await q(`select contact_update($1, 'manual', $2)`, [ann.id, JSON.stringify({ title: "Staff Engineer" })]);
  await pullAll();
  assert.equal(remote("ann@acme.com").properties.jobtitle, "Staff Engineer");
  // Later, the rep changes it in HubSpot. Nothing changed here since.
  hs.edit(remote("ann@acme.com").id, { jobtitle: "Director" });
  const writes = hs.writes;
  await pullAll();
  assert.equal((await local("ann@acme.com")).title, "Director");
  assert.equal(hs.writes, writes, "and nothing is pushed back over it");
});

test("both sides changed: Claritia wins by default, CRM wins when set, newest compares times", async () => {
  // Default: Claritia.
  const bob = await local("bob@acme.com");
  await q(`select contact_update($1, 'manual', $2)`, [bob.id, JSON.stringify({ title: "Here" })]);
  hs.edit(remote("bob@acme.com").id, { jobtitle: "There" });
  await pullAll();
  await pullAll();
  assert.equal((await local("bob@acme.com")).title, "Here");
  assert.equal(remote("bob@acme.com").properties.jobtitle, "Here");

  // CRM wins the title.
  await setWins({ title: "crm" });
  const cy = await local("cy@acme.com");
  await q(`select contact_update($1, 'manual', $2)`, [cy.id, JSON.stringify({ title: "Here" })]);
  hs.edit(remote("cy@acme.com").id, { jobtitle: "There" });
  await pullAll();
  await pullAll();
  assert.equal((await local("cy@acme.com")).title, "There");
  assert.equal(remote("cy@acme.com").properties.jobtitle, "There");

  // Newest: HubSpot's change is a day older than ours, so ours wins; then a fresh HubSpot change wins.
  await setWins({ phone: "newest" });
  const dee = await local("dee@acme.com");
  await q(`select contact_update($1, 'manual', $2)`, [dee.id, JSON.stringify({ phone: "+14155550111" })]);
  hs.setClock(Date.now() - 86_400_000);
  hs.edit(remote("dee@acme.com").id, { phone: "+14155550122" });
  await pullAll();
  await pullAll();
  assert.equal((await local("dee@acme.com")).phone, "+14155550111");
  assert.equal(remote("dee@acme.com").properties.phone, "+14155550111");
  await q(`select contact_update($1, 'manual', $2)`, [dee.id, JSON.stringify({ phone: "+14155550133" })]);
  hs.setClock(Date.now() + 60_000);
  hs.edit(remote("dee@acme.com").id, { phone: "+14155550144" });
  await pullAll();
  await pullAll();
  assert.equal((await local("dee@acme.com")).phone, "+14155550144");
  assert.equal(remote("dee@acme.com").properties.phone, "+14155550144");
  // Wins settings were saved per field.
  const saved = await q(`select target, wins from mappings where source_id = $1 and target in ('title', 'phone', 'score') order by target`, [id]);
  assert.deepEqual(saved.map((r) => `${r.target}:${r.wins}`), ["phone:newest", "score:claritia", "title:claritia"]);
});

test("the score goes out once, and settled rounds write nothing", async () => {
  const eli = await local("eli@acme.com");
  await q(`update contacts set score = 87, score_band = 'hot' where id = $1`, [eli.id]);
  await pullAll();
  assert.equal(remote("eli@acme.com").properties.claritia_score, "87");
  assert.equal(remote("eli@acme.com").properties.claritia_band, "hot");
  // A rep can't overwrite the score from HubSpot.
  hs.edit(remote("eli@acme.com").id, { claritia_score: "5" });
  await pullAll();
  assert.equal((await local("eli@acme.com")).score, 87);
  const writes = hs.writes;
  await pullAll();
  await pullAll();
  assert.equal(hs.writes, writes, "no push loop once settled");
});

test("the owner goes out from routing, and a rep's reassignment in HubSpot comes back without a push", async () => {
  await setWins({});
  const bob = await local("bob@acme.com");
  await q(`update contacts set owner_crm_id = '77' where id = $1`, [bob.id]);
  await pullAll();
  assert.equal(remote("bob@acme.com").properties.hubspot_owner_id, "77");
  hs.edit(remote("bob@acme.com").id, { hubspot_owner_id: "88" });
  const writes = hs.writes;
  await pullAll();
  await pullAll();
  assert.equal((await q(`select owner_crm_id from contacts where id = $1`, [bob.id]))[0].owner_crm_id, "88");
  assert.equal(hs.writes, writes, "nothing pushed back over the rep's change");
});

test("activity goes out once per event; a claim left by a dead worker is never written", async () => {
  const ann = await local("ann@acme.com");
  const eli = await local("eli@acme.com");
  const email = (await q(`insert into emails (workspace_id, name, kind, subject, html, text) values ($1, 'Oct', 'broadcast', 'October news', 'x', 'x') returning id`, [ws]))[0].id;
  await writeContacts(rpc, ws, "form", [{ email: "nolink@site.com", email_clean: "nolink@site.com", email_class: "work", fields: {} }]);
  const nolink = (await local("nolink@site.com")).id;
  const ev = async (contact: string, kind: string, data: object) =>
    (await q(`insert into contact_events (workspace_id, contact_id, kind, data, source) values ($1, $2, $3, $4, 'test') returning id`, [ws, contact, kind, JSON.stringify(data)]))[0].id as string;
  const sent = await ev(ann.id, "email.sent", { email_id: email });
  const clicked = await ev(ann.id, "email.clicked", { email_id: email, url: "https://acme.com/pricing" });
  const form = await ev(eli.id, "form.submitted", { form_name: "Demo request", answers: { Seats: 40 } });
  await ev(nolink, "email.sent", { email_id: email });
  const stuck = await ev(eli.id, "email.sent", { email_id: email });
  // A worker claimed this one and died before writing it.
  await q(`select activity_claim($1, $2)`, [id, JSON.stringify([{ id: stuck, kind: "email.sent", contact_id: eli.id }])]);
  await q(`update activity_out set claimed_at = now() - interval '11 minutes' where event_id = $1`, [stuck]);

  process.env.HUBSPOT_TIMELINE_TEMPLATE = "tpl-9";
  try {
    await runActivity(opts, id);
    await runActivity(opts, id);
  } finally {
    delete process.env.HUBSPOT_TIMELINE_TEMPLATE;
  }
  assert.deepEqual([...hs.timeline.keys()].sort(), [sent, clicked, form].sort());
  assert.equal(hs.timeline.get(clicked)!.tokens.detail, "https://acme.com/pricing");
  assert.equal(hs.timeline.get(form)!.tokens.title, "Demo request");
  assert.equal(hs.timeline.get(sent)!.objectId, remote("ann@acme.com").id);
  const states = Object.fromEntries((await q(`select event_id, status from activity_out where source_id = $1`, [id])).map((r) => [r.event_id, r.status]));
  assert.equal(states[stuck], "unknown");
  assert.equal(Object.values(states).filter((s) => s === "sent").length, 3);
  assert.equal((await q(`select count(*)::int n from sync_log where source_id = $1 and object = 'activity' and action = 'create'`, [id]))[0].n, 3);

  // Without a template, notes. Turned off in settings, nothing.
  const later = await ev(ann.id, "email.unsubscribed", { email_id: email, scope: "all" });
  await runActivity(opts, id);
  assert.equal(hs.notes.length, 1);
  assert.match(hs.notes[0].body, /Unsubscribed/);
  assert.equal((await q(`select status from activity_out where event_id = $1`, [later]))[0].status, "sent");
  await q(`update sources set settings = settings || '{"activity": false}' where id = $1`, [id]);
  await ev(ann.id, "email.sent", { email_id: email });
  await runActivity(opts, id);
  assert.equal(hs.notes.length, 1);
});

test("an activity job is queued when events arrive", async () => {
  await q(`update sources set settings = settings || '{"activity": true}', activity_at = now() where id = $1`, [id]);
  await q(`update contact_events set at = now() - interval '10 minutes' where workspace_id = $1`, [ws]);
  await q(`delete from jobs where kind = 'crm_activity'`);
  await q(`select sources_due()`);
  assert.equal((await q(`select count(*)::int n from jobs where kind = 'crm_activity' and key = $1`, [id]))[0].n, 0, "nothing new, no job");
  const ann = await local("ann@acme.com");
  await q(`insert into contact_events (workspace_id, contact_id, kind, data, source) values ($1, $2, 'email.sent', '{}', 'test')`, [ws, ann.id]);
  await q(`select sources_due()`);
  assert.equal((await q(`select count(*)::int n from jobs where kind = 'crm_activity' and key = $1`, [id]))[0].n, 1);
});
