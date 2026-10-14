// A pull request played through to a finished check, with a stand-in database and a stand-in GitHub API.
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
Object.assign(process.env, {
  GITHUB_APP_ID: "1",
  GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: "pkcs1", format: "pem" }).toString(),
  GITHUB_WEBHOOK_SECRET: "w",
  GITHUB_CLIENT_ID: "c",
  GITHUB_CLIENT_SECRET: "s",
});
const { handlePlan, syncChecks } = await import("../src/lib/githubChecks.ts");

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const SHA = "b".repeat(40);
const db: Record<string, Row[]> = {
  github_installations: [{ id: 77, workspace_id: "ws1" }],
  github_links: [{ id: "L1", workspace_id: "ws1", installation_id: 77, repo_id: 9001, repo_full_name: "acme/shop", run_on: "pull_request", enabled: true, environments: { name: "staging", base_url: "https://staging.acme.com" } }],
  github_checks: [],
  runs: [],
  run_steps: [],
};
const run = (id: string, over: Row = {}): Row => ({ id, workspace_id: "ws1", test_id: `t-${id}`, test_name: `Test ${id}`, environment_name: "staging", status: "queued", verdict: null, verdict_reason: null, error: null, duration_ms: null, finished_at: null, retry_of: null, retried_as: null, ...over });

let checkSeq = 0;
function query(table: string) {
  const filters: ((r: Row) => boolean)[] = [];
  let patch: Row | null = null;
  let del = false;
  let single = false;
  const q: Row = {
    select: () => q,
    order: () => q,
    limit: () => q,
    update: (f: Row) => ((patch = f), q),
    delete: () => ((del = true), q),
    eq: (k: string, v: unknown) => (filters.push((r) => r[k] === v), q),
    in: (k: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[k])), q),
    is: (k: string, v: unknown) => (filters.push((r) => (r[k] ?? null) === v), q),
    gte: (k: string, v: string) => (filters.push((r) => r[k] >= v), q),
    maybeSingle: () => ((single = true), q),
    then: (ok: (v: unknown) => unknown) => {
      const rows = (db[table] ?? []).filter((r) => filters.every((f) => f(r)));
      if (patch) for (const r of rows) Object.assign(r, patch);
      if (del) db[table] = (db[table] ?? []).filter((r) => !rows.includes(r));
      return Promise.resolve({ data: single ? (rows[0] ?? null) : rows.map((r) => ({ ...r })), error: null }).then(ok);
    },
  };
  return q;
}
const startedFor: string[][] = [];
let nextRuns: string[] = [];
const sb = {
  from: query,
  rpc: async (fn: string, args: Row) => {
    assert.equal(fn, "github_start_check");
    const open = db.github_checks.some((c) => c.link_id === args.p_link && c.head_sha === args.p_sha && c.status === "pending");
    if (open) return { data: [], error: null };
    for (const id of nextRuns) db.runs.push(run(id));
    startedFor.push([...nextRuns]);
    const check = { id: `C${++checkSeq}`, workspace_id: "ws1", link_id: args.p_link, installation_id: 77, repo_full_name: "acme/shop", head_sha: args.p_sha, pr_number: args.p_pr, base_url: args.p_base_url ?? "https://staging.acme.com", run_ids: [...nextRuns], check_run_id: null, status: "pending", conclusion: null, finished_count: 0, error: null, created_at: new Date().toISOString() };
    db.github_checks.push(check);
    return { data: [{ ...check }], error: null };
  },
};

// The stand-in GitHub API.
const calls: { method: string; path: string; body: Row | null }[] = [];
let failNextPatch = false;
globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
  const path = new URL(url).pathname;
  const method = init.method ?? "GET";
  const body = init.body ? JSON.parse(String(init.body)) : null;
  calls.push({ method, path, body });
  const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
  if (path === "/app/installations/77/access_tokens") return json(201, { token: "inst-token", expires_at: new Date(Date.now() + 3_600_000).toISOString() });
  if (method === "POST" && path === "/repos/acme/shop/check-runs") return json(201, { id: 5000 + calls.length });
  if (method === "PATCH" && path.startsWith("/repos/acme/shop/check-runs/")) {
    if (failNextPatch) {
      failNextPatch = false;
      return json(502, { message: "Bad gateway" });
    }
    return json(200, {});
  }
  return json(404, { message: "Not Found" });
}) as typeof fetch;

const patches = () => calls.filter((c) => c.method === "PATCH");
const setRun = (id: string, over: Row) => Object.assign(db.runs.find((r) => r.id === id)!, over);
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

