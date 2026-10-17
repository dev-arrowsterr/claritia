// Nurture on a real database: nothing goes live unapproved; people join from a segment or a form, get each step once
// through the send pipeline, and leave when they reach a stage, unsubscribe or are suppressed; editing a live step
// holds it until approved again and leaves mail in line untouched.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import pg from "pg";
import { uuid7 } from "../../collect/ids.ts";
import { stepEmail } from "../../src/lib/nurture/email.ts";
import type { Outgoing, Ses } from "../../src/lib/email/ses.ts";
import type { Job } from "../../src/lib/jobs.ts";
import { send } from "../../worker-intel/jobs/email.ts";
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
let segment = "";
let nurture = "";
let topic = "";
const contact: Record<string, string> = {};
const sent: Outgoing[] = [];
const ses = { region: "ap-northeast-1", send: async (m: Outgoing) => (sent.push(m), `ses-${uuid7()}`) } as unknown as Ses;
const runSend = () => send(rpc, { ses, base: "https://app.test", roundMs: 3_000, sleep: async () => {} })({ id: uuid7(), workspace_id: ws, kind: "send", key: ws, payload: {}, attempts: 1, max_attempts: 3 } as Job, new AbortController().signal);
const as = async <T>(sql: string, params: unknown[]): Promise<T> => {
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
const addStep = (wait: number, subject: string, stepId: string | null = null) => {
  const e = stepEmail({ paragraphs: [`${subject} body`], cta_label: "Read", cta_url: "https://acme.com/guide" });
  return as<string>(`select nurture_step_save($1, $2, $3, $4, '', $5, $6, $7, false, '{}') as r`, [nurture, stepId, wait, subject, e.html, e.text, e.links]);
};
const enrollment = async (name: string) => (await q(`select status, step, exit_reason, next_at from nurture_enrollments where nurture_id = $1 and contact_id = $2`, [nurture, contact[name]]))[0];
const due = (name: string) => q(`update nurture_enrollments set next_at = now() - interval '1 minute' where nurture_id = $1 and contact_id = $2`, [nurture, contact[name]]);

before(async () => {
  ws = uuid7();
  user = uuid7();
  await q(`insert into workspaces (id, name) values ($1, 'nurture')`, [ws]);
  await q(`insert into auth.users (id, email) values ($1, $2)`, [user, `${user}@t.io`]);
  await q(`insert into workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')`, [ws, user]);
  topic = (await q(`insert into topics (workspace_id, name, default_on) values ($1, 'Guides', true) returning id`, [ws]))[0].id;
  segment = (await q(`insert into segments (workspace_id, name, kind) values ($1, 'Trial users', 'static') returning id`, [ws]))[0].id;
  for (const n of ["ann", "bob", "cy", "dee", "eli"]) {
    contact[n] = (await q(`insert into contacts (workspace_id, email, email_clean, country, lifecycle) values ($1, $2, $2, 'US', 'lead') returning id`, [ws, `${n}-${ws.slice(-6)}@example.com`]))[0].id;
    await q(`insert into segment_members (workspace_id, segment_id, contact_id) values ($1, $2, $3)`, [ws, segment, contact[n]]);
  }
  nurture = await as<string>(`select nurture_save($1, null, 'Trial follow-up', $2, $3, 'Acme closes the books in 3 days.', '{sql,customer}') as r`, [ws, JSON.stringify({ kind: "segment", segment_id: segment }), topic]);
});

test("nothing goes live without approved steps and sending set up", async () => {
  await assert.rejects(as(`select nurture_set_status($1, 'live') as r`, [nurture]), /Add a step first/);
  const s1 = await addStep(0, "Welcome");
  await addStep(3, "Proof");
  await assert.rejects(as(`select nurture_set_status($1, 'live') as r`, [nurture]), /Approve every step first/);
  await as(`select nurture_step_approve($1) as r`, [s1]);
  const s2 = (await q(`select id from nurture_steps where nurture_id = $1 and position = 1`, [nurture]))[0].id;
  await as(`select nurture_step_approve($1) as r`, [s2]);
  await assert.rejects(as(`select nurture_set_status($1, 'live') as r`, [nurture]), /Set up sending first/);
  await q(`insert into sending_domains (workspace_id, domain, mail_from, tracking_host, status) values ($1, $2, $3, $4, 'verified')`, [ws, `n${ws.slice(-8)}.acme.com`, `bounce.n${ws.slice(-8)}.acme.com`, `t.n${ws.slice(-8)}.acme.com`]);
  await q(`insert into send_settings (workspace_id, from_email, quiet_start, quiet_end) values ($1, $2, 0, 0)`, [ws, `hi@n${ws.slice(-8)}.acme.com`]);
  await assert.rejects(as(`select nurture_set_status($1, 'live') as r`, [nurture]), /physical address/);
  await q(`update send_settings set address = '1 Main St' where workspace_id = $1`, [ws]);
  await as(`select nurture_set_status($1, 'live') as r`, [nurture]);
  assert.equal((await q(`select count(*)::int n from nurture_enrollments where nurture_id = $1`, [nurture]))[0].n, 5, "the segment joins at once");
  await assert.rejects(addStep(2, "Late addition"), /Pause the nurture to add steps/);
});

test("each step goes out once, through the guard, and the next waits its days", async () => {
  assert.equal((await q(`select nurture_advance(500) as n`))[0].n, 5);
  assert.equal((await q(`select nurture_advance(500) as n`))[0].n, 0, "running again queues nothing");
  await runSend();
  assert.equal(sent.length, 5);
  assert.ok(sent.every((m) => m.subject === "Welcome" && m.headers.some((h) => h.name === "List-Unsubscribe-Post")));
  const ann = await enrollment("ann");
  assert.equal(ann.step, 1);
  assert.ok(new Date(ann.next_at).getTime() > Date.now() + 2.9 * 86_400_000, "three days to the next one");
  // Ann is due for step 2; a repeat of the same step after a crash adds no second email.
  await due("ann");
  assert.equal((await q(`select nurture_advance(500) as n`))[0].n, 1);
  await q(`update nurture_enrollments set step = 1, status = 'active', next_at = now() - interval '1 minute' where nurture_id = $1 and contact_id = $2`, [nurture, contact.ann]);
  await q(`select nurture_advance(500)`);
  assert.equal((await q(`select count(*)::int n from email_messages where contact_id = $1`, [contact.ann]))[0].n, 2);
  assert.equal((await enrollment("ann")).status, "done");
});

test("people leave at a stage, on unsubscribe and when suppressed", async () => {
  await q(`update contacts set lifecycle = 'sql' where id = $1`, [contact.bob]);
  await q(`insert into subscriptions (workspace_id, contact_id, topic_id, status) values ($1, $2, $3, 'unsubscribed')`, [ws, contact.cy, topic]);
  await q(`select suppress($1, 'manual', $2)`, [ws, JSON.stringify([{ email_clean: `dee-${ws.slice(-6)}@example.com`, reason: "complained" }])]);
  for (const n of ["bob", "cy", "dee"]) await due(n);
  await q(`select nurture_advance(500)`);
  assert.equal((await enrollment("bob")).exit_reason, "reached_stage");
  assert.equal((await enrollment("cy")).exit_reason, "unsubscribed");
  assert.equal((await enrollment("dee")).exit_reason, "suppressed");
  assert.equal((await q(`select count(*)::int n from email_messages where contact_id = any($1)`, [[contact.bob, contact.cy, contact.dee]]))[0].n, 3, "only their first email");
});

test("editing a live step holds it until approved again, and mail in line keeps the approved words", async () => {
  const s2 = (await q(`select id, email_id from nurture_steps where nurture_id = $1 and position = 1`, [nurture]))[0];
  const oldSubject = (await q(`select subject from emails where id = $1`, [s2.email_id]))[0].subject;
  await addStep(3, "Proof, edited", s2.id);
  const now2 = (await q(`select email_id, approved_at from nurture_steps where id = $1`, [s2.id]))[0];
  assert.notEqual(now2.email_id, s2.email_id, "a new email");
  assert.equal(now2.approved_at, null);
  assert.equal((await q(`select subject from emails where id = $1`, [s2.email_id]))[0].subject, oldSubject, "the old one is untouched");
  await due("eli");
  await q(`select nurture_advance(500)`);
  const eli = await enrollment("eli");
  assert.equal(eli.step, 1, "held on the edited step");
  assert.ok(new Date(eli.next_at).getTime() > Date.now() + 50 * 60_000);
  await as(`select nurture_step_approve($1) as r`, [s2.id]);
  await due("eli");
  await q(`select nurture_advance(500)`);
  assert.equal((await enrollment("eli")).status, "done");
  const last = (await q(`select e.subject from email_messages m join emails e on e.id = m.email_id where m.contact_id = $1 order by m.created_at desc limit 1`, [contact.eli]))[0];
  assert.equal(last.subject, "Proof, edited");
});

test("a paused nurture holds everyone; a form nurture takes people who send the form after it goes live", async () => {
  const form = await as<string>(`select form_save($1, null, 'Demo', $2, '{}') as r`, [ws, JSON.stringify([{ key: "email", label: "Email", type: "email", maps_to: "email" }])]);
  const fn = await as<string>(`select nurture_save($1, null, 'Demo follow-up', $2, null, 'Acme demo follow-up brief text.', '{}') as r`, [ws, JSON.stringify({ kind: "form", form_id: form })]);
  const e = stepEmail({ paragraphs: ["Thanks for asking."], cta_label: "", cta_url: "" });
  const sid = await as<string>(`select nurture_step_save($1, null, 0, 'Thanks', '', $2, $3, '{}', false, '{}') as r`, [fn, e.html, e.text]);
  await as(`select nurture_step_approve($1) as r`, [sid]);
  // Before it's live: doesn't count.
  await q(`insert into contact_events (workspace_id, contact_id, kind, data, source, at) values ($1, $2, 'form.submitted', $3, 'form', now() - interval '1 hour')`, [ws, contact.ann, JSON.stringify({ form_id: form })]);
  await as(`select nurture_set_status($1, 'live') as r`, [fn]);
  await q(`insert into contact_events (workspace_id, contact_id, kind, data, source) values ($1, $2, 'form.submitted', $3, 'form')`, [ws, contact.eli, JSON.stringify({ form_id: form })]);
  await q(`select nurture_enroll($1)`, [fn]);
  const joined = await q(`select contact_id from nurture_enrollments where nurture_id = $1`, [fn]);
  assert.deepEqual(joined.map((r) => r.contact_id), [contact.eli]);
  await as(`select nurture_set_status($1, 'paused') as r`, [fn]);
  assert.equal((await q(`select nurture_advance(500) as n`))[0].n, 0);
  await as(`select nurture_set_status($1, 'live') as r`, [fn]);
  assert.equal((await q(`select nurture_advance(500) as n`))[0].n, 1);
});
