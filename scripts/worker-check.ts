// Drives the runner service's run handler with an in-memory stand-in for Supabase, a real browser
// and a local site. Checks what it writes: step results, uploaded files and the final run.
//   CHROMIUM_PATH=/path/to/chrome node scripts/worker-check.ts

import { createServer } from "node:http";
import { seal } from "../src/lib/seal.ts";
import { handleRun } from "../worker/handle.ts";
import type { Writer } from "../worker/writer.ts";

const KEY = "a-local-check-key-that-is-long-enough-1234";
process.env.SECRETS_KEY = KEY;

const server = createServer((req, res) => {
  const path = new URL(req.url!, "http://x").pathname;
  res.writeHead(200, { "content-type": "text/html" });
  res.end(path === "/login" ? `<label>Password <input id="pw" type="password"></label><button onclick="document.body.append('Signed in')">Sign in</button>` : "<h1>Home</h1>");
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

// A tiny stand-in for the parts of the Supabase client the handler uses.
type Row = Record<string, unknown>;
const db: Record<string, Row[]> = {
  runs: [{ id: "run1", workspace_id: "ws1", locked_by: "w1", status: "running" }],
  run_steps: [
    { run_id: "run1", position: 1, kind: "do", label: "Open the login page", intent: "Open the login page", status: "pending" },
    { run_id: "run1", position: 2, kind: "do", label: "Sign in", intent: "Sign in", status: "pending" },
    { run_id: "run1", position: 3, kind: "check", label: "Check: It says welcome", intent: "It says welcome", status: "pending" },
  ],
  env_secrets: [{ name: "LOGIN_PASSWORD", environment_id: "env1", env_secret_values: { sealed: seal("pa55word-xyz", KEY) } }],
};
const uploads = new Map<string, number>();
const removed: string[] = [];
const rpcs: { fn: string; args: Record<string, unknown> }[] = [];
function query(table: string) {
  const filters: ((r: Row) => boolean)[] = [];
  let patch: Row | null = null;
  const q = {
    select: () => q,
    order: () => q,
    update: (fields: Row) => ((patch = fields), q),
    eq: (k: string, v: unknown) => (filters.push((r) => r[k] === v), q),
    in: (k: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[k])), q),
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
  rpc: async (fn: string, args: Record<string, unknown>) => (rpcs.push({ fn, args }), { data: true, error: null }),
  storage: {
    from: () => ({
      upload: async (path: string, body: Buffer) => (uploads.set(path, body.length), { error: null }),
      remove: async (paths: string[]) => (removed.push(...paths), { data: [], error: null }),
    }),
  },
};

const lock = `import { test, expect } from '@playwright/test';

test('Sign in', async ({ page }) => {
  // step 1: Open the login page
  await page.goto('/login');
  // step 2: Sign in
  await page.getByLabel('Password').fill(process.env.LOGIN_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText('Signed in')).toBeVisible();
  // step 3: check: It says welcome
  await expect(page.getByText('Welcome')).toBeVisible();
});
`;

let failures = 0;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${what}`);
  if (!ok) failures++;
};

await handleRun(sb as never, { id: "run1", workspace_id: "ws1", environment_id: "env1", base_url: base, lock, attempts: 1 }, { workerId: "w1", chromiumPath: process.env.CHROMIUM_PATH, allowPrivate: true, heartbeatMs: 200 });

const run = db.runs[0]!;
const steps = db.run_steps;
check(run.status === "failed", `the run ends as failed (${run.status})`);
check(steps[0]!.status === "passed" && steps[1]!.status === "passed" && steps[2]!.status === "failed", `steps are passed, passed, failed (${steps.map((s) => s.status).join(", ")})`);
check(/Welcome/.test(String(steps[2]!.error)), "the failed step says what was missing");
check(typeof steps[0]!.started_ms === "number" && typeof steps[0]!.duration_ms === "number", "steps get their start time and length");
check(steps.every((s) => String(s.screenshot_path).startsWith("ws1/run1/step-")), "each step's screenshot is uploaded under the workspace and run");
check(run.video_path === "ws1/run1/video.webm" && (uploads.get("ws1/run1/video.webm") ?? 0) > 1000, "the video is uploaded");
check(JSON.stringify(run.trace_paths) === '["ws1/run1/trace.zip"]', "the trace is uploaded");
check(run.console_path === "ws1/run1/console.json", "the console is uploaded");
check(typeof run.duration_ms === "number" && !!run.finished_at && run.locked_at === null, "the run gets its length and finish time and lets go of its claim");

// A run whose secret is missing ends as an error without starting a browser.
db.runs.push({ id: "run2", workspace_id: "ws1", locked_by: "w1", status: "running" });
db.run_steps.push({ run_id: "run2", position: 1, kind: "do", label: "Sign in", status: "pending" });
await handleRun(sb as never, { id: "run2", workspace_id: "ws1", environment_id: "env2", base_url: base, lock, attempts: 1 }, { workerId: "w1", chromiumPath: process.env.CHROMIUM_PATH, allowPrivate: true });
const run2 = db.runs[1]!;
check(run2.status === "error" && /Add LOGIN_PASSWORD/.test(String(run2.error)), `a missing secret ends the run with a plain error (${run2.error})`);
check(db.run_steps.find((s) => s.run_id === "run2")!.status === "skipped", "its steps are marked as skipped");

// A run taken over by another runner isn't overwritten.
db.runs.push({ id: "run3", workspace_id: "ws1", locked_by: "someone-else", status: "running" });
db.run_steps.push({ run_id: "run3", position: 1, kind: "do", label: "Open the login page", status: "pending" });
await handleRun(sb as never, { id: "run3", workspace_id: "ws1", environment_id: "env1", base_url: base, lock: lock.replace(/\/\/ step 2[\s\S]*?(?=\n\}\);)/, ""), attempts: 1 }, { workerId: "w1", chromiumPath: process.env.CHROMIUM_PATH, allowPrivate: true });
check(db.runs[2]!.status === "running" && db.runs[2]!.locked_by === "someone-else", "a run another runner took over keeps that runner's result");

// A run of a test with no code: the writer writes it, the steps record their code, and the code is saved.
db.runs.push({ id: "run4", workspace_id: "ws1", locked_by: "w1", status: "running" });
db.run_steps.push(
  { run_id: "run4", position: 1, kind: "do", label: "Open the login page", intent: "Open the login page", status: "pending" },
  { run_id: "run4", position: 2, kind: "check", label: "Check: There's a Sign in button", intent: "There's a Sign in button", status: "pending" },
);
const script: Record<number, string> = { 1: "await page.goto('/login');", 2: "await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();" };
const writer: Writer = async (r) => {
  await new Promise((ok) => setTimeout(ok, 400));
  return { lines: [script[r.position]!], done: true, problem: "", usage: { input: 5000, output: 300 } };
};
await handleRun(sb as never, { id: "run4", workspace_id: "ws1", environment_id: "env1", base_url: base, lock: "", attempts: 1, test_name: "Login page" }, { workerId: "w1", chromiumPath: process.env.CHROMIUM_PATH, allowPrivate: true, writer, frameMs: 150 });
const run4 = db.runs[3]!;
const steps4 = db.run_steps.filter((s) => s.run_id === "run4");
check(run4.status === "passed", `a test with no code is written and passes (${run4.status} ${run4.error ?? ""})`);
check(steps4.every((s) => s.written === true) && steps4[0]!.code === script[1] && steps4[1]!.code === script[2], "its steps are marked as written, with their code");
check(run4.ai_calls === 2 && run4.ai_input_tokens === 10000 && run4.ai_output_tokens === 600, "the run records its AI calls and tokens");
const save = rpcs.find((r) => r.fn === "save_written_lock");
check(save?.args.p_run === "run4" && String(save?.args.p_lock).includes("// step 2: check: There's a Sign in button") && String(save?.args.p_lock).includes(script[2]!), "the written code is saved to the test");
const frames = [...uploads.keys()].filter((k) => k.startsWith("ws1/run4/live-"));
check(frames.length > 0 && frames.every((f) => removed.includes(f)) && run4.live_path === null, `live frames go up during the run and are removed after (${frames.length})`);
check(!rpcs.some((r) => r.fn === "save_written_lock" && r.args.p_run === "run1"), "a run that wrote nothing saves nothing");

// With no writer, a test with no code ends with a plain error.
db.runs.push({ id: "run5", workspace_id: "ws1", locked_by: "w1", status: "running" });
db.run_steps.push({ run_id: "run5", position: 1, kind: "do", label: "Open", status: "pending" });
await handleRun(sb as never, { id: "run5", workspace_id: "ws1", environment_id: "env1", base_url: base, lock: "", attempts: 1 }, { workerId: "w1", chromiumPath: process.env.CHROMIUM_PATH, allowPrivate: true });
check(db.runs[4]!.status === "error" && /ANTHROPIC_API_KEY/.test(String(db.runs[4]!.error)), `without a writer, a test with no code says what's missing (${db.runs[4]!.error})`);

server.close();
console.log(failures ? `${failures} failed` : "All worker checks passed");
process.exit(failures ? 1 : 0);
