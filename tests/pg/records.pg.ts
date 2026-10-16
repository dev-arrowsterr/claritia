// The records core (supabase/migrations/034_records.sql): which source wins, history, custom fields of every type,
// custom objects with links, filters over all of it matching the browser, bulk edits, merges, lists and board counts.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import pg from "pg";
import { uuid7 } from "../../collect/ids.ts";
import { writeContacts } from "../../src/lib/contacts/contacts.ts";
import type { ContactInput } from "../../src/lib/contacts/import.ts";
import { applyFilters, type Filter } from "../../src/lib/filters.ts";
import type { Rpc } from "../../src/lib/jobs.ts";
import { allFields, filterFields, type CustomField } from "../../src/lib/records/fields.ts";

const url = process.env.PG_URL;
if (!url) throw new Error("PG_URL is not set");
const pool = new pg.Pool({ connectionString: url, max: 4 });
const q = async (sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows;
after(() => pool.end());

const rpc: Rpc = async (fn, args) => {
  try {
    const r = await pool.query(`select contacts_upsert($1, $2, $3::jsonb, $4) as r`, [args.p_ws, args.p_source, JSON.stringify(args.p_rows), args.p_import]);
    return { data: r.rows[0].r, error: null };
  } catch (e) {
    return { data: null, error: { message: (e as Error).message } };
  }
};

async function workspace(name: string) {
  const ws = uuid7();
  const user = uuid7();
  await q(`insert into workspaces (id, name) values ($1, $2)`, [ws, name]);
  await q(`insert into auth.users (id, email) values ($1, $2)`, [user, `${user}@t.io`]);
  await q(`insert into workspace_members (workspace_id, user_id, role) values ($1, $2, 'owner')`, [ws, user]);
  return { ws, user };
}

async function as<T>(user: string, sql: string, params: unknown[] = []): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query(`select set_config('request.jwt.claim.sub', $1, false)`, [user]);
    return (await c.query(sql, params)).rows[0]?.r as T;
  } finally {
    await c.query(`select set_config('request.jwt.claim.sub', '', false)`);
    c.release();
  }
}

const contact = (email: string, v: Partial<ContactInput> = {}): ContactInput => ({ email, email_clean: email, email_class: "work", fields: {}, ...v });
const get = async (ws: string, email: string) => (await q(`select * from contacts where workspace_id = $1 and email_clean = $2 and deleted_at is null`, [ws, email]))[0];

test("which source wins: a file never overwrites the CRM, fills its blanks, and a person's edit beats both", async () => {
  const { ws, user } = await workspace("precedence");
  await writeContacts(rpc, ws, "hubspot", [contact("ann@acme.com", { title: "CEO", lifecycle: "customer", source_id: "hs-1" } as never)]);
  const imp = (await q(`select imports_start($1, $2, 'x.csv', '{}') as id`, [ws, user]))[0].id;
  const r = await writeContacts(rpc, ws, "csv", [contact("ann@acme.com", { title: "Intern", lifecycle: "lead", phone: "+1 555 0100" })], { importId: imp });
  assert.equal(r.updated, 1);
  let c = await get(ws, "ann@acme.com");
  assert.deepEqual([c.title, c.lifecycle, c.phone], ["CEO", "customer", "+1 555 0100"], "the import only filled the blank phone");
  assert.equal(c.field_sources.title.s, "hubspot");
  assert.equal(c.field_sources.phone.s, "csv");
  assert.equal(c.field_sources.phone.i, imp);
  assert.deepEqual(c.source_ids, { hubspot: "hs-1" });

  // The CRM changes its own value: it wins again (same class, newer).
  await writeContacts(rpc, ws, "salesforce", [contact("ann@acme.com", { title: "Founder" })]);
  c = await get(ws, "ann@acme.com");
  assert.equal(c.title, "Founder");

  // A person edits; then the CRM can't take it back by default (manual ranks first).
  await as(user, `select record_set('contact', $1, 'title', '"Chief Executive"') as r`, [c.id]);
  await writeContacts(rpc, ws, "hubspot", [contact("ann@acme.com", { title: "CEO again" })]);
  c = await get(ws, "ann@acme.com");
  assert.equal(c.title, "Chief Executive");
  assert.equal(c.field_sources.title.s, "manual");

  // The owner says title follows the CRM first.
  await as(user, `select field_order_save($1, 'contact', 'title', '{crm,manual,form,product,import,vendor,ai}') as r`, [ws]);
  await writeContacts(rpc, ws, "hubspot", [contact("ann@acme.com", { title: "CEO" })]);
  assert.equal((await get(ws, "ann@acme.com")).title, "CEO");

  // History has every change with its source, and the import's rows carry its id.
  const h = await q(`select key, old, new, source, import_id from field_history where record_id = $1 order by id`, [c.id]);
  assert.deepEqual(
    h.map((x) => `${x.key}:${x.old ?? "-"}>${x.new}:${x.source}`),
    ["phone:->+1 555 0100:csv", "title:CEO>Founder:salesforce", "title:Founder>Chief Executive:manual", "title:Chief Executive>CEO:hubspot"],
  );
  assert.equal(h[0].import_id, imp);
});

