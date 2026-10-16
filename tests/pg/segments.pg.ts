// Segments on a real database (docs/conversion-weeks.md week 8): 30 rule types against a hand-counted fixture,
// values that look like SQL, custom object joins, groups 3 deep, and a refresh that logs who joined and who left.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import pg from "pg";
import { uuid7 } from "../../collect/ids.ts";
import { writeContacts } from "../../src/lib/contacts/contacts.ts";
import { pgRpc } from "../../worker-intel/rpc.ts";

const url = process.env.PG_URL;
if (!url) throw new Error("PG_URL is not set");
const pool = new pg.Pool({ connectionString: url, max: 4 });
const q = async (sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows;
after(() => pool.end());
const rpc = pgRpc(pool);

let ws = "";
let user = "";
let s1 = "";
let hubspot = "";
const id: Record<string, string> = {};

async function asUser<T>(sql: string, params: unknown[]): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query(`select set_config('request.jwt.claim.sub', $1, false)`, [user]);
    await c.query("set role authenticated");
    return (await c.query(sql, params)).rows[0].r as T;
  } finally {
    await c.query("reset role");
    await c.query(`select set_config('request.jwt.claim.sub', '', false)`);
    c.release();
  }
}
const preview = (rules: unknown) => asUser<{ count: number; sample: { email: string }[] }>(`select segment_preview($1, $2) as r`, [ws, JSON.stringify(rules)]);
const who = async (rules: unknown) => {
  const r = await preview(rules);
  const names = r.sample.map((x) => x.email.split("@")[0]).sort();
  assert.equal(r.count, names.length);
  return names;
};
const and = (...rules: unknown[]) => ({ op: "and", rules });
const or = (...rules: unknown[]) => ({ op: "or", rules });
const field = (f: string, op: string, values: unknown[] = []) => ({ kind: "field", field: f, op, values });