test("a pull request posts a running check, follows a flaky test to its re-run, and passes", async () => {
  nextRuns = ["r1", "r2"];
  const errors = await handlePlan(sb as never, { kind: "pull_request", installationId: 77, repoId: 9001, sha: SHA, pr: 7 });
  assert.deepEqual(errors, []);
  const created = calls.find((c) => c.method === "POST" && c.path.endsWith("/check-runs"))!;
  assert.equal(created.body!.name, "Claritia (staging)");
  assert.equal(created.body!.head_sha, SHA);
  assert.equal(created.body!.status, "in_progress");
  assert.equal(created.body!.output.title, "Running 2 tests");
  const check = db.github_checks[0]!;
  assert.ok(check.check_run_id, "the check run's id isn't saved");

  // The same push again doesn't start a second check.
  await handlePlan(sb as never, { kind: "pull_request", installationId: 77, repoId: 9001, sha: SHA, pr: 7 });
  assert.equal(db.github_checks.length, 1);

  // Nothing finished: no update to GitHub.
  await syncChecks(sb as never);
  assert.equal(patches().length, 0);

  setRun("r1", { status: "passed", finished_at: ago(1000), duration_ms: 900 });
  await syncChecks(sb as never);
  assert.equal(patches().at(-1)!.body!.output.title, "1 of 2 finished");

  // r2 fails, the Judge calls it flaky, and its re-run is still going: the check stays open.
  setRun("r2", { status: "failed", verdict: "flaky", finished_at: ago(1000), retried_as: "r3" });
  db.runs.push(run("r3", { retry_of: "r2", status: "running" }));
  await syncChecks(sb as never);
  assert.equal(check.status, "pending");
  assert.notEqual(patches().at(-1)!.body!.status, "completed");

  setRun("r3", { status: "passed", finished_at: ago(500), duration_ms: 800 });
  await syncChecks(sb as never);
  const done = patches().at(-1)!.body!;
  assert.equal(done.status, "completed");
  assert.equal(done.conclusion, "success");
  assert.equal(done.output.title, "2 passed");
  assert.match(done.output.summary, /\| Test r2 \| Passed on re-run \|/);
  assert.equal(check.status, "done");
  assert.equal(check.conclusion, "success");
});

test("an app bug fails the check, and a GitHub error is tried again on the next sync", async () => {
  nextRuns = ["r4"];
  await handlePlan(sb as never, { kind: "pull_request", installationId: 77, repoId: 9001, sha: "c".repeat(40), pr: 8 });
  const check = db.github_checks.at(-1)!;
  setRun("r4", { status: "failed", verdict: "app_bug", verdict_reason: "Save answers 500.", finished_at: ago(1000) });
  db.run_steps.push({ run_id: "r4", workspace_id: "ws1", position: 3, label: "Check: It says saved", error: "not visible", status: "failed" });

  failNextPatch = true;
  const first = await syncChecks(sb as never);
  assert.equal(first.errors.length, 1);
  assert.equal(check.status, "pending");
  assert.match(check.error, /502/);

  await syncChecks(sb as never);
  const done = patches().at(-1)!.body!;
  assert.equal(done.conclusion, "failure");
  assert.equal(done.output.title, "0 passed, 1 failed (1 app bug)");
  assert.match(done.output.summary, /Failed: App bug \| Save answers 500\./);
  assert.equal(check.status, "done");
});

test("a flaky failure whose re-run never shows up fails the check after the wait", async () => {
  nextRuns = ["r5"];
  await handlePlan(sb as never, { kind: "pull_request", installationId: 77, repoId: 9001, sha: "d".repeat(40), pr: 9 });
  const check = db.github_checks.at(-1)!;
  setRun("r5", { status: "failed", verdict: "flaky", finished_at: ago(10_000) });
  await syncChecks(sb as never);
  assert.equal(check.status, "pending", "closed before the re-run had a chance to start");
  setRun("r5", { finished_at: ago(3 * 60_000) });
  await syncChecks(sb as never);
  assert.equal(check.status, "done");
  assert.equal(check.conclusion, "failure");
});

test("a check that never finishes is closed as timed out", async () => {
  nextRuns = ["r6"];
  await handlePlan(sb as never, { kind: "pull_request", installationId: 77, repoId: 9001, sha: "e".repeat(40), pr: 10 });
  const check = db.github_checks.at(-1)!;
  check.created_at = ago(4 * 3_600_000);
  await syncChecks(sb as never);
  assert.equal(check.conclusion, "timed_out");
  assert.equal(patches().at(-1)!.body!.conclusion, "timed_out");
});

test("the Re-run button on GitHub starts the same check again", async () => {
  const old = db.github_checks[0]!;
  nextRuns = ["r7"];
  await handlePlan(sb as never, { kind: "rerun", installationId: 77, checkRunId: old.check_run_id });
  const again = db.github_checks.at(-1)!;
  assert.equal(again.head_sha, old.head_sha);
  assert.equal(again.pr_number, 7);
  assert.deepEqual(again.run_ids, ["r7"]);
  // Another installation's check run id does nothing.
  const before = db.github_checks.length;
  await handlePlan(sb as never, { kind: "rerun", installationId: 999, checkRunId: old.check_run_id });
  assert.equal(db.github_checks.length, before);
});

test("removed repositories turn their links off, and uninstalling removes the installation", async () => {
  await handlePlan(sb as never, { kind: "repos_removed", installationId: 77, repoIds: [9001] });
  assert.equal(db.github_links[0]!.enabled, false);
  const before = db.github_checks.length;
  nextRuns = ["r8"];
  await handlePlan(sb as never, { kind: "pull_request", installationId: 77, repoId: 9001, sha: "f".repeat(40), pr: 11 });
  assert.equal(db.github_checks.length, before, "a turned-off link still ran");
  await handlePlan(sb as never, { kind: "uninstalled", installationId: 77 });
  assert.equal(db.github_installations.length, 0);
});