test("erased emails stay out of imports and syncs, but a person's own form brings them back", async () => {
  const { ws } = await workspace("erased");
  await q(`insert into erasures (workspace_id, value_hash) values ($1, sha256(convert_to('gone@x.com', 'UTF8')))`, [ws]);
  const imp = await rpc("contacts_upsert", { p_ws: ws, p_source: "csv", p_rows: [contact("gone@x.com"), contact("kept@x.com")], p_import: null });
  assert.equal((imp.data as { skipped_erased: number }).skipped_erased, 1);
  assert.equal(await get(ws, "gone@x.com"), undefined);
  await writeContacts(rpc, ws, "typeform", [contact("gone@x.com")]);
  assert.ok(await get(ws, "gone@x.com"), "they filled in a form themselves");
});

test("custom fields of every type, custom objects with links, and filters that match the browser", async () => {
  const { ws, user } = await workspace("objects");
  const sub = await as<{ key: string }>(user, `select object_save($1, '', 'Subscription', 'Subscriptions', 'box') as r`, [ws]);
  assert.equal(sub.key, "subscription");
  const add = (object: string, label: string, type: string, options: unknown[] = [], config = {}, required = false) =>
    as<CustomField>(user, `select field_add($1, $2, $3, $4, $5, $6, $7) as r`, [ws, object, label, type, JSON.stringify(options), JSON.stringify(config), required]);
  const plan = await add("subscription", "Plan", "select", [{ value: "pro", label: "Pro" }, { value: "free", label: "Free" }], {}, true);
  const seats = await add("subscription", "Seats", "number");
  const tags = await add("subscription", "Tags", "multi_select", ["beta", "vip", "partner"]);
  const renews = await add("subscription", "Renews", "date");
  const active = await add("subscription", "Active", "checkbox");
  const owner = await add("subscription", "Owner", "user");
  const site = await add("subscription", "Site", "url");
  const mrr = await add("subscription", "MRR", "currency", [], { currency: "EUR" });
  const buyer = await add("subscription", "Buyer", "relation", [], { target: "contact" });
  const custom = [plan, seats, tags, renews, active, owner, site, mrr, buyer];

  // Required and type checks.
  await assert.rejects(as(user, `select record_create($1, 'subscription', 'No plan', '{}') as r`, [ws]), /Plan is required/);
  await assert.rejects(as(user, `select record_create($1, 'subscription', 'Bad', '{"plan":"gold"}') as r`, [ws]), /pick one of its values/);
  await assert.rejects(as(user, `select record_create($1, 'subscription', 'Bad', '{"plan":"pro","seats":"lots"}') as r`, [ws]), /enter a number/);
  await assert.rejects(as(user, `select record_create($1, 'subscription', 'Bad', '{"plan":"pro","site":"javascript:alert(1)"}') as r`, [ws]), /web address/);
  await assert.rejects(as(user, `select record_create($1, 'subscription', 'Bad', $2) as r`, [ws, JSON.stringify({ plan: "pro", [owner.key]: "00000000-0000-0000-0000-000000000000" })]), /teammate/);

  const [buyer1] = (await writeContacts(rpc, ws, "manual", [contact("buyer@acme.com")])).ids;
  const ids: string[] = [];
  for (let i = 0; i < 24; i++) {
    const fields = {
      plan: i % 3 ? "pro" : "free",
      ...(i % 2 ? { seats: i * 3 } : {}),
      ...(i % 4 ? { tags: [["beta"], ["vip", "partner"], [], ["beta", "vip"]][i % 4] } : {}),
      ...(i % 5 ? { renews: i % 2 ? "2026-10-20" : "2025-01-01" } : {}),
      ...(i % 3 === 1 ? { active: true } : i % 3 === 2 ? { active: false } : {}),
      ...(i % 6 === 0 ? { [owner.key]: user } : {}),
      ...(i % 7 === 0 ? { mrr: 99.5 * i } : {}),
    };
    ids.push(await as<string>(user, `select record_create($1, 'subscription', $2, $3) as r`, [ws, `Sub ${String(i).padStart(2, "0")}`, JSON.stringify(fields)]));
  }
  for (const id of ids.slice(0, 5)) await as(user, `select record_set('subscription', $1, 'f.buyer', $2) as r`, [id, JSON.stringify([buyer1])]);
  await assert.rejects(as(user, `select record_set('subscription', $1, 'f.buyer', $2) as r`, [ids[0], JSON.stringify([buyer1, buyer1])]), /pick one record/);

  const people = [{ id: user, email: "me@t.io" }];
  const fields = allFields("subscription", custom, [], { people });
  const list = async (fs: Filter[], sort = "name", desc = false) =>
    as<{ total: number; rows: Record<string, unknown>[] }>(user, `select records_list($1, 'subscription', $2, $3, $4, 1000, 0) as r`, [ws, JSON.stringify(fs), sort, desc]);
  const all = (await list([])).rows;
  assert.equal(all.length, 24);
  assert.equal((all[0].links as Record<string, unknown[]>).buyer.length, 1, "links come with each row");
  const cases: Filter[][] = [
    [{ field: "f.plan", op: "is", values: ["free"] }],
    [{ field: "f.seats", op: "gte", values: ["30"] }],
    [{ field: "f.seats", op: "empty", values: [] }],
    [{ field: "f.tags", op: "is", values: ["vip"] }],
    [{ field: "f.tags", op: "is_not", values: ["beta"] }],
    [{ field: "f.tags", op: "empty", values: [] }],
    [{ field: "f.renews", op: "within", values: ["30"] }],
    [{ field: "f.active", op: "is", values: ["false"] }],
    [{ field: `f.${owner.key}`, op: "is", values: [user] }],
    [{ field: "f.mrr", op: "gte", values: ["500"] }],
    [{ field: "f.buyer", op: "is", values: [buyer1] }],
    [{ field: "f.buyer", op: "empty", values: [] }],
    [{ field: "name", op: "contains", values: ["1"] }],
    [{ field: "f.plan", op: "is", values: ["pro"] }, { field: "f.tags", op: "not_empty", values: [] }],
  ];
  for (const fs of cases) {
    const db = (await list(fs)).rows.map((r) => r.name);
    const browser = applyFilters(all, fs, filterFields(fields)).map((r) => r.name);
    assert.deepEqual(db, browser, JSON.stringify(fs));
  }
  // Sorting by a custom number puts blanks last.
  const bySeats = (await list([], "f.seats", true)).rows.map((r) => (r.fields as Record<string, number>).seats ?? null);
  assert.deepEqual(bySeats.slice(0, 3), [69, 63, 57]);
  assert.equal(bySeats.at(-1), null);
  // Board counts per pick list value.
  assert.deepEqual(await as(user, `select records_group_counts($1, 'subscription', '[]', 'f.plan') as r`, [ws]), { free: 8, pro: 16 });
  // The linked contact sees the backlink, and the record page has everything.
  const d = await as<{ links: Record<string, unknown[]>; record: { name: string } }>(user, `select record_detail($1) as r`, [ids[0]]);
  assert.equal(d.links.buyer.length, 1);
  // Removing a field removes its values.
  await as(user, `select field_delete($1, 'subscription', 'seats') as r`, [ws]);
  assert.equal((await q(`select count(*)::int n from records where object_id = (select id from objects where workspace_id = $1) and fields ? 'seats'`, [ws]))[0].n, 0);
});

