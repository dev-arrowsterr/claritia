// Sources on a real database (docs/conversion-weeks.md week 3): HubSpot two-way through 1,000 random changes on
// both sides, with dropped and repeated webhooks, 429s and an expired token. Both sides end equal, nothing is
// doubled, and once settled another round writes nothing either way (no echo loops).
import assert from "node:assert/strict";
import { after, test } from "node:test";
import pg from "pg";
import { uuid7 } from "../../collect/ids.ts";
import { writeContacts } from "../../src/lib/contacts/contacts.ts";
import { lifecycleOf } from "../../src/lib/contacts/fields.ts";
import { seal } from "../../src/lib/seal.ts";
import { hubspot } from "../../src/lib/sources/hubspot.ts";
import { runHooks, runPull, type RunOpts } from "../../src/lib/sources/run.ts";
import { pgRpc } from "../../worker-intel/rpc.ts";
import { ctxFor } from "../../worker-intel/jobs/imports.ts";
import { FakeHubspot, rng } from "../sources/fakeHubspot.ts";

process.env.SECRETS_KEY ||= "test-secrets-key-that-is-long-enough-1234";
const url = process.env.PG_URL;
if (!url) throw new Error("PG_URL is not set");
const pool = new pg.Pool({ connectionString: url, max: 4 });
const q = async (sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows;
after(() => pool.end());
const rpc = pgRpc(pool);
const CHANGES = Number(process.env.SYNC_TEST_CHANGES || 1000);

async function workspace(name: string) {
  const ws = uuid7();
  const user = uuid7();
  await q(`insert into workspaces (id, name) values ($1, $2)`, [ws, name]);
  await q(`insert into auth.users (id, email) values ($1, $2)`, [user, `${user}@t.io`]);
  await q(`insert into workspace_members (workspace_id, user_id, role) values ($1, $2, 'owner')`, [ws, user]);
  return { ws, user };
}

const FIRST = ["Ana", "Ben", "Cleo", "Dev", "Eve", "Finn", "Gia", "Hal"];
const TITLES = ["CEO", "CTO", "VP Marketing", "Head of Growth", "Engineer", "Analyst"];
const STAGES = ["lead", "marketingqualifiedlead", "salesqualifiedlead", "customer"];
const PHONES = ["+14155550132", "+442071838750", "+4930901820"];

test(`HubSpot two-way: ${CHANGES} random changes on both sides end equal, with no doubles and no echoes`, async () => {
  const random = rng(Number(process.env.SYNC_TEST_SEED || 42));
  const pick = <T>(a: T[]) => a[Math.floor(random() * a.length)];
  const { ws, user } = await workspace("hubspot-sync");
  const hs = new FakeHubspot(random, { rate429: 0.05, portal: 777 });

  // Before: 150 people in HubSpot, 60 here from a file (half are leads), 20 of them in both.
  for (let i = 0; i < 150; i++) hs.create({ email: `p${i}@acme${i % 9}.com`, firstname: pick(FIRST), lastname: `L${i}`, jobtitle: pick(TITLES), lifecyclestage: pick(STAGES) }, true);
  await writeContacts(
    rpc,
    ws,
    "csv",
    Array.from({ length: 60 }, (_, i) => {
      const n = i < 20 ? i : 200 + i;
      return { email: `p${n}@acme${n % 9}.com`, email_clean: `p${n}@acme${n % 9}.com`, email_class: "work", first_name: pick(FIRST), title: pick(TITLES), lifecycle: i % 2 ? "lead" : undefined, fields: {} };
    }),
  );

  const creds = { type: "oauth", access: "t1", refresh: "r1", expiresAt: Date.now() + 3_600_000 };
  const id = (await q(`select source_connect($1, $2, 'hubspot', 'HubSpot', '777', $3, $4) as id`, [
    ws,
    user,
    seal(JSON.stringify(creds)),
    JSON.stringify({ objects: { contacts: "both", companies: "off", lists: "off" }, push_new: "lifecycle", basis: "legitimate_interest" }),
  ]))[0].id as string;

  const opts: RunOpts = {
    rpc,
    clean: (w) => ctxFor(pool, w),
    fetcher: hs.fetch,
    sleep: async () => {},
    refresh: async () => {
      const r = await hs.fetch("https://api.hubapi.com/oauth/v1/token", { method: "POST" });
      const t = (await r.json()) as { access_token: string };
      return { access: t.access_token, refresh: "r1", expiresAt: Date.now() + 1_800_000 };
    },
  };
  const deliver = async () => {
    for (const body of hs.takeEvents()) {
      const roll = random();
      if (roll < 0.2) continue; // dropped
      for (const e of hubspot.parse!([body], new Headers())) {
        await q(`select hook_stage($1, $2, $3)`, [id, e.dedupe, JSON.stringify(e)]);
        if (roll > 0.9) await q(`select hook_stage($1, $2, $3)`, [id, e.dedupe, JSON.stringify(e)]); // repeated
      }
    }
    await runHooks(opts, id);
  };
  const settle = async () => {
    for (let i = 0; i < 6; i++) {
      for (let more = true; more; ) more = !!(await runPull(opts, id))?.more;
      await deliver();
    }
  };

  await settle();
  const local = async () => (await q(`select id, email_clean, first_name, title, phone, lifecycle from contacts where workspace_id = $1 and deleted_at is null`, [ws])) as Record<string, string>[];

  // 1,000 changes on both sides.
  for (let i = 0; i < CHANGES; i++) {
    const r = random();
    const remote = hs.live();
    if (r < 0.35 && remote.length) {
      const c = pick(remote);
      const what = random();
      hs.edit(c.id, what < 0.4 ? { jobtitle: pick(TITLES) } : what < 0.7 ? { firstname: pick(FIRST) } : what < 0.85 ? { phone: pick(PHONES) } : { lifecyclestage: pick(STAGES) });
    } else if (r < 0.42) hs.create({ email: `new${i}@co${i % 7}.com`, firstname: pick(FIRST), jobtitle: pick(TITLES), lifecyclestage: "lead" });
    else if (r < 0.45 && remote.length > 50) hs.remove(pick(remote).id);
    else if (r < 0.47 && remote.length > 50) {
      const [a, b] = [pick(remote), pick(remote)];
      if (a.id !== b.id) hs.merge(a.id, b.id);
    } else if (r < 0.49 && remote.length) {
      const c = pick(remote);
      if (!hs.live().some((x) => x.properties.email === `moved${i}@acme.com`)) hs.edit(c.id, { email: `moved${i}@acme.com` });
    } else if (r < 0.85) {
      const rows = await local();
      const c = pick(rows);
      const what = random();
      await q(`select contact_update($1, 'manual', $2)`, [c.id, JSON.stringify(what < 0.5 ? { title: pick(TITLES) } : what < 0.8 ? { first_name: pick(FIRST) } : { lifecycle: pick(["lead", "mql", "sql", "customer"]) })]);
    } else {
      await writeContacts(rpc, ws, "form", [{ email: `form${i}@site${i % 5}.com`, email_clean: `form${i}@site${i % 5}.com`, email_class: "work", first_name: pick(FIRST), lifecycle: "lead", fields: {} }]);
    }
    if (i % 40 === 39) {
      if (random() < 0.5) await deliver();
      else await runPull(opts, id);
    }
    // The token expires now and then.
    if (i % 300 === 150) hs.token = "rotated";
  }
  await settle();

  // Nothing doubled on either side.
  const rows = await local();
  assert.equal(new Set(rows.map((r) => r.email_clean)).size, rows.length, "one contact per email here");
  const live = hs.live();
  const emails = live.map((c) => c.properties.email);
  assert.equal(new Set(emails).size, emails.length, "one contact per email in HubSpot");

  // Every HubSpot contact is linked here, and its values match.
  const links = new Map(
    ((await q(`select external_id, local_id from source_links where source_id = $1 and object = 'contact' and deleted_at is null`, [id])) as { external_id: string; local_id: string }[]).map((l) => [
      l.external_id,
      l.local_id,
    ]),
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  let compared = 0;
  for (const c of live) {
    const mine = byId.get(links.get(c.id) ?? "");
    assert.ok(mine, `HubSpot contact ${c.id} (${c.properties.email}) is linked`);
    assert.equal(mine.email_clean, c.properties.email);
    assert.equal(mine.title ?? null, c.properties.jobtitle ?? null, `title of ${c.properties.email}`);
    assert.equal(mine.first_name ?? null, c.properties.firstname ?? null, `first name of ${c.properties.email}`);
    assert.equal(mine.phone ?? null, c.properties.phone ?? null, `phone of ${c.properties.email}`);
    assert.equal(mine.lifecycle ?? null, c.properties.lifecyclestage ? (lifecycleOf(c.properties.lifecyclestage) ?? null) : null, `stage of ${c.properties.email}`);
    compared++;
  }
  assert.ok(compared > 150);
  // Leads made here went to HubSpot.
  // Leads made here went to HubSpot, except those HubSpot deleted or merged away (a deletion there stands).
  const leads = rows.filter((r) => r.lifecycle && r.lifecycle !== "subscriber");
  const linkedLocal = new Set(links.values());
  const letGo = new Set(((await q(`select local_id from source_links where source_id = $1 and deleted_at is not null`, [id])) as { local_id: string }[]).map((l) => l.local_id));
  assert.deepEqual(leads.filter((r) => !linkedLocal.has(r.id) && !letGo.has(r.id)).map((r) => r.email_clean), [], "every lead here is in HubSpot");

  // Settled: another full round writes nothing and logs nothing.
  const writes = hs.writes;
  const logged = (await q(`select count(*)::int n from sync_log where source_id = $1`, [id]))[0].n;
  await settle();
  assert.equal(hs.writes, writes, "no writes to HubSpot once settled");
  assert.equal((await q(`select count(*)::int n from sync_log where source_id = $1`, [id]))[0].n, logged, "no log rows once settled");
  assert.ok(hs.throttled > 0, "429s were hit and retried");
  const src = (await q(`select status, errors_in_row from sources where id = $1`, [id]))[0];
  assert.equal(src.status, "active");
  // A log row is a change: no update row names no field.
  assert.equal((await q(`select count(*)::int n from sync_log where source_id = $1 and action = 'update' and cardinality(fields) = 0`, [id]))[0].n, 0);
});

test("a form webhook delivered twice makes one contact with the form's consent; a paused source holds its hooks", async () => {
  const { ws, user } = await workspace("hooks");
  const id = (await q(`select source_connect($1, $2, 'typeform', 'Typeform', '', $3, $4) as id`, [ws, user, seal(JSON.stringify({ type: "hook" })), JSON.stringify({ objects: { contacts: "in" }, basis: "opt_in" })]))[0].id as string;
  const body = { form_response: { token: "t1", definition: { fields: [{ id: "f1", title: "Company" }] }, answers: [{ type: "email", email: "Jane@Acme.com", field: { id: "f0" } }, { type: "text", text: "Acme", field: { id: "f1" } }] } };
  const { typeform } = await import("../../src/lib/sources/forms.ts");
  for (let i = 0; i < 2; i++) for (const e of typeform.parse!(body, new Headers())) await q(`select hook_stage($1, $2, $3)`, [id, e.dedupe, JSON.stringify(e)]);
  assert.equal((await q(`select count(*)::int n from hook_events where source_id = $1`, [id]))[0].n, 1, "staged once");
  assert.equal((await q(`select count(*)::int n from jobs where kind = 'source_hook' and key = $1`, [id]))[0].n, 1);
  const opts: RunOpts = { rpc, clean: (w) => ctxFor(pool, w), sleep: async () => {} };
  assert.equal(await runHooks(opts, id), 1);
  const c = (await q(`select c.id, c.email_clean, co.name company, (select basis from consents k where k.contact_id = c.id order by at desc limit 1) basis from contacts c left join companies co on co.id = c.company_id where c.workspace_id = $1`, [ws]))[0];
  assert.deepEqual([c.email_clean, c.company, c.basis], ["jane@acme.com", "Acme", "opt_in"]);
  assert.equal((await q(`select action from sync_log where source_id = $1`, [id]))[0].action, "create");
  // Run again: nothing new, nothing logged.
  assert.equal(await runHooks(opts, id), 0);
  assert.equal((await q(`select count(*)::int n from sync_log where source_id = $1`, [id]))[0].n, 1);
  // A paused source stages but doesn't apply.
  await q(`update sources set status = 'paused' where id = $1`, [id]);
  for (const e of typeform.parse!({ form_response: { ...body.form_response, token: "t2", answers: [{ type: "email", email: "bob@acme.com", field: { id: "f0" } }] } }, new Headers()))
    await q(`select hook_stage($1, $2, $3)`, [id, e.dedupe, JSON.stringify(e)]);
  assert.equal(await runHooks(opts, id), 0);
  assert.equal((await q(`select count(*)::int n from contacts where workspace_id = $1`, [ws]))[0].n, 1);
});

test("a warehouse query feeds contacts, activity and a custom object, reads on from its cursor, and can't write", async () => {
  const { ws, user } = await workspace("warehouse");
  // The "warehouse": tables in their own schema of this database.
  await q(`create schema if not exists wh`);
  await q(`create table wh.users (email text, first_name text, plan text, updated_at timestamptz)`);
  await q(`create table wh.usage (id text, email text, feature text, at timestamptz)`);
  await q(`create table wh.subs (sub_id text, email text, name text, seats int, changed_at timestamptz)`);
  await q(`insert into wh.users select 'u' || i || '@acme' || (i % 4) || '.com', 'Name' || i, case when i % 2 = 0 then 'pro' else 'free' end, now() - make_interval(hours => 100 - i) from generate_series(1, 12) i`);
  await q(`insert into wh.usage values ('e1', 'u1@acme1.com', 'export', now() - interval '2 days'), ('e2', 'u2@acme2.com', 'invite', now() - interval '1 day'), ('e3', 'nobody@x.com', 'export', now())`);
  const obj = (await q(`insert into objects (workspace_id, key, label, plural) values ($1, 'subscription', 'Subscription', 'Subscriptions') returning id`, [ws]))[0].id;
  await q(`insert into fields (workspace_id, object, key, label, type) values ($1, 'subscription', 'seats', 'Seats', 'number')`, [ws]);
  await q(`insert into fields (workspace_id, object, key, label, type, config) values ($1, 'subscription', 'buyer', 'Buyer', 'relation', '{"target":"contact"}')`, [ws]);
  await q(`insert into wh.subs values ('s1', 'u1@acme1.com', 'Acme Pro', 10, now() - interval '1 day'), ('s2', 'U2@Acme2.com', 'Acme Team', 3, now())`);

  const dbName = new URL(url!).pathname.slice(1);
  const creds = { type: "key", values: { host: "localhost", port: "5432", database: dbName, user: "postgres", password: "", ssl: "disable" } };
  const connect = async (kind: string, query: Record<string, string>) => {
    await q(`delete from sources where workspace_id = $1 and kind = $2`, [ws, kind]);
    return (await q(`select source_connect($1, $2, $3, $3, 'local', $4, $5) as id`, [ws, user, kind, seal(JSON.stringify(creds)), JSON.stringify({ basis: "legitimate_interest", query })]))[0].id as string;
  };
  const opts: RunOpts = { rpc, clean: (w) => ctxFor(pool, w), sleep: async () => {}, local: true };

  // Contacts, read in pages by the cursor.
  const users = await connect("postgres", { sql: "select email, first_name, plan, updated_at from wh.users where updated_at >= :cursor", key: "email", cursor: "updated_at", target: "contacts" });
  await runPull(opts, users);
  assert.equal((await q(`select count(*)::int n from contacts where workspace_id = $1`, [ws]))[0].n, 12);
  const cursor1 = (await q(`select cursors->>'contacts' c from sources where id = $1`, [users]))[0].c;
  assert.ok(cursor1, "the cursor is kept");
  await q(`insert into wh.users values ('late@acme1.com', 'Late', 'pro', now())`);
  await q(`update wh.users set first_name = 'Renamed', updated_at = now() where email = 'u3@acme3.com'`);
  const logged = (await q(`select count(*)::int n from sync_log where source_id = $1`, [users]))[0].n;
  await runPull(opts, users);
  assert.equal((await q(`select count(*)::int n from contacts where workspace_id = $1`, [ws]))[0].n, 13);
  assert.equal((await q(`select first_name from contacts where workspace_id = $1 and email_clean = 'u3@acme3.com'`, [ws]))[0].first_name, "Renamed");
  assert.equal((await q(`select count(*)::int n from sync_log where source_id = $1`, [users]))[0].n - logged, 2, "only the two changed rows are logged; the overlap is skipped");

  // Activity: a replay adds nothing; a row for someone who isn't a contact is skipped.
  const usage = await connect("redshift", { sql: "select id, email, feature, at from wh.usage where at >= :cursor", key: "id", cursor: "at", target: "events", event: "product.used" });
  await runPull(opts, usage);
  await q(`update sources set cursors = '{}' where id = $1`, [usage]);
  await runPull(opts, usage);
  const ev = await q(`select c.email_clean, e.kind, e.data->>'feature' f from contact_events e join contacts c on c.id = e.contact_id where e.workspace_id = $1 and e.kind = 'product.used' order by 1`, [ws]);
  assert.deepEqual(ev.map((r) => `${r.email_clean}:${r.f}`), ["u1@acme1.com:export", "u2@acme2.com:invite"]);

  // A custom object, linked to its buyer.
  const subs = await connect("postgres", { sql: "select sub_id, email, name, seats, changed_at from wh.subs where changed_at >= :cursor", key: "sub_id", cursor: "changed_at", target: "object:subscription" });
  await runPull(opts, subs);
  await runPull(opts, subs);
  const recs = await q(`select r.name, r.fields->>'seats' seats, (select c.email_clean from record_links l join contacts c on c.id = l.to_id where l.from_id = r.id) buyer from records r where r.object_id = $1 order by r.name`, [obj]);
  assert.deepEqual(recs.map((r) => `${r.name}:${r.seats}:${r.buyer}`), ["Acme Pro:10:u1@acme1.com", "Acme Team:3:u2@acme2.com"]);

  // Two statements, or a write hidden in a WITH, never run; a write the checks miss is stopped by the read-only transaction.
  const { runQuery } = await import("../../src/lib/sources/warehouse.ts");
  const { makeCtx } = await import("../../src/lib/sources/ctx.ts");
  const ctx = makeCtx({ source: { id: subs, workspace_id: ws, kind: "postgres", name: "pg", account: null, status: "active", settings: {}, cursors: {}, push_cursor: null }, creds: creds as never, local: true });
  await assert.rejects(runQuery(ctx, { sql: "select 1 as k, now() as c; delete from wh.users", key: "k", cursor: "c", target: "contacts" }, "x"), /One statement only/);
  await assert.rejects(runQuery(ctx, { sql: "with x as (delete from wh.users returning *) select * from x", key: "email", cursor: "updated_at", target: "contacts" }, "x"), /Only reading/);
  await q(`create or replace function wh.wipe() returns int language sql as 'delete from wh.users returning 1'`);
  await assert.rejects(runQuery(ctx, { sql: "select email, updated_at, wh.wipe() as w from wh.users", key: "email", cursor: "updated_at", target: "contacts" }, "x"), /read-only transaction/);
  assert.equal((await q(`select count(*)::int n from wh.users`))[0].n, 13, "nothing was deleted");
  await q(`drop schema wh cascade`);
});
