// Imports at full size on a real database (docs/conversion-weeks.md week 2): a big file stopped twice and picked
// up again lands every row once; undo after an overlapping import takes back only what the first one did.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import pg from "pg";
import { uuid7 } from "../../collect/ids.ts";
import { toCsv } from "../../src/lib/contacts/csv.ts";
import { writeContacts } from "../../src/lib/contacts/contacts.ts";
import { executeImport, type ImportRow } from "../../src/lib/contacts/importJob.ts";
import type { Rpc } from "../../src/lib/jobs.ts";
import { pgRpc } from "../../worker-intel/rpc.ts";
import { ctxFor, importFile, importUndo } from "../../worker-intel/jobs/imports.ts";

const url = process.env.PG_URL;
if (!url) throw new Error("PG_URL is not set");
const pool = new pg.Pool({ connectionString: url, max: 4 });
const q = async (sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows;
after(() => pool.end());
const rpc = pgRpc(pool);
const ROWS = Number(process.env.IMPORT_TEST_ROWS || 60_000);

async function workspace(name: string) {
  const ws = uuid7();
  const user = uuid7();
  await q(`insert into workspaces (id, name) values ($1, $2)`, [ws, name]);
  await q(`insert into auth.users (id, email) values ($1, $2)`, [user, `${user}@t.io`]);
  await q(`insert into workspace_members (workspace_id, user_id, role) values ($1, $2, 'owner')`, [ws, user]);
  return { ws, user };
}
const count = async (sql: string, p: unknown[]) => (await q(`select count(*)::int as n from ${sql}`, p))[0].n as number;
const fakeFile = (text: string) => async () => new Blob([text]).stream() as ReadableStream<Uint8Array>;
const job = (id: string, ws: string) => ({ id: uuid7(), workspace_id: ws, kind: "import_file", key: id, payload: { import_id: id }, attempts: 1, max_attempts: 8 });

test(`a ${ROWS.toLocaleString("en-US")}-row file stopped twice lands every row once`, async () => {
  const { ws, user } = await workspace("big-import");
  const rows: unknown[][] = [["Email", "Name", "Phone", "Country", "Consent"]];
  for (let i = 0; i < ROWS; i++) rows.push([`p${i}@co${i % 500}.com`, i % 7 ? `FIRST${i} LAST${i}` : `Last${i}, First${i}`, i % 3 ? "(415) 555-0132" : "", i % 5 ? "US" : "DE", i % 11 ? "yes" : "unsubscribed"]);
  for (let i = 0; i < 500; i++) rows.push([`P${i * 7}@CO${(i * 7) % 500}.com`, "", "", "", ""]);
  const text = toCsv(rows);
  const id = (await q(`select imports_start($1, $2, 'big.csv', $3, 'file', $4, $5, null, true) as id`, [
    ws,
    user,
    JSON.stringify({ columns: ["email", "name", "phone", "country", "basis"], source: "signups", basis: "legitimate_interest" }),
    `${ws}/${uuid7()}/big.csv`,
    text.length,
  ]))[0].id;
  assert.equal(await count(`jobs where kind = 'import_file' and key = $1`, [id]), 1, "a big file waits for the job");

  // Stop the job after a few pages, twice, the way a deploy or a crash would.
  const stopAt = [Math.floor(ROWS / 4), Math.floor(ROWS / 2)];
  for (const at of stopAt) {
    const ac = new AbortController();
    const stopping: Rpc = async (fn, args) => {
      const r = await rpc(fn, args);
      if (fn === "import_progress" && Number(args.p_rows_done) >= at) ac.abort();
      return r;
    };
    await assert.rejects(importFile(pool, stopping, fakeFile(text))(job(id, ws) as never, ac.signal), /Stopped/);
    const imp = (await q(`select status, rows_done from imports where id = $1`, [id]))[0];
    assert.equal(imp.status, "running");
    assert.ok(imp.rows_done >= at && imp.rows_done < ROWS, `stopped at ${imp.rows_done}`);
  }
  await importFile(pool, rpc, fakeFile(text))(job(id, ws) as never, new AbortController().signal);

  const imp = (await q(`select status, rows_done, counts from imports where id = $1`, [id]))[0];
  assert.equal(imp.status, "done");
  assert.equal(imp.rows_done, ROWS + 500);
  assert.equal(await count(`contacts where workspace_id = $1`, [ws]), ROWS, "every row once, repeats merged");
  assert.equal((await q(`select count(distinct email_clean)::int n from contacts where workspace_id = $1`, [ws]))[0].n, ROWS);
  assert.equal(imp.counts.created, ROWS);
  assert.equal(imp.counts.rows, ROWS + 500, "totals carry over between attempts");
  assert.equal(await count(`suppressions where workspace_id = $1`, [ws]), Math.ceil(ROWS / 11), "unsubscribed rows are blocked");
  assert.equal(await count(`consents k join suppressions s on s.email_clean = (select email_clean from contacts where id = k.contact_id) where k.workspace_id = $1 and k.basis <> 'none'`, [ws]), 0);
  const c = (await q(`select first_name, last_name, phone from contacts where workspace_id = $1 and email_clean = 'p7@co7.com'`, [ws]))[0];
  assert.deepEqual([c.first_name, c.last_name], ["First7", "Last7"], "'Last, First' split and cased");
  assert.equal((await q(`select phone from contacts where workspace_id = $1 and email_clean = 'p1@co1.com'`, [ws]))[0].phone, "+14155550132");
});

test("undo after an overlapping import takes back only what the first one did", async () => {
  const { ws, user } = await workspace("undo");
  // Before: one contact from the CRM, and one an import will change.
  await writeContacts(rpc, ws, "hubspot", [{ email: "crm@acme.com", email_clean: "crm@acme.com", email_class: "work", title: "CTO", fields: {} }]);
  await writeContacts(rpc, ws, "csv", [{ email: "old@acme.com", email_clean: "old@acme.com", email_class: "work", title: "Analyst", fields: {} }]);

  const start = async (name: string, text: string, columns: string[]) => {
    const id = (await q(`select imports_start($1, $2, $3, $4, 'file', $5, $6) as id`, [
      ws,
      user,
      name,
      JSON.stringify({ columns, source: "event", basis: "opt_in" }),
      `${ws}/${uuid7()}/${name}`,
      text.length,
    ]))[0].id as string;
    const imp = (await q(`select * from imports where id = $1`, [id]))[0] as ImportRow;
    await executeImport(rpc, imp, await ctxFor(pool, ws), { open: fakeFile(text) });
    return id;
  };
  const a = await start(
    "a.csv",
    toCsv([["email", "title"], ...Array.from({ length: 20 }, (_, i) => [`n${i}@acme.com`, "New"]), ["old@acme.com", "Manager"], ["crm@acme.com", "Intern"], ["gone@acme.com", "unsub"]]),
    ["email", "title"],
  );
  assert.equal((await q(`select title from contacts where email_clean = 'old@acme.com' and workspace_id = $1`, [ws]))[0].title, "Manager");
  assert.equal((await q(`select title from contacts where email_clean = 'crm@acme.com' and workspace_id = $1`, [ws]))[0].title, "CTO", "a file never overwrites the CRM");
  await q(`select suppress($1, 'csv', '[{"email_clean":"gone@acme.com","reason":"unsubscribed"}]', $2)`, [ws, a]);

  // Then: a second import touches n0..n4, and a person edits n5.
  await start("b.csv", toCsv([["email", "phone"], ...Array.from({ length: 5 }, (_, i) => [`n${i}@acme.com`, "+1 555 0100"])]), ["email", "phone"]);
  const n5 = (await q(`select id from contacts where email_clean = 'n5@acme.com' and workspace_id = $1`, [ws]))[0].id;
  await q(`select contact_update($1, 'manual', '{"title":"Edited"}')`, [n5]);

  // Undo the first import.
  const c = await pool.connect();
  try {
    await c.query(`select set_config('request.jwt.claim.sub', $1, false)`, [user]);
    await c.query(`select import_undo($1)`, [a]);
    await assert.rejects(c.query(`select import_undo($1)`, [a]), /can't be undone/);
  } finally {
    await c.query(`select set_config('request.jwt.claim.sub', '', false)`);
    c.release();
  }
  await importUndo(rpc)({ id: uuid7(), workspace_id: ws, kind: "import_undo", key: a, payload: { import_id: a }, attempts: 1, max_attempts: 3 } as never, new AbortController().signal);

  const left = (await q(`select email_clean, title from contacts where workspace_id = $1 and deleted_at is null order by email_clean`, [ws])).map((r) => `${r.email_clean}:${r.title ?? "-"}`);
  assert.deepEqual(left, [
    "crm@acme.com:CTO",
    "n0@acme.com:New",
    "n1@acme.com:New",
    "n2@acme.com:New",
    "n3@acme.com:New",
    "n4@acme.com:New",
    "n5@acme.com:Edited",
    "old@acme.com:Analyst",
  ]);
  assert.equal(await count(`consents where import_id = $1`, [a]), 0, "its consent rows go");
  assert.equal(await count(`suppressions where workspace_id = $1`, [ws]), 1, "an unsubscribe is never undone");
  const imp = (await q(`select status, counts from imports where id = $1`, [a]))[0];
  assert.equal(imp.status, "undone");
  assert.equal(imp.counts.undo_restored, 3, "old's title and company, and the company it filled in on the CRM contact");
  assert.equal((await q(`select count(*)::int n from contacts where workspace_id = $1 and email_clean in ('old@acme.com', 'crm@acme.com') and company_id is not null`, [ws]))[0].n, 0);
});