test("bulk edits, merges, lists and the board for leads", async () => {
  const { ws, user } = await workspace("bulk");
  const { ids } = await writeContacts(rpc, ws, "csv", [
    contact("a@acme.com", { first_name: "A", company_domain: "acme.com" }),
    contact("b@acme.com", { title: "VP", company_domain: "acme.com" }),
    contact("c@acme.com", { company_domain: "acme.com" }),
    contact("dupe@acme.com", { phone: "123", lifecycle: "lead", company_domain: "acme.com" }),
  ]);
  const [a, b, c, dupe] = ids;
  assert.equal(await as(user, `select records_bulk_set($1, 'contact', $2, 'lead_status', '"new"') as r`, [ws, [a, b, c]]), 3);
  await as(user, `select record_set('contact', $1, 'lead_status', '"connected"') as r`, [c]);
  assert.deepEqual(await as(user, `select records_group_counts($1, 'contact', '[{"field":"lead_status","op":"not_empty","values":[]}]', 'lead_status') as r`, [ws]), {
    new: 2,
    connected: 1,
  });
  await assert.rejects(as(user, `select record_set('contact', $1, 'email', '"x@y.com"') as r`, [a]), /edit form/);
  await assert.rejects(as(user, `select record_set('contact', $1, 'owner', '"00000000-0000-0000-0000-000000000000"') as r`, [a]), /teammate/);
  await as(user, `select record_set('contact', $1, 'owner', $2) as r`, [a, JSON.stringify(user)]);

  // Merge: the kept contact fills its blanks; the other is marked and redirects.
  await as(user, `select contacts_merge($1, $2) as r`, [a, dupe]);
  const kept = await get(ws, "a@acme.com");
  assert.deepEqual([kept.first_name, kept.phone, kept.lifecycle], ["A", "123", "lead"]);
  assert.deepEqual(await as(user, `select contact_detail($1) as r`, [dupe]), { moved_to: a });

  // Lists: add, filter by list, remove.
  const list = await as<string>(user, `select list_add($1, null, 'Webinar', $2) as r`, [ws, [a, b]]);
  const inList = await as<{ total: number }>(user, `select records_list($1, 'contact', $2) as r`, [ws, JSON.stringify([{ field: "segment", op: "is", values: [list] }])]);
  assert.equal(inList.total, 2);
  await as(user, `select list_remove($1, $2, $3) as r`, [ws, list, [b]]);
  assert.equal((await q(`select count from segments where id = $1`, [list]))[0].count, 1);

  // Companies list and page.
  const companies = await as<{ total: number; rows: { name: string; contacts: number }[] }>(user, `select records_list($1, 'company', '[]', 'name', false) as r`, [ws]);
  assert.equal(companies.total, 1);
  assert.equal(companies.rows[0].contacts, 3);
  const page = await as<{ contacts: unknown[] }>(user, `select company_detail((select id from companies where workspace_id = $1)) as r`, [ws]);
  assert.equal(page.contacts.length, 3);
});