before(async () => {
  ws = uuid7();
  user = uuid7();
  await q(`insert into workspaces (id, name) values ($1, 'segments')`, [ws]);
  await q(`insert into auth.users (id, email) values ($1, $2)`, [user, `${user}@t.io`]);
  await q(`insert into workspace_members (workspace_id, user_id, role) values ($1, $2, 'owner')`, [ws, user]);
  for (const [label, type, options] of [
    ["Plan", "select", [{ value: "pro", label: "Pro" }, { value: "free", label: "Free" }]],
    ["Interests", "multi_select", ["Pricing", "Security"]],
    ["Budget", "currency", []],
  ] as const) {
    if (!(await q(`select 1 from fields where workspace_id = $1 and key = $2`, [ws, label.toLowerCase()])).length)
      await q(`insert into fields (workspace_id, object, key, label, type, options) values ($1, 'contact', $2, $3, $4, $5)`, [ws, label.toLowerCase(), label, type, JSON.stringify(options)]);
  }
  const people = [
    { n: "jane", email: "jane@acme.com", title: "CEO", lifecycle: "customer", country: "US", company_domain: "acme.com", company_name: "Acme", fields: { plan: "pro", interests: ["Pricing"], budget: 50000 }, basis: "opt_in" },
    { n: "raj", email: "raj@globex.io", title: "CTO", lifecycle: "lead", country: "GB", company_domain: "globex.io", company_name: "Globex", fields: { plan: "free" }, basis: "legitimate_interest" },
    { n: "ana", email: "ana@initech.co", lifecycle: "mql", country: "DE", fields: { plan: "pro" } },
    { n: "tom", email: "tom@acme.com", title: "VP Sales", lifecycle: "lead", country: "US", company_domain: "acme.com", company_name: "Acme", fields: { budget: 10000 }, basis: "opt_in" },
    { n: "mia", email: "mia@gmail.com", lifecycle: "subscriber", fields: {}, basis: "opt_in", email_class: "free" },
    { n: "gone", email: "gone@acme.com", lifecycle: "lead", country: "US", fields: {}, basis: "opt_in" },
  ];
  await writeContacts(
    rpc,
    ws,
    "csv",
    people.map((p) => ({ email: p.email, email_clean: p.email, email_class: p.email_class ?? "work", title: p.title, lifecycle: p.lifecycle, country: p.country, company_domain: p.company_domain, company_name: p.company_name, fields: p.fields, basis: p.basis as never })),
  );
  for (const r of await q(`select id, email_clean from contacts where workspace_id = $1`, [ws])) id[String(r.email_clean).split("@")[0]] = r.id;
  await q(`update contacts set deleted_at = now() where id = $1`, [id.gone]);
  await q(`update companies set industry = 'Software' where workspace_id = $1 and domain = 'acme.com'`, [ws]);
  await q(`update companies set industry = 'Finance' where workspace_id = $1 and domain = 'globex.io'`, [ws]);
  await q(`select suppress($1, 'csv', '[{"email_clean":"raj@globex.io","reason":"unsubscribed"}]')`, [ws]);

  // Events: Jane clicked 3 times this week, Raj once 20 days ago, Ana went to a webinar.
  for (const [who, kind, daysAgo] of [["jane", "email.clicked", 1], ["jane", "email.clicked", 2], ["jane", "email.clicked", 5], ["raj", "email.clicked", 20], ["ana", "webinar.attended", 30]] as const)
    await q(`insert into contact_events (workspace_id, contact_id, kind, source, at) values ($1, $2, $3, 'test', now() - make_interval(days => $4))`, [ws, id[who], kind, daysAgo]);

  // Visits: Jane read /pricing twice, Raj a blog post.
  const site = (await q(`insert into sites (workspace_id, domain) values ($1, 'segments-site.com') returning id`, [ws]))[0].id;
  for (const [who, paths] of [["jane", ["/pricing", "/pricing", "/"]], ["raj", ["/blog/how-to"]]] as const) {
    const person = uuid7();
    await q(`insert into persons (id, workspace_id) values ($1, $2)`, [person, ws]);
    await q(`update contacts set person_id = $1 where id = $2`, [person, id[who]]);
    const s = uuid7();
    await q(`insert into sessions (id, workspace_id, site_id, started_at, ended_at, policy, cookieless_key, person_id, pageviews) values ($1, $2, $3, now(), now(), 'notice', '\\x01', $4, $5)`, [s, ws, site, person, paths.length]);
    for (const path of paths) await q(`insert into events (id, workspace_id, session_id, day, kind, path) values ($1, $2, $3, current_date, 'view', $4)`, [uuid7(), ws, s, path]);
  }

  // A static list with Ana, and a HubSpot link for Jane.
  s1 = (await q(`insert into segments (workspace_id, name, kind) values ($1, 'Webinar list', 'static') returning id`, [ws]))[0].id;
  await q(`insert into segment_members (workspace_id, segment_id, contact_id) values ($1, $2, $3)`, [ws, s1, id.ana]);
  hubspot = (await q(`insert into sources (workspace_id, kind, name) values ($1, 'hubspot', 'HubSpot') returning id`, [ws]))[0].id;
  await q(`insert into source_links (workspace_id, source_id, object, external_id, local_id) values ($1, $2, 'contact', '101', $3)`, [ws, hubspot, id.jane]);

  // Subscriptions: Jane has 10 seats, Tom 2. The link is a relation field on the subscription.
  const obj = (await q(`insert into objects (workspace_id, key, label, plural) values ($1, 'subscription', 'Subscription', 'Subscriptions') returning id`, [ws]))[0].id;
  await q(`insert into fields (workspace_id, object, key, label, type) values ($1, 'subscription', 'seats', 'Seats', 'number')`, [ws]);
  const buyer = (await q(`insert into fields (workspace_id, object, key, label, type, config) values ($1, 'subscription', 'buyer', 'Buyer', 'relation', '{"target":"contact"}') returning id`, [ws]))[0].id;
  for (const [who, seats] of [["jane", 10], ["tom", 2]] as const) {
    const r = (await q(`insert into records (workspace_id, object_id, name, fields) values ($1, $2, $3, $4) returning id`, [ws, obj, `${who} sub`, JSON.stringify({ seats })]))[0].id;
    await q(`insert into record_links (workspace_id, field_id, from_object, from_id, to_object, to_id) values ($1, $2, 'subscription', $3, 'contact', $4)`, [ws, buyer, r, id[who]]);
  }
});

