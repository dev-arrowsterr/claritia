import assert from "node:assert/strict";
import { test } from "node:test";
import { alertTitle, emailMessage, SLACK_WEBHOOK, slackMessage, type AlertFailure } from "../src/lib/alerts.ts";
import { seal } from "../src/lib/seal.ts";

process.env.SECRETS_KEY = "a-local-check-key-that-is-long-enough-1234";
process.env.RESEND_API_KEY = "re_test";
const { sendAlerts } = await import("../src/lib/alertSender.ts");

const fail = (over: Partial<AlertFailure> = {}): AlertFailure => ({ runId: "r1", test: "Checkout", environment: "staging", source: "schedule", verdict: "app_bug", reason: "Save answers 500.", failedStep: { position: 3, label: "Check: It says saved" }, ...over });

test("the title counts failures and fixes", () => {
  assert.equal(alertTitle("Shop", [fail()], []), "Shop: 1 test failed");
  assert.equal(alertTitle("Shop", [fail(), fail()], [{ healId: "h1", test: "Pay", stepLabel: "Pay" }]), "Shop: 2 tests failed, 1 fix waiting for approval");
});

test("Slack gets each failure with its reason, step and run, and a Review button per fix", () => {
  const m = slackMessage("Shop", [fail({ test: "<b>Sneaky</b> & co" })], [{ healId: "h1", test: "Pay", stepLabel: "Click Pay" }]);
  const json = JSON.stringify(m);
  assert.equal(m.text, "Shop: 1 test failed, 1 fix waiting for approval");
  assert.match(json, /&lt;b&gt;Sneaky&lt;\/b&gt; &amp; co/);
  assert.match(json, /App bug: Save answers 500\./);
  assert.match(json, /Step 3: Check: It says saved/);
  assert.match(json, /staging, schedule/);
  assert.match(json, /\/runs\/r1"/);
  assert.match(json, /"Review fix".*\/approvals\/h1"/);
});

test("long alerts are cut to 10 items with a link to the rest", () => {
  const many = Array.from({ length: 13 }, (_, i) => fail({ runId: `r${i}`, test: `T${i}` }));
  const m = slackMessage("Shop", many, []);
  assert.equal(m.blocks.length, 1 + 10 + 1);
  assert.match(JSON.stringify(m.blocks.at(-1)), /And 3 more/);
  assert.match(emailMessage("Shop", many, []).html, /And 3 more/);
});

test("the email escapes names and links each run and fix", () => {
  const e = emailMessage("Shop", [fail({ test: '<script>"x"</script>' })], [{ healId: "h9", test: "Pay", stepLabel: "Click Pay" }]);
  assert.equal(e.subject, "Shop: 1 test failed, 1 fix waiting for approval");
  assert.ok(!e.html.includes("<script>"));
  assert.match(e.html, /&lt;script&gt;&quot;x&quot;/);
  assert.match(e.html, /\/runs\/r1/);
  assert.match(e.html, /\/approvals\/h9/);
  assert.match(e.text, /Step 3: Check: It says saved/);
});

test("only Slack webhook addresses are taken", () => {
  assert.ok(SLACK_WEBHOOK.test("https://hooks.slack.com/services/T000/B000/XXXX"));
  assert.ok(!SLACK_WEBHOOK.test("http://hooks.slack.com/services/T000/B000/XXXX"));
  assert.ok(!SLACK_WEBHOOK.test("https://hooks.slack.com.evil.com/services/x"));
  assert.ok(!SLACK_WEBHOOK.test("https://example.com/hook"));
});

// The sender, with a stand-in database, Slack and Resend.
type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const SLACK = "https://hooks.slack.com/services/T1/B1/abcd";
function makeDb() {
  const db: Record<string, Row[]> = {
    alert_events: [],
    alert_settings: [{ project_id: "p1", slack_sealed: seal(SLACK), emails: ["qa@acme.com"] }],
    projects: [{ id: "p1", name: "Shop" }],
    runs: [
      { id: "r1", test_name: "Checkout", environment_name: "staging", trigger: "schedule", retry_of: null, verdict: "app_bug", verdict_reason: "Save answers 500." },
      { id: "r0", trigger: "ci" },
      { id: "r2", test_name: "Login", environment_name: "staging", trigger: "retry", retry_of: "r0", verdict: "flaky", verdict_reason: "Slow again." },
    ],
    run_steps: [{ run_id: "r1", position: 3, label: "Check: It says saved", status: "failed" }],
    heals: [
      { id: "h1", step_label: "Click Pay", status: "pending", tests: { name: "Pay" } },
      { id: "h2", step_label: "Old", status: "approved", tests: { name: "Pay" } },
    ],
  };
  const query = (table: string) => {
    const filters: ((r: Row) => boolean)[] = [];
    let patch: Row | null = null;
    const q: Row = {
      select: () => q,
      order: () => q,
      limit: () => q,
      update: (f: Row) => ((patch = f), q),
      eq: (k: string, v: unknown) => (filters.push((r) => r[k] === v), q),
      in: (k: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[k])), q),
      is: (k: string, v: unknown) => (filters.push((r) => (r[k] ?? null) === v), q),
      then: (ok: (v: unknown) => unknown) => {
        const rows = (db[table] ?? []).filter((r) => filters.every((f) => f(r)));
        if (patch) for (const r of rows) Object.assign(r, patch);
        return Promise.resolve({ data: rows.map((r) => ({ ...r })), error: null }).then(ok);
      },
    };
    return q;
  };
  const event = (id: string, over: Row) => db.alert_events.push({ id, project_id: "p1", run_id: null, heal_id: null, attempts: 0, sent_at: null, error: null, ...over });
  return { db, sb: { from: query }, event };
}
function stand(slackStatus = 200, mailStatus = 200) {
  const calls: { url: string; body: Row }[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    const status = url === SLACK ? slackStatus : mailStatus;
    return new Response(status === 200 ? "ok" : "no", { status });
  }) as typeof fetch;
  return { calls, fetchFn };
}

