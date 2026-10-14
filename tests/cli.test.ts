import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
// @ts-expect-error The CLI is plain JavaScript with no types.
import { EXIT, exitCodeFor, main, parseArgs } from "../cli/lib.mjs";

type Outcome = { id: string; test: string; status: string; done: boolean; passed: boolean; passed_on_retry: boolean; verdict: string | null; reason: string | null; error: string | null; failed_step: { position: number; label: string; error: string | null } | null; duration_ms: number | null; url: string };
const KEY = "clr_" + "a".repeat(40);
const done = (over: Partial<Outcome>): Outcome => ({ id: "r1", test: "Checkout", status: "passed", done: true, passed: true, passed_on_retry: false, verdict: null, reason: null, error: null, failed_step: null, duration_ms: 4200, url: "https://app.tryclaritia.com/runs/r1", ...over });

// A stand-in API. Each scenario answers the polls in turn; the last answer repeats.
let polls: Outcome[][] = [];
let pollCount = 0;
let startStatus = 201;
let startError = "";
let startBody: Record<string, unknown> = {};
let pollFailures = 0;
const server = createServer((req, res) => {
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (req.headers.authorization !== `Bearer ${KEY}`) return send(401, { error: "This API key is wrong or was revoked." });
  const url = new URL(req.url!, "http://x");
  if (req.method === "POST" && url.pathname === "/api/v1/runs") {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      startBody = JSON.parse(raw);
      if (startStatus !== 201) return send(startStatus, { error: startError });
      const runs = polls.at(-1)!.map((r) => ({ id: r.id, test: r.test }));
      send(201, { project: { id: "p1", name: "Shop" }, environment: { id: "e1", name: "staging" }, runs });
    });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/v1/runs") {
    if (pollFailures > 0) {
      pollFailures--;
      return send(502, { error: "Bad gateway" });
    }
    const answer = polls[Math.min(pollCount++, polls.length - 1)]!;
    return send(200, { done: answer.every((r) => r.done), runs: answer });
  }
  if (url.pathname === "/api/v1/projects") return send(200, { projects: [{ id: "p1", name: "Shop", environments: [{ id: "e1", name: "staging", base_url: "https://staging.shop.com" }] }] });
  send(404, { error: "Not found" });
});
let base = "";
before(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(() => server.close());

async function cli(argv: string[], env: Record<string, string> = {}) {
  const lines: string[] = [];
  const errors: string[] = [];
  pollCount = 0;
  const code = await main(argv, { CLARITIA_API_KEY: KEY, CLARITIA_URL: base, CLARITIA_POLL_MS: "5", ...env }, { out: (s: string) => lines.push(s), err: (s: string) => errors.push(s) });
  return { code, out: lines.join("\n"), err: errors.join("\n") };
}

test("the command line is read, and mistakes are refused", () => {
  const o = parseArgs(["run", "--project", "Shop", "--env=staging", "--test", "Checkout", "--test", "Login", "--timeout", "10", "--json"]);
  assert.equal(o.command, "run");
  assert.equal(o.project, "Shop");
  assert.equal(o.env, "staging");
  assert.deepEqual(o.tests, ["Checkout", "Login"]);
  assert.equal(o.timeoutMin, 10);
  assert.equal(o.json, true);
  assert.equal(parseArgs(["run", "--no-wait"]).wait, false);
  assert.throws(() => parseArgs(["run", "--project"]), /needs a value/);
  assert.throws(() => parseArgs(["run", "--bogus"]), /Unknown option/);
  assert.throws(() => parseArgs(["run", "--test", "a", "--use-case", "b"]), /not both/);
  assert.throws(() => parseArgs(["run", "--timeout", "soon"]), /minutes/);
});

test("the exit code follows the worst result", () => {
  assert.equal(exitCodeFor([done({})]), EXIT.passed);
  assert.equal(exitCodeFor([done({}), done({ status: "failed", passed: false, verdict: "app_bug" })]), EXIT.failed);
  assert.equal(exitCodeFor([done({ status: "error", passed: false, verdict: "setup" })]), EXIT.setup);
  assert.equal(exitCodeFor([done({ status: "failed", passed: false }), done({ status: "error", passed: false })]), EXIT.failed);
  assert.equal(exitCodeFor([done({}), done({ done: false, status: "running", passed: false })]), EXIT.timeout);
});

test("a flaky test that passes on re-run passes the build, and each run prints as it finishes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "claritia-cli-"));
  const summaryFile = join(dir, "summary.md");
  polls = [
    [done({ id: "r1", status: "running", done: false, passed: false, duration_ms: null }), done({ id: "r2", test: "Login", status: "queued", done: false, passed: false, duration_ms: null })],
    [done({ id: "r1" }), done({ id: "r2", test: "Login", status: "failed", done: false, passed: false, verdict: "flaky" })],
    [done({ id: "r1" }), done({ id: "r2", test: "Login", passed_on_retry: true })],
  ];
  const r = await cli(["run", "--project", "Shop"], { GITHUB_STEP_SUMMARY: summaryFile });
  assert.equal(r.code, EXIT.passed, r.out + r.err);
  assert.match(r.out, /Running 2 tests of Shop on staging/);
  assert.match(r.out, /PASS {2}Checkout/);
  assert.match(r.out, /PASS {2}Login \(passed on re-run\)/);
  assert.match(r.out, /2 passed in/);
  assert.equal(r.out.match(/PASS {2}Checkout/g)?.length, 1, "a run printed twice");
  assert.deepEqual(startBody, { project: "Shop" });
  const md = await readFile(summaryFile, "utf8");
  assert.match(md, /\| Login \| Passed on re-run \|/);
});