test("30 rule types match the hand count", async () => {
  const cases: [string, unknown, string[]][] = [
    ["title is", field("title", "is", ["ceo"]), ["jane"]],
    ["title contains", field("title", "contains", ["c"]), ["jane", "raj"]],
    ["stage is", field("lifecycle", "is", ["lead"]), ["raj", "tom"]],
    ["stage is not", field("lifecycle", "is_not", ["lead"]), ["ana", "jane", "mia"]],
    ["country", field("country", "is", ["US"]), ["jane", "tom"]],
    ["company", field("company", "is", ["acme"]), ["jane", "tom"]],
    ["industry", field("industry", "is", ["Software"]), ["jane", "tom"]],
    ["email kind", field("email_class", "is", ["free"]), ["mia"]],
    ["custom pick list", field("f.plan", "is", ["pro"]), ["ana", "jane"]],
    ["custom multi pick", field("f.interests", "is", ["Pricing"]), ["jane"]],
    ["custom number at least", field("f.budget", "gte", ["20000"]), ["jane"]],
    ["custom number at most", field("f.budget", "lte", ["20000"]), ["tom"]],
    ["custom empty", field("f.budget", "empty"), ["ana", "mia", "raj"]],
    ["created this week", field("created_at", "within", ["7"]), ["ana", "jane", "mia", "raj", "tom"]],
    ["in a list", field("segment", "is", [s1]), ["ana"]],
    ["not in a list", field("segment", "is_not", [s1]), ["jane", "mia", "raj", "tom"]],
    ["clicked 2+ times in 7 days", { kind: "event", event: "email.clicked", op: "at_least", count: 2, days: 7 }, ["jane"]],
    ["clicked in 30 days", { kind: "event", event: "email.clicked", op: "at_least", count: 1, days: 30 }, ["jane", "raj"]],
    ["no click in 7 days", { kind: "event", event: "email.clicked", op: "none", days: 7 }, ["ana", "mia", "raj", "tom"]],
    ["attended a webinar", { kind: "event", event: "webinar.attended", op: "at_least", count: 1, days: 90 }, ["ana"]],
    ["read pricing twice", { kind: "visit", path: "/pricing", op: "at_least", count: 2, days: 7 }, ["jane"]],
    ["read the blog", { kind: "visit", path: "/blog/*", op: "at_least", count: 1, days: 7 }, ["raj"]],
    ["no visit", { kind: "visit", op: "none", days: 30 }, ["ana", "mia", "tom"]],
    ["can be emailed", { kind: "consent", state: "sendable" }, ["jane", "mia", "tom"]],
    ["can't be emailed", { kind: "consent", state: "not_sendable" }, ["ana", "raj"]],
    ["unsubscribed", { kind: "consent", state: "suppressed" }, ["raj"]],
    ["from HubSpot", { kind: "source", source_id: hubspot, op: "in" }, ["jane"]],
    ["not from HubSpot", { kind: "source", source_id: hubspot, op: "not_in" }, ["ana", "mia", "raj", "tom"]],
    ["subscription with 5+ seats", { kind: "object", object: "subscription", op: "has", filters: [{ field: "f.seats", op: "gte", values: ["5"] }] }, ["jane"]],
    ["any subscription", { kind: "object", object: "subscription", op: "has", filters: [] }, ["jane", "tom"]],
    ["no subscription", { kind: "object", object: "subscription", op: "has_not", filters: [] }, ["ana", "mia", "raj"]],
    ["customers or Germany", or(field("lifecycle", "is", ["customer"]), field("country", "is", ["DE"])), ["ana", "jane"]],
    ["US and (CEO or small budget)", and(field("country", "is", ["US"]), or(field("title", "is", ["ceo"]), field("f.budget", "lte", ["20000"]))), ["jane", "tom"]],
    ["three levels", and(or(and(field("country", "is", ["US"]), field("f.plan", "is", ["pro"])), field("country", "is", ["DE"]))), ["ana", "jane"]],
    ["empty group is everyone", and(), ["ana", "jane", "mia", "raj", "tom"]],
  ];
  for (const [name, rule, want] of cases) assert.deepEqual(await who((rule as { op?: string }).op ? rule : and(rule)), want, name);
  assert.ok(cases.length >= 30);
});