test("queued alerts go out as one Slack message and one email per project, then are marked sent", async () => {
  const { db, sb, event } = makeDb();
  event("e1", { kind: "failure", run_id: "r1" });
  event("e2", { kind: "failure", run_id: "r2" });
  event("e3", { kind: "heal", heal_id: "h1" });
  event("e4", { kind: "heal", heal_id: "h2" });
  const { calls, fetchFn } = stand();
  const result = await sendAlerts(sb as never, fetchFn);
  assert.deepEqual(result, { sent: 1, errors: [] });
  assert.equal(calls.length, 2);
  const slack = calls.find((c) => c.url === SLACK)!.body;
  assert.equal(slack.text, "Shop: 2 tests failed, 1 fix waiting for approval");
  // A re-run alerts under the way its first run started.
  assert.match(JSON.stringify(slack), /Login\*  ·  staging, pull request/);
  assert.match(JSON.stringify(slack), /Failed again on re-run: Slow again\./);
  // A fix already approved isn't in the alert.
  assert.ok(!JSON.stringify(slack).includes("h2"));
  const mail = calls.find((c) => c.url.includes("resend"))!.body;
  assert.deepEqual(mail.to, ["qa@acme.com"]);
  assert.equal(mail.from, "Claritia <alerts@tryclaritia.com>");
  assert.ok(db.alert_events.every((e) => e.sent_at));
  assert.equal((await sendAlerts(sb as never, fetchFn)).sent, 0, "sent twice");
});

test("when every channel fails, the alert is tried again next minute, and given up after 5 tries", async () => {
  const { db, sb, event } = makeDb();
  event("e1", { kind: "failure", run_id: "r1" });
  const { fetchFn } = stand(500, 500);
  const first = await sendAlerts(sb as never, fetchFn);
  assert.equal(first.sent, 0);
  assert.match(first.errors[0]!, /Slack answered 500.*Email answered 500/);
  assert.equal(db.alert_events[0]!.sent_at, null);
  assert.equal(db.alert_events[0]!.attempts, 1);
  for (let i = 0; i < 4; i++) await sendAlerts(sb as never, fetchFn);
  assert.ok(db.alert_events[0]!.sent_at, "kept trying forever");
  assert.equal(db.alert_events[0]!.attempts, 5);
});

test("when one channel works, the alert counts as sent, so it never repeats there", async () => {
  const { db, sb, event } = makeDb();
  event("e1", { kind: "failure", run_id: "r1" });
  const { fetchFn } = stand(200, 500);
  const r = await sendAlerts(sb as never, fetchFn);
  assert.equal(r.sent, 1);
  assert.ok(db.alert_events[0]!.sent_at);
  assert.match(db.alert_events[0]!.error, /Email answered 500/);
});

test("a fix decided before the alert went out, or a project with nowhere to send, sends nothing", async () => {
  const { db, sb, event } = makeDb();
  event("e1", { kind: "heal", heal_id: "h2" });
  const { calls, fetchFn } = stand();
  await sendAlerts(sb as never, fetchFn);
  assert.equal(calls.length, 0);
  assert.ok(db.alert_events[0]!.sent_at);
  db.alert_settings[0] = { project_id: "p1", slack_sealed: null, emails: [] };
  event("e2", { kind: "failure", run_id: "r1" });
  await sendAlerts(sb as never, fetchFn);
  assert.equal(calls.length, 0);
  assert.ok(db.alert_events[1]!.sent_at);
});
