// Drives the Judge through the run handler, with a stand-in database, a scripted stand-in for Claude, a real browser
// and a local site with a real app bug and a flaky page.
//   CHROMIUM_PATH=/path/to/chrome node scripts/judge-check.ts
// Covers: the evidence the Judge gets (screenshot, console errors, failed requests, retry), its verdict saved on the
// run, setup problems sorted by rule with no AI call, passing runs never judged, no credits left, and a Judge error.

import { createServer } from "node:http";
import { handleRun } from "../worker/handle.ts";
import type { Judge, JudgeRequest, JudgeReply } from "../worker/judge.ts";

process.env.SECRETS_KEY = "a-local-check-key-that-is-long-enough-1234";

const server = createServer((req, res) => {
  const path = new URL(req.url!, "http://x").pathname;
  if (path === "/api/save") {
    res.writeHead(500, { "content-type": "application/json" });
    return res.end('{"error":"db down"}');
  }
  res.writeHead(200, { "content-type": "text/html" });
  // A real app bug: saving calls an API that answers 500, logs an error, and shows nothing.
  if (path === "/settings") return res.end(`<title>Settings</title><button onclick="fetch('/api/save', { method: 'POST' }).then(r => { if (!r.ok) console.error('Save failed: ' + r.status) })">Save</button>`);
  // A flaky page: the Saved message shows up after 20 seconds, later than the test and its retry wait.
  if (path === "/slow") return res.end(`<title>Slow</title><script>setTimeout(() => document.body.insertAdjacentHTML('beforeend', '<p>Saved</p>'), 20000)</script>`);
  res.end("<title>Home</title>");
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

type Row = Record<string, unknown>;
const db: Record<string, Row[]> = { runs: [], run_steps: [], workspaces: [{ id: "ws1", first_pass_at: null }] };
const usage = { credits_used: 0, credits_limit: 200 as number | null };
function query(table: string) {
  const filters: ((r: Row) => boolean)[] = [];
  let patch: Row | null = null;
  const q = {
    select: () => q,
    order: () => q,
    limit: () => q,
    update: (fields: Row) => ((patch = fields), q),
    eq: (k: string, v: unknown) => (filters.push((r) => r[k] === v), q),
    in: (k: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[k])), q),
    is: (k: string, v: unknown) => (filters.push((r) => (r[k] ?? null) === v), q),
    gte: () => q,
    then: (ok: (v: { data: Row[]; error: null }) => unknown) => {
      const rows = (db[table] ?? []).filter((r) => filters.every((f) => f(r)));
      if (patch) for (const r of rows) Object.assign(r, patch);
      return Promise.resolve({ data: rows, error: null }).then(ok);
    },
  };
  return q;
}
const sb = {
  from: query,
  rpc: async (fn: string) => ({ data: fn === "workspace_usage" ? [usage] : true, error: null }),
  storage: { from: () => ({ upload: async () => ({ error: null }), remove: async () => ({ data: [], error: null }) }) },
};

let failures = 0;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${what}`);
  if (!ok) failures++;
};

let n = 0;
const lockOf = (body: string) => `import { test, expect } from '@playwright/test';\n\ntest('Check', async ({ page }) => {\n${body}\n});\n`;
async function judged(body: string, steps: { kind: string; label: string }[], judge: Judge | undefined, baseUrl = base) {
  const id = `run${++n}`;
  db.runs.push({ id, workspace_id: "ws1", locked_by: "w1", status: "running" });
  steps.forEach((s, i) => db.run_steps.push({ run_id: id, position: i + 1, kind: s.kind, label: s.label, intent: s.label.replace(/^Check: /, ""), status: "pending" }));
  await handleRun(sb as never, { id, workspace_id: "ws1", environment_id: null, base_url: baseUrl, lock: lockOf(body), attempts: 1, test_name: "Settings" }, { workerId: "w1", chromiumPath: process.env.CHROMIUM_PATH, allowPrivate: true, judge });
  return db.runs.find((r) => r.id === id)!;
}
function scripted(reply: Omit<JudgeReply, "usage">) {
  const seen: JudgeRequest[] = [];
  const judge: Judge = async (r) => (seen.push(r), { ...reply, usage: { input: 3000, output: 200 } });
  return { judge, seen };
}

// 1. A real app bug: the Judge sees the 500 and the console error, and its verdict is saved.
{
  const { judge, seen } = scripted({ verdict: "app_bug", reason: "Saving calls /api/save, which answers 500." });
  const run = await judged(
    `  // step 1: Open settings\n  await page.goto('/settings');\n  // step 2: Save\n  await page.getByRole('button', { name: 'Save' }).click();\n  // step 3: check: It says saved\n  await expect(page.getByText('Saved')).toBeVisible();`,
    [{ kind: "do", label: "Open settings" }, { kind: "do", label: "Save" }, { kind: "check", label: "Check: It says saved" }],
    judge,
  );
  const r = seen[0];
  check(run.status === "failed" && run.verdict === "app_bug" && run.verdict_reason === "Saving calls /api/save, which answers 500.", `the verdict and reason are saved on the run (${run.verdict})`);
  check(!!r && r.failed.position === 3 && r.failed.kind === "check" && /Saved/.test(r.failed.error) && r.failed.retried, "the Judge gets the failed step, its error and that it was retried");
  check(!!r && /expect\(page.getByText\('Saved'\)\)/.test(r.failed.code), "the Judge gets the step's code");
  check(!!r && r.failedRequests.some((x) => /^POST 500 .*\/api\/save$/.test(x)), `the Judge gets the failed request (${r?.failedRequests.join(" | ")})`);
  check(!!r && r.consoleErrors.some((x) => /Save failed: 500/.test(x)), "the Judge gets the console error");
  check(!!r && !!r.screenshot && r.screenshot.length > 1000, "the Judge gets a screenshot of the page");
  check(!!r && r.steps.map((s) => s.status).join() === "passed,passed,failed", "the Judge sees which steps passed");
  check(run.ai_calls === 1 && run.ai_input_tokens === 3000, "the Judge's call is counted");
}

