// Forms on a real database: a real answer becomes one contact with its consent, topic and event; bots, fast posts,
// floods, stale pages and bad emails are held back or refused; a draft takes no answers; a CRM hears about it.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import pg from "pg";
import { uuid7 } from "../../collect/ids.ts";
import { submitForm, type SubmitDeps } from "../../src/lib/forms/submit.ts";
import { shownToken } from "../../src/lib/forms/token.ts";
import { ctxFor } from "../../worker-intel/jobs/imports.ts";
import { pgRpc } from "../../worker-intel/rpc.ts";

process.env.SECRETS_KEY ||= "test-secrets-key-that-is-long-enough-1234";
const url = process.env.PG_URL;
if (!url) throw new Error("PG_URL is not set");
const pool = new pg.Pool({ connectionString: url, max: 4 });
const q = async (sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows;
after(() => pool.end());
const rpc = pgRpc(pool);

let ws = "";
let user = "";
let form = "";
let topic = "";
let captchaAnswer = true;
const deps: SubmitDeps = { rpc, clean: (w) => ctxFor(pool, w), captcha: async () => captchaAnswer, captchaOn: true };
const meta = (ip = "203.0.113.7") => ({ ip, userAgent: "Mozilla/5.0 test", preview: false });
const old = () => shownToken(form, Date.now() - 10_000);
const send = (answers: Record<string, unknown>, ip?: string, context: unknown = {}) => submitForm(deps, form, { answers: { _t: old(), ...answers }, context }, meta(ip));
const asOwner = async <T>(sql: string, params: unknown[]): Promise<T> => {
  const c = await pool.connect();
  try {
    await c.query(`select set_config('request.jwt.claim.sub', $1, false)`, [user]);
    await c.query("set role authenticated");
    return (await c.query(sql, params)).rows[0]?.r as T;
  } finally {
    await c.query("reset role");
    await c.query(`select set_config('request.jwt.claim.sub', '', false)`);
    c.release();
  }
};

const FIELDS = [
  { key: "email", label: "Work email", type: "email", required: true, maps_to: "email" },
  { key: "first_name", label: "First name", type: "text", maps_to: "first_name" },
  { key: "company", label: "Company", type: "text", maps_to: "company" },
  { key: "seats", label: "Seats", type: "number" },
  { key: "country", label: "Country", type: "text", maps_to: "country" },
];

before(async () => {
  ws = uuid7();
  user = uuid7();
  await q(`insert into workspaces (id, name) values ($1, 'forms')`, [ws]);
  await q(`insert into auth.users (id, email) values ($1, $2)`, [user, `${user}@t.io`]);
  await q(`insert into workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')`, [ws, user]);
  topic = (await q(`insert into topics (workspace_id, name) values ($1, 'Guides') returning id`, [ws]))[0].id;
  await assert.rejects(asOwner(`select form_save($1, null, 'No email', $2, '{}') as r`, [ws, JSON.stringify(FIELDS.slice(1))]), /needs an email field/);
  form = await asOwner<string>(`select form_save($1, null, 'Guide download', $2, $3) as r`, [ws, JSON.stringify(FIELDS), JSON.stringify({ consent: "checkbox", topic_id: topic })]);
});

test("a draft takes no answers; live, a real answer becomes a contact with consent, topic and event", async () => {
  assert.equal((await send({ email: "ann@acme.com" })).status, 404, "draft");
  await asOwner(`select form_publish($1, true) as r`, [form]);
  const r = await send({ email: "Ann@Acme.com", first_name: "ann", company: "Acme", seats: "40", _consent: "1" }, undefined, {
    utm: { utm_source: "linkedin", utm_campaign: "q4" },
    first: { utm_source: "google" },
    page: "https://acme.io/guide",
    referrer: "https://www.linkedin.com/",
  });
  assert.deepEqual(r, { status: 200, body: { ok: true, email: "Ann@Acme.com" } });
  const c = (await q(`select id, email_clean, first_name, source, (select name from companies co where co.id = contacts.company_id) company from contacts where workspace_id = $1`, [ws]))[0];
  assert.deepEqual([c.email_clean, c.first_name, c.source, c.company], ["ann@acme.com", "Ann", "form", "Acme"]);
  assert.equal((await q(`select basis from consents where contact_id = $1 order by at desc limit 1`, [c.id]))[0].basis, "opt_in");
  assert.equal((await q(`select status from subscriptions where contact_id = $1 and topic_id = $2`, [c.id, topic]))[0].status, "subscribed");
  const s = (await q(`select answers, utm, page_url, contact_id, spam from form_submissions where form_id = $1`, [form]))[0];
  assert.deepEqual(s.answers, { email: "Ann@Acme.com", first_name: "ann", company: "Acme", seats: "40" });
  assert.deepEqual(s.utm, { utm_source: "linkedin", utm_campaign: "q4", first_utm_source: "google" });
  assert.equal(s.contact_id, c.id);
  const e = (await q(`select data from contact_events where contact_id = $1 and kind = 'form.submitted'`, [c.id]))[0].data;
  assert.equal(e.form_name, "Guide download");
  assert.equal(e.answers.seats, "40");
});

test("no tick, no consent: the contact comes in and can't be emailed, and no topic", async () => {
  await send({ email: "bob@acme.com" });
  const c = (await q(`select id from contacts where workspace_id = $1 and email_clean = 'bob@acme.com'`, [ws]))[0];
  assert.equal((await q(`select basis from consents where contact_id = $1 order by at desc limit 1`, [c.id]))[0].basis, "none");
  assert.equal((await q(`select count(*)::int n from subscriptions where contact_id = $1`, [c.id]))[0].n, 0);
  // The same person again: still one contact.
  await send({ email: "bob@acme.com", first_name: "Bob" });
  assert.equal((await q(`select count(*)::int n from contacts where workspace_id = $1 and email_clean = 'bob@acme.com'`, [ws]))[0].n, 1);
});

test("bots are held back quietly: honeypot and posting too fast look like success and make no contact", async () => {
  const hp = await send({ email: "bot1@spam.com", _hp: "http://spam" });
  assert.deepEqual(hp, { status: 200, body: { ok: true, email: null } });
  const fast = await submitForm(deps, form, { answers: { _t: shownToken(form, Date.now() - 500), email: "bot2@spam.com" } }, meta());
  assert.equal(fast.status, 200);
  const rows = await q(`select answers->>'email' e, spam, contact_id from form_submissions where form_id = $1 and spam is not null order by created_at`, [form]);
  assert.deepEqual(rows.map((r) => [r.e, r.spam, r.contact_id]), [["bot1@spam.com", "honeypot", null], ["bot2@spam.com", "too_fast", null]]);
  assert.equal((await q(`select count(*)::int n from contacts where workspace_id = $1 and email_clean like 'bot%'`, [ws]))[0].n, 0);
});

test("stale or forged page tokens, bad answers and failed Turnstile are refused", async () => {
  assert.equal((await submitForm(deps, form, { answers: { email: "a@b.co" } }, meta())).status, 400, "no token");
  assert.equal((await submitForm(deps, form, { answers: { _t: shownToken(form, Date.now() - 25 * 3_600_000), email: "a@b.co" } }, meta())).status, 400, "a day old");
  assert.equal((await submitForm(deps, form, { answers: { _t: shownToken("another-form", Date.now() - 10_000), email: "a@b.co" } }, meta())).status, 400, "another form's");
  const bad = await send({ email: "not an email", seats: "lots" });
  assert.deepEqual(bad, { status: 422, body: { errors: { email: "Enter a valid email", seats: "Enter a number" } } });
  const disposable = await send({ email: "x@mailinator.com" });
  assert.equal(disposable.status, 422, "an address the import would drop");
  await asOwner(`select form_save($1, $2, 'Guide download', $3, $4) as r`, [ws, form, JSON.stringify(FIELDS), JSON.stringify({ consent: "checkbox", topic_id: topic, captcha: true })]);
  captchaAnswer = false;
  assert.equal((await send({ email: "cy@acme.com" })).status, 400);
  captchaAnswer = true;
  assert.equal((await send({ email: "cy@acme.com" })).status, 200);
});

test("more than 10 from one address in 10 minutes are marked and make no contact", async () => {
  for (let i = 0; i < 12; i++) await send({ email: `flood${i}@acme.com` }, "198.51.100.9");
  const marked = await q(`select answers->>'email' e from form_submissions where form_id = $1 and spam = 'rate'`, [form]);
  assert.deepEqual(marked.map((r) => r.e).sort(), ["flood10@acme.com", "flood11@acme.com"]);
  assert.equal((await q(`select count(*)::int n from contacts where workspace_id = $1 and email_clean like 'flood%'`, [ws]))[0].n, 10);
});

test("a notice form counts as legitimate interest only where the law allows it; preview keeps nothing", async () => {
  await asOwner(`select form_save($1, $2, 'Guide download', $3, $4) as r`, [ws, form, JSON.stringify(FIELDS), JSON.stringify({ consent: "notice" })]);
  await send({ email: "dee@acme.com", country: "United States" });
  await send({ email: "fay@acme.de", country: "Germany" });
  await send({ email: "gus@acme.com" });
  const basis = async (email: string) => (await q(`select k.basis from consents k join contacts c on c.id = k.contact_id where c.workspace_id = $1 and c.email_clean = $2 order by k.at desc limit 1`, [ws, email]))[0].basis;
  assert.equal(await basis("dee@acme.com"), "legitimate_interest");
  assert.equal(await basis("fay@acme.de"), "none", "the EU needs opt-in");
  assert.equal(await basis("gus@acme.com"), "none", "an unknown country isn't the US");
  const before = (await q(`select count(*)::int n from form_submissions where form_id = $1`, [form]))[0].n;
  await asOwner(`select form_publish($1, false) as r`, [form]);
  const p = await submitForm(deps, form, { answers: { _t: old(), email: "eve@acme.com" } }, { ...meta(), preview: true });
  assert.equal(p.status, 200);
  assert.equal((await q(`select count(*)::int n from form_submissions where form_id = $1`, [form]))[0].n, before);
  assert.equal((await q(`select count(*)::int n from contacts where workspace_id = $1 and email_clean = 'eve@acme.com'`, [ws]))[0].n, 0);
});