test("an app bug fails the build and names the step, the reason and the run", async () => {
  polls = [[done({}), done({ id: "r2", test: "Settings", status: "failed", passed: false, verdict: "app_bug", reason: "Saving calls /api/save, which answers 500.", failed_step: { position: 3, label: "Check: It says saved", error: "not visible" }, url: "https://app.tryclaritia.com/runs/r2" })]];
  const r = await cli(["run", "--test", "Checkout", "--test", "Settings"]);
  assert.equal(r.code, EXIT.failed);
  assert.match(r.out, /FAIL {2}Settings {2}app bug: Saving calls \/api\/save, which answers 500\./);
  assert.match(r.out, /Step 3: Check: It says saved/);
  assert.match(r.out, /\/runs\/r2/);
  assert.match(r.out, /1 passed, 1 failed \(1 app bug\)/);
  assert.deepEqual(startBody.tests, ["Checkout", "Settings"]);
});

test("a site that can't be reached is a setup problem, with its own exit code", async () => {
  polls = [[done({ status: "error", passed: false, verdict: "setup", reason: "staging.shop.com doesn't resolve." })]];
  const r = await cli(["run"]);
  assert.equal(r.code, EXIT.setup);
  assert.match(r.out, /setup problem: staging.shop.com doesn't resolve/);
});

test("dropped connections while waiting are tried again", async () => {
  polls = [[done({})]];
  pollFailures = 4;
  const r = await cli(["run"]);
  assert.equal(r.code, EXIT.passed, r.out + r.err);
  assert.match(r.err, /Can't reach Claritia/);
});

test("waiting stops at the timeout", async () => {
  polls = [[done({ status: "running", done: false, passed: false })]];
  const r = await cli(["run", "--timeout", "0.002"]);
  assert.equal(r.code, EXIT.timeout);
  assert.match(r.out, /Timed out after 0.002 minutes/);
  assert.match(r.out, /0 passed, 1 still running/);
});

test("--json prints the results for scripts", async () => {
  polls = [[done({})]];
  const r = await cli(["run", "--json"]);
  assert.equal(r.code, EXIT.passed);
  assert.equal(JSON.parse(r.out)[0].test, "Checkout");
});

test("--no-wait starts the runs and exits", async () => {
  polls = [[done({ status: "queued", done: false, passed: false })]];
  const r = await cli(["run", "--no-wait"]);
  assert.equal(r.code, EXIT.passed);
  assert.match(r.out, /Checkout {2}http.*\/runs\/r1/);
});

test("a missing or wrong key is a usage problem", async () => {
  assert.equal((await cli(["run"], { CLARITIA_API_KEY: "" })).code, EXIT.usage);
  const wrong = await cli(["projects"], { CLARITIA_API_KEY: "clr_" + "b".repeat(40) });
  assert.equal(wrong.code, EXIT.usage);
  assert.match(wrong.err, /wrong or was revoked/);
});

test("a full queue is reported as couldn't run, and a bad request as usage", async () => {
  polls = [[done({})]];
  startStatus = 429;
  startError = "50 runs from API keys are already waiting or running in this workspace.";
  const full = await cli(["run"]);
  assert.equal(full.code, EXIT.setup);
  assert.match(full.err, /already waiting/);
  startStatus = 404;
  startError = "Test Nope not found in Shop.";
  const missing = await cli(["run", "--test", "Nope"]);
  assert.equal(missing.code, EXIT.usage);
  assert.match(missing.err, /Nope not found/);
  startStatus = 201;
});

test("projects lists each project and its environments", async () => {
  const r = await cli(["projects"]);
  assert.equal(r.code, EXIT.passed);
  assert.match(r.out, /Shop\n {2}staging {2}https:\/\/staging.shop.com/);
});