// 2. A flaky page: nothing failed on the page, the text was just late. The evidence says so.
{
  const { judge, seen } = scripted({ verdict: "flaky", reason: "The Saved message appeared after the wait ended." });
  const run = await judged(`  // step 1: Open the page\n  await page.goto('/slow');\n  // step 2: check: It says saved\n  await expect(page.getByText('Saved')).toBeVisible();`, [{ kind: "do", label: "Open the page" }, { kind: "check", label: "Check: It says saved" }], judge);
  const r = seen[0];
  check(run.verdict === "flaky", `a flaky failure is saved as flaky (${run.verdict})`);
  check(!!r && r.failedRequests.length === 0 && r.consoleErrors.length === 0 && r.failed.retried, "on a flaky page the Judge sees no errors and no failed requests");
}

// 3. A site that doesn't resolve is a setup problem, sorted by rule with no AI call.
{
  const { judge, seen } = scripted({ verdict: "app_bug", reason: "wrong" });
  const run = await judged(`  // step 1: Open the site\n  await page.goto('/');`, [{ kind: "do", label: "Open the site" }], judge, "http://claritia-nowhere.invalid");
  check(run.verdict === "setup" && /doesn't resolve/.test(String(run.verdict_reason)) && seen.length === 0, `an unreachable site is setup, with no AI call (${run.verdict}: ${run.verdict_reason})`);
}

// 4. A passing run is never judged.
{
  const { judge, seen } = scripted({ verdict: "app_bug", reason: "wrong" });
  const run = await judged(`  // step 1: Open home\n  await page.goto('/');`, [{ kind: "do", label: "Open home" }], judge);
  check(run.status === "passed" && run.verdict === null && seen.length === 0, "a passing run isn't judged");
}

// 5. With no AI credits left, the Judge isn't called and the run still finishes.
{
  usage.credits_used = 200;
  const { judge, seen } = scripted({ verdict: "flaky", reason: "x" });
  const run = await judged(`  // step 1: Open the page\n  await page.goto('/slow');\n  // step 2: check: It says saved\n  await expect(page.getByText('Saved')).toBeVisible();`, [{ kind: "do", label: "Open the page" }, { kind: "check", label: "Check: It says saved" }], judge);
  check(run.status === "failed" && run.verdict === null && seen.length === 0, "with no credits left, the failure isn't judged");
  usage.credits_used = 0;
}

// 6. A Judge that errors leaves no verdict, and the run still finishes.
{
  const broken: Judge = async () => {
    throw new Error("529");
  };
  const run = await judged(`  // step 1: Open the page\n  await page.goto('/slow');\n  // step 2: check: It says saved\n  await expect(page.getByText('Saved')).toBeVisible();`, [{ kind: "do", label: "Open the page" }, { kind: "check", label: "Check: It says saved" }], broken);
  check(run.status === "failed" && run.verdict === null && !!run.finished_at, "a Judge error leaves no verdict and the run finishes");
}

server.close();
console.log(failures ? `${failures} failed` : "All judge checks passed");
process.exit(failures ? 1 : 0);