test("values that look like SQL are only values, and bad trees are refused", async () => {
  for (const v of ["'; drop table contacts; --", "%", "_", "\\", "$2", "') or true --"]) {
    assert.deepEqual(await who(and(field("title", "is", [v]))), [], v);
    assert.deepEqual(await who(and(field("title", "contains", [v]))), [], `contains ${v}`);
    assert.deepEqual(await who(and({ kind: "visit", path: v, op: "at_least", count: 1, days: 7 })), [], `visit ${v}`);
  }
  assert.equal((await q(`select count(*)::int n from contacts where workspace_id = $1`, [ws]))[0].n, 6);
  await assert.rejects(preview(and(and(and(and(field("country", "is", ["US"])))))), /3 levels/);
  await assert.rejects(preview(and({ kind: "event", event: "x'; --", op: "at_least", days: 7 })), /Pick an event/);
  await assert.rejects(preview(and({ kind: "field", field: "password", op: "is", values: ["x"] })), /Unknown filter field/);
  await assert.rejects(preview(and({ kind: "object", object: "nope", op: "has" })), /Pick an object/);
  await assert.rejects(preview(and({ kind: "source", source_id: uuid7(), op: "in" })), /Pick a source/);
  await assert.rejects(preview(and({ kind: "drop" })), /Unknown rule/);
  // Another workspace can't preview this one.
  const other = uuid7();
  await q(`insert into auth.users (id, email) values ($1, $2)`, [other, `${other}@t.io`]);
  const c = await pool.connect();
  try {
    await c.query(`select set_config('request.jwt.claim.sub', $1, false)`, [other]);
    await c.query("set role authenticated");
    await assert.rejects(c.query(`select segment_preview($1, '{"op":"and","rules":[]}')`, [ws]), /Workspace not found/);
  } finally {
    await c.query("reset role");
    await c.query(`select set_config('request.jwt.claim.sub', '', false)`);
    c.release();
  }
});

test("a saved segment refreshes: who joined and who left are events, and a second refresh changes nothing", async () => {
  const sid = await asUser<string>(`select segment_save($1, null, 'US leads', $2) as r`, [ws, JSON.stringify(and(field("country", "is", ["US"])))]);
  assert.equal((await q(`select count(*)::int n from jobs where kind = 'segment_refresh' and key = $1`, [sid]))[0].n, 1);
  assert.deepEqual((await q(`select segment_refresh($1) r`, [sid]))[0].r, { joined: 2, left: 0 });
  assert.deepEqual((await q(`select segment_refresh($1) r`, [sid]))[0].r, { joined: 0, left: 0 });
  await q(`select contact_update($1, 'manual', '{"country":"DE"}')`, [id.tom]);
  await q(`select contact_update($1, 'manual', '{"country":"US"}')`, [id.ana]);
  assert.deepEqual((await q(`select segment_refresh($1) r`, [sid]))[0].r, { joined: 1, left: 1 });
  const ev = await q(`select c.email_clean, e.kind from contact_events e join contacts c on c.id = e.contact_id where e.workspace_id = $1 and e.kind like 'segment.%' order by e.at, c.email_clean`, [ws]);
  assert.deepEqual(ev.map((r) => `${r.email_clean.split("@")[0]}:${r.kind}`), ["jane:segment.entered", "tom:segment.entered", "ana:segment.entered", "tom:segment.left"]);
  assert.equal((await q(`select count from segments where id = $1`, [sid]))[0].count, 2);
  // Tom comes back: entered again.
  await q(`select contact_update($1, 'manual', '{"country":"US"}')`, [id.tom]);
  assert.deepEqual((await q(`select segment_refresh($1) r`, [sid]))[0].r, { joined: 1, left: 0 });
  // Hourly: due segments queue a refresh.
  await q(`update segments set refreshed_at = now() - interval '2 hours' where id = $1`, [sid]);
  await q(`delete from jobs where kind = 'segment_refresh'`);
  assert.ok((await q(`select segments_due() n`))[0].n >= 1);
  assert.equal((await q(`select count(*)::int n from jobs where kind = 'segment_refresh' and key = $1`, [sid]))[0].n, 1);
});
