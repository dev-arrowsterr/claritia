// Contacts week 1 on a real database (docs/conversion-parity.md Part 14): a 10,000-row import with dedupe, batches
// sent twice and imports at once, filters that mean the same in the database and the browser, and contacts that
// follow their identity person through merges, rebuilds and erasure.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import pg from "pg";
import { uuid7 } from "../../collect/ids.ts";
import { writeContacts } from "../../src/lib/contacts/contacts.ts";
import { parseCsv, toCsv } from "../../src/lib/contacts/csv.ts";
import { contactFilterFields, type ContactRow, type CustomField } from "../../src/lib/contacts/fields.ts";
import { prepareImport, type ContactInput, type Mapping } from "../../src/lib/contacts/import.ts";
import { erasePerson } from "../../src/lib/identity/erase.ts";
import type { Rpc } from "../../src/lib/jobs.ts";
import { applyFilters, type Filter } from "../../src/lib/filters.ts";

const url = process.env.PG_URL;
if (!url) throw new Error("PG_URL is not set");
const pool = new pg.Pool({ connectionString: url, max: 6 });
const q = async (sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows;
after(() => pool.end());

// contacts_upsert as the server calls it through Supabase: jsonb in, jsonb out.
const rpc: Rpc = async (fn, args) => {
  try {
    if (fn !== "contacts_upsert") throw new Error(`unexpected ${fn}`);
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

/** Run a member's function as that member. */
async function asUser<T>(user: string, sql: string, params: unknown[]): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query(`select set_config('request.jwt.claim.sub', $1, false)`, [user]);
    return (await c.query(sql, params)).rows[0].r as T;
  } finally {
    await c.query(`select set_config('request.jwt.claim.sub', '', false)`);
    c.release();
  }
}

async function runImport(ws: string, user: string, text: string, m: Mapping, custom: CustomField[] = []) {
  const [, ...rows] = parseCsv(text);
  const prepared = prepareImport(rows, m, { custom });
  const id = (await q(`select imports_start($1, $2, 'test.csv', $3) as id`, [ws, user, JSON.stringify(m)]))[0].id;
  const written = await writeContacts(rpc, ws, "import", prepared.contacts, { importId: id });
  await q(`select imports_finish($1, 'done', $2)`, [id, JSON.stringify({ ...prepared.counts, ...written, ids: undefined })]);
  return { prepared, written, id };
}

const count = async (sql: string, p: unknown[]) => (await q(`select count(*)::int as n from ${sql}`, p))[0].n as number;

test("a 10,000-row CSV imports with dedupe, and importing it again changes nothing", async () => {
  const { ws, user } = await workspace("import-10k");
  // 9,000 people; 1,000 more rows repeat some of them in other spellings; 20 rows have no usable email.
  const rows: string[][] = [["Email", "First Name", "Last Name", "Company", "Country", "Consent"]];
  for (let i = 0; i < 9000; i++) {
    const free = i % 3 === 0;
    rows.push([free ? `person.${i}@gmail.com` : `p${i}@co${i % 400}.com`, `First${i}`, `Last${i}`, free ? "" : `Co ${i % 400}`, i % 5 === 0 ? "Germany" : "US", i % 7 === 0 ? "opt-in" : ""]);
  }
  for (let i = 0; i < 980; i++) {
    const j = i * 9;
    const free = j % 3 === 0;
    rows.push([free ? `Person${j}+promo@googlemail.com` : `P${j}@CO${j % 400}.com`, "", "", "", "", ""]);
  }
  for (let i = 0; i < 20; i++) rows.push([i % 2 ? "" : `broken${i}@`, "x", "", "", "", ""]);
  const text = toCsv(rows);
  const m: Mapping = { columns: ["email", "first_name", "last_name", "company", "country", "basis"], source: "signups", basis: "legitimate_interest" };

  const t0 = Date.now();
  const first = await runImport(ws, user, text, m);
  const took = Date.now() - t0;
  assert.equal(first.prepared.counts.rows, 10_000);
  assert.equal(first.prepared.counts.merged, 980);
  assert.equal(first.prepared.counts.skipped.missing_email + first.prepared.counts.skipped.invalid_email, 20);
  assert.equal(first.written.created, 9000);
  assert.equal(await count(`contacts where workspace_id = $1`, [ws]), 9000);
  assert.equal(await count(`companies where workspace_id = $1`, [ws]), 400, "one company per domain");
  assert.equal(await count(`consents where workspace_id = $1`, [ws]), 9000, "every contact has a basis");
  assert.equal(await count(`consents where workspace_id = $1 and basis = 'none'`, [ws]), 9000 - (await count(`consents where workspace_id = $1 and basis <> 'none'`, [ws])));
  assert.equal(await count(`consents c join contacts k on k.id = c.contact_id where c.workspace_id = $1 and k.country = 'DE' and c.basis = 'legitimate_interest'`, [ws]), 0, "German contacts need opt-in");
  assert.equal(await count(`contact_events where workspace_id = $1 and kind = 'contact.created'`, [ws]), 9000);
  // The repeated rows kept the names from the first spelling.
  assert.equal((await q(`select first_name from contacts where workspace_id = $1 and email_clean = 'person9@gmail.com'`, [ws]))[0].first_name, "First9");
  assert.ok(took < 60_000, `took ${took} ms`);

  const again = await runImport(ws, user, text, m);
  assert.equal(again.written.created, 0);
  assert.equal(again.written.updated, 9000);
  assert.equal(await count(`contacts where workspace_id = $1`, [ws]), 9000);
  assert.equal(await count(`consents where workspace_id = $1`, [ws]), 9000, "an unchanged basis adds no consent row");
  assert.equal(await count(`contact_events where workspace_id = $1`, [ws]), 9000);
  const imp = (await q(`select status, counts from imports where id = $1`, [first.id]))[0];
  assert.equal(imp.status, "done");
  assert.equal(imp.counts.created, 9000);
  assert.equal(await count(`audit_log where workspace_id = $1 and action = 'contacts.import'`, [ws]), 2);
});

test("a batch sent twice and two imports at once make no doubles", async () => {
  const { ws } = await workspace("import-flaky");
  const people = (from: number, to: number): ContactInput[] =>
    Array.from({ length: to - from }, (_, k) => ({ email: `u${from + k}@flaky.io`, email_clean: `u${from + k}@flaky.io`, email_class: "work", first_name: `U${from + k}`, company_domain: "flaky.io", fields: {}, basis: "opt_in" as const }));
  // The first call of each batch is written, but its answer is lost.
  let lost = 0;
  const lossy: Rpc = async (fn, args) => {
    const r = await rpc(fn, args);
    if (lost++ % 2 === 0) return { data: null, error: { message: "connection reset" } };
    return r;
  };
  await writeContacts(lossy, ws, "import", people(0, 1500), { batch: 500, backoffMs: 1 });
  assert.equal(await count(`contacts where workspace_id = $1`, [ws]), 1500);
  // Two imports overlapping by 1,000 people, at the same time, in small batches.
  await Promise.all([writeContacts(rpc, ws, "import", people(1000, 3000), { batch: 200 }), writeContacts(rpc, ws, "import", people(2000, 4000).reverse(), { batch: 200 })]);
  assert.equal(await count(`contacts where workspace_id = $1`, [ws]), 4000);
  assert.equal((await q(`select count(distinct email_clean)::int n from contacts where workspace_id = $1`, [ws]))[0].n, 4000);
  assert.equal(await count(`companies where workspace_id = $1`, [ws]), 1);
  assert.equal(await count(`consents where workspace_id = $1`, [ws]), 4000);
});

test("filters mean the same in the database and in the browser", async () => {
  const { ws, user } = await workspace("filters");
  const acc = (await q(`insert into accounts (workspace_id, domain, name, fit) values ($1, 'fitco.com', 'FitCo', 82) returning id`, [ws]))[0].id;
  await q(`insert into account_domains (workspace_id, domain, account_id, source) values ($1, 'fitco.com', $2, 'primary')`, [ws, acc]);
  const custom: CustomField[] = [];
  for (const [label, type, options] of [["Plan", "select", ["Free", "Pro"]], ["Seats", "number", []], ["Trial end", "date", []], ["Paying", "checkbox", []], ["Note", "text", []]] as const)
    custom.push(await asUser<CustomField>(user, `select field_add($1, 'contact', $2, $3, $4) as r`, [ws, label, type, JSON.stringify(options)]));
  const titles = ["CEO", "Head of Growth", "VP Sales", null, "Founder & CEO", "100% Marketer", "data_lead", "O'Brien \\ Ops"];
  const contacts: ContactInput[] = Array.from({ length: 48 }, (_, i) => ({
    email: `c${i}@${i % 4 === 0 ? "fitco.com" : i % 4 === 1 ? "gmail.com" : `org${i}.io`}`,
    email_clean: `c${i}@${i % 4 === 0 ? "fitco.com" : i % 4 === 1 ? "gmail.com" : `org${i}.io`}`,
    email_class: i % 4 === 1 ? "free" : "work",
    first_name: i % 6 === 0 ? undefined : `Name${i}`,
    last_name: i % 5 === 0 ? undefined : `Smith${i % 3}`,
    title: titles[i % titles.length] ?? undefined,
    country: ["US", "DE", "GB", undefined][i % 4],
    lifecycle: [undefined, "lead", "customer", "mql"][i % 4],
    company_domain: i % 4 === 0 ? "fitco.com" : i % 4 === 1 ? undefined : `org${i}.io`,
    company_name: i % 4 === 1 ? undefined : i % 4 === 0 ? "FitCo" : `Org ${i}`,
    fields: Object.fromEntries(
      Object.entries({ plan: i % 3 === 0 ? "Pro" : i % 3 === 1 ? "Free" : undefined, seats: i % 2 ? i : undefined, trial_end: i % 4 === 2 ? "2026-10-01" : i % 4 === 3 ? "2025-01-01" : undefined, paying: i % 5 === 0 ? true : i % 5 === 1 ? false : undefined, note: i % 7 === 0 ? "50%_off; drop table contacts; --" : undefined }).filter(([, v]) => v !== undefined),
    ) as ContactInput["fields"],
  }));
  await writeContacts(rpc, ws, "import", contacts);
  await q(`update contacts set created_at = now() - interval '40 days' where workspace_id = $1 and email_clean like 'c1%'`, [ws]);
  await q(`update contacts set score = (substr(email_clean, 2, 2))::int where workspace_id = $1 and email_clean ~ '^c[0-9]{2}@'`, [ws]);

  const fields = contactFilterFields(custom);
  const all = (await asUser<{ total: number; rows: ContactRow[] }>(user, `select contacts_list($1, '[]', 'email', false, 1000, 0) as r`, [ws])).rows;
  assert.equal(all.length, 48);
  const cases: Filter[][] = [
    [{ field: "name", op: "contains", values: ["smith1"] }],
    [{ field: "name", op: "empty", values: [] }],
    [{ field: "email", op: "is", values: ["C4@FITCO.COM"] }],
    [{ field: "company", op: "contains", values: ["fit"] }],
    [{ field: "company", op: "is_not", values: ["FitCo"] }],
    [{ field: "company_domain", op: "not_empty", values: [] }],
    [{ field: "title", op: "contains", values: ["ceo"] }],
    [{ field: "title", op: "contains", values: ["%"] }],
    [{ field: "title", op: "contains", values: ["_"] }],
    [{ field: "title", op: "contains", values: ["\\"] }],
    [{ field: "title", op: "contains", values: ["'"] }],
    [{ field: "title", op: "is", values: ["ceo", "vp sales"] }],
    [{ field: "title", op: "contains", values: ["'; drop table contacts; --"] }],
    [{ field: "lifecycle", op: "is", values: ["lead", "customer"] }],
    [{ field: "lifecycle", op: "is_not", values: ["lead"] }],
    [{ field: "lifecycle", op: "empty", values: [] }],
    [{ field: "country", op: "is", values: ["de"] }],
    [{ field: "fit", op: "gte", values: ["80"] }],
    [{ field: "fit", op: "empty", values: [] }],
    [{ field: "score", op: "lte", values: ["20"] }],
    [{ field: "known", op: "is", values: ["false"] }],
    [{ field: "source", op: "is", values: ["import"] }],
    [{ field: "email_class", op: "is", values: ["free"] }],
    [{ field: "created_at", op: "within", values: ["7"] }],
    [{ field: "created_at", op: "before", values: ["30"] }],
    [{ field: "f.plan", op: "is", values: ["Pro"] }],
    [{ field: "f.plan", op: "empty", values: [] }],
    [{ field: "f.seats", op: "gte", values: ["20"] }],
    [{ field: "f.seats", op: "lte", values: ["9.5"] }],
    [{ field: "f.trial_end", op: "within", values: ["60"] }],
    [{ field: "f.trial_end", op: "before", values: ["60"] }],
    [{ field: "f.paying", op: "is", values: ["true"] }],
    [{ field: "f.paying", op: "is", values: ["false"] }],
    [{ field: "f.note", op: "contains", values: ["50%_off"] }],
    [{ field: "f.note", op: "is", values: ["50%_off; drop table contacts; --"] }],
    [
      { field: "lifecycle", op: "is", values: ["customer", "mql"] },
      { field: "country", op: "is_not", values: ["US"] },
      { field: "f.seats", op: "not_empty", values: [] },
    ],
  ];
  for (const fs of cases) {
    const db = await asUser<{ total: number; rows: ContactRow[] }>(user, `select contacts_list($1, $2, 'email', false, 1000, 0) as r`, [ws, JSON.stringify(fs)]);
    const browser = applyFilters(all, fs, fields).map((r) => r.email);
    assert.deepEqual(db.rows.map((r) => r.email), browser, JSON.stringify(fs));
    assert.equal(db.total, browser.length);
  }
  assert.ok(cases.some((fs) => applyFilters(all, fs, fields).length > 0 && applyFilters(all, fs, fields).length < 48), "the fixture tells cases apart");
  assert.equal(await count(`contacts where workspace_id = $1`, [ws]), 48, "nothing was dropped");

  // Bad filters are refused, never run.
  for (const bad of [
    [{ field: "c.email); delete from contacts; --", op: "is", values: ["x"] }],
    [{ field: "f.unknown", op: "is", values: ["x"] }],
    [{ field: "fit", op: "gte", values: ["1; select 1"] }],
    [{ field: "created_at", op: "within", values: ["7 days"] }],
    [{ field: "lifecycle", op: "contains", values: ["x"] }],
    [{ field: "title", op: "is", values: [] }],
  ])
    await assert.rejects(asUser(user, `select contacts_list($1, $2) as r`, [ws, JSON.stringify(bad)]), JSON.stringify(bad));
  // Paging and sorting.
  const page = await asUser<{ total: number; rows: ContactRow[] }>(user, `select contacts_list($1, '[]', 'score', true, 10, 10) as r`, [ws]);
  assert.equal(page.total, 48);
  assert.equal(page.rows.length, 10);
  assert.ok(page.rows[0].score! >= page.rows[9].score!);
});

test("a contact follows its person through stitching, merges, rebuilds and erasure", async () => {
  const { ws } = await workspace("follow");
  const pers = async () => {
    const id = uuid7();
    await q(`insert into persons (id, workspace_id) values ($1, $2)`, [id, ws]);
    return id;
  };
  const ident = async (person: string | null, email: string) =>
    (await q(`insert into identifiers (id, workspace_id, person_id, kind, value_clean, value_hash) values ($1, $2, $3, 'email', $4, '\\x01') returning id`, [uuid7(), ws, person, email]))[0].id;
  const personOf = async (email: string) => (await q(`select person_id from contacts where workspace_id = $1 and email_clean = $2`, [ws, email]))[0]?.person_id ?? null;
  const add = (email: string) => writeContacts(rpc, ws, "import", [{ email, email_clean: email, email_class: "work", fields: {} }]);

  // Contact first, then the visitor identifies: the contact links.
  await add("ann@acme.com");
  assert.equal(await personOf("ann@acme.com"), null);
  const a = await pers();
  await ident(a, "ann@acme.com");
  assert.equal(await personOf("ann@acme.com"), a);

  // Person first, then the import: the contact links on the way in.
  const b = await pers();
  const bid = await ident(b, "bob@acme.com");
  await add("bob@acme.com");
  assert.equal(await personOf("bob@acme.com"), b);

  // An identifier with no person yet, then stitching gives it one (an update, as stitch does).
  const cid = await ident(null, "cat@acme.com");
  await add("cat@acme.com");
  assert.equal(await personOf("cat@acme.com"), null);
  const c = await pers();
  await q(`update identifiers set person_id = $2 where id = $1`, [cid, c]);
  assert.equal(await personOf("cat@acme.com"), c);

  // Merge b into a, the way stitch does it: identifiers move, then the old person is marked.
  await q(`update identifiers set person_id = $2 where workspace_id = $3 and person_id = $1`, [b, a, ws]);
  await q(`update persons set merged_into = $2 where id = $1`, [b, a]);
  assert.equal(await personOf("bob@acme.com"), a);
  // Marked merged first, identifiers moved later (a retried merge): still right.
  const d = await pers();
  const did = await ident(d, "dan@acme.com");
  await add("dan@acme.com");
  await q(`update persons set merged_into = $2 where id = $1`, [d, c]);
  assert.equal(await personOf("dan@acme.com"), c);
  await q(`update identifiers set person_id = $2 where id = $1`, [did, c]);
  assert.equal(await personOf("dan@acme.com"), c);

  // A rebuild clears every link and replays: contacts clear and come back.
  await q(`update identifiers set person_id = null where workspace_id = $1`, [ws]);
  assert.equal(await count(`contacts where workspace_id = $1 and person_id is not null`, [ws]), 0);
  await q(`update identifiers set person_id = $2 where id = $1`, [bid, a]);
  assert.equal(await personOf("bob@acme.com"), a);

  // Erasing the person removes the contact with that email, and nothing else.
  await q(`update identifiers set person_id = $1 where workspace_id = $2 and value_clean = 'ann@acme.com'`, [a, ws]);
  const counts = await erasePerson(pool as never, ws, a);
  assert.equal(counts.contacts, 2, "ann and bob were both this person");
  assert.equal(await count(`contacts where workspace_id = $1 and email_clean in ('ann@acme.com', 'bob@acme.com')`, [ws]), 0);
  assert.equal(await count(`contacts where workspace_id = $1`, [ws]), 2);
});

test("editing a contact, its page, and removing it", async () => {
  const { ws, user } = await workspace("edit");
  const [x, y] = (await writeContacts(rpc, ws, "import", [
    { email: "x@one.com", email_clean: "x@one.com", email_class: "work", first_name: "X", company_domain: "one.com", fields: {}, basis: "opt_in" },
    { email: "y@two.com", email_clean: "y@two.com", email_class: "work", fields: {} },
  ])).ids;
  await assert.rejects(q(`select contact_update($1, 'manual', $2)`, [x, JSON.stringify({ email: "y@two.com", email_clean: "y@two.com", email_class: "work" })]), /Another contact/);
  await assert.rejects(q(`select contact_update($1, 'manual', $2)`, [x, JSON.stringify({ owner_user_id: user })]), /Unknown field/);
  await q(`select contact_update($1, 'manual', $2)`, [x, JSON.stringify({ title: "CTO", company_name: "Two Inc", company_domain: "two.com", first_name: null })]);
  const row = (await q(`select c.title, c.first_name, co.domain, co.name from contacts c join companies co on co.id = c.company_id where c.id = $1`, [x]))[0];
  assert.deepEqual([row.title, row.first_name, row.domain, row.name], ["CTO", null, "two.com", "Two Inc"]);

  // A person with a visit shows on the page.
  const site = (await q(`insert into sites (workspace_id, domain) values ($1, 'edit-site.com') returning id`, [ws]))[0].id;
  const p = uuid7();
  await q(`insert into persons (id, workspace_id) values ($1, $2)`, [p, ws]);
  await q(`insert into identifiers (id, workspace_id, person_id, kind, value_clean, value_hash) values ($1, $2, $3, 'email', 'x@one.com', '\\x01')`, [uuid7(), ws, p]);
  await q(`insert into sessions (id, workspace_id, site_id, started_at, ended_at, policy, cookieless_key, person_id, pageviews, engaged_s) values ($1, $2, $3, now(), now(), 'notice', '\\x01', $4, 2, 30)`, [uuid7(), ws, site, p]);
  const d = await asUser<Record<string, unknown> & { contact: { title: string }; writes: Record<string, { source: string }>; visits: unknown[]; consents: { basis: string }[]; company: { domain: string } }>(
    user,
    `select contact_detail($1) as r`,
    [x],
  );
  assert.equal(d.contact.title, "CTO");
  assert.ok(!("workspace_id" in d.contact));
  assert.equal(d.writes.title.source, "manual");
  assert.equal(d.writes.email.source, "import");
  assert.equal(d.visits.length, 1);
  assert.equal(d.consents[0].basis, "opt_in");
  assert.equal(d.company.domain, "two.com");

  assert.equal(await asUser<number>(user, `select contacts_delete($1, $2) as r`, [ws, [y]]), 1);
  assert.equal((await asUser<{ total: number }>(user, `select contacts_list($1) as r`, [ws])).total, 1);
  await assert.rejects(asUser(user, `select contact_detail($1) as r`, [y]), /not found/);
  // The same email can come back as a new contact.
  const again = await writeContacts(rpc, ws, "import", [{ email: "y@two.com", email_clean: "y@two.com", email_class: "work", fields: {} }]);
  assert.equal(again.created, 1);
});

// Making or dropping a month locks the events table, so it can deadlock with writes from tests running at the
// same time; Postgres picks one side to fail, and that side tries again (the daily job does the same next day).
async function ddl(sql: string) {
  for (let i = 0; ; i++) {
    try {
      return await q(sql);
    } catch (e) {
      if ((e as { code?: string }).code !== "40P01" || i >= 4) throw e;
    }
  }
}

test("contact event months: made ahead, kept private, safe to run again", async () => {
  await ddl(`select contact_events_roll()`);
  await ddl(`select contact_events_roll()`);
  const parts = await q(`select c.relname, c.relrowsecurity from pg_inherits i join pg_class c on c.oid = i.inhrelid join pg_namespace n on n.oid = c.relnamespace
                         where i.inhparent = 'public.contact_events'::regclass and n.nspname = 'partitions' order by 1`);
  assert.equal(parts.length, 17, "13 months back, this one, 3 ahead");
  assert.ok(parts.every((p) => p.relrowsecurity));
  // An old month past 13 is dropped.
  await ddl(`create table partitions.contact_events_2001_01 partition of public.contact_events for values from ('2001-01-01') to ('2001-02-01')`);
  await ddl(`select contact_events_roll()`);
  assert.equal((await q(`select to_regclass('partitions.contact_events_2001_01') as r`))[0].r, null);
});
