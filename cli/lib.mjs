// The Claritia CLI: run a project's tests in the cloud from a terminal or CI, and wait for the results.
// No dependencies. Talks to the REST API at /api/v1 with a workspace API key.

import { appendFile } from "node:fs/promises";

export const VERSION = "0.1.0";

export const EXIT = { passed: 0, failed: 1, setup: 2, usage: 3, timeout: 4 };

const HELP = `claritia ${VERSION}

Usage
  claritia run [options]       Run tests in the cloud and wait for the results
  claritia projects            List projects and their environments
  claritia tests [--project]   List a project's tests

Run options
  --project <name or id>       Needed when the workspace has more than one project
  --env <name or id>           The environment to run on (default: the project's first)
  --test <name or id>          A test to run. Repeat for more. Default: every test
  --use-case <name>            Run every test in one use case
  --no-wait                    Start the runs and exit
  --timeout <minutes>          Stop waiting after this long (default 30)
  --json                       Print the results as JSON

Environment
  CLARITIA_API_KEY             Your API key, from Settings → API keys
  CLARITIA_URL                 The app's address (default https://app.tryclaritia.com)

Exit codes
  0 every test passed   1 a test failed   2 a test couldn't run (setup)
  3 a usage or API key problem   4 timed out`;

/** Parse the command line. Throws on anything it doesn't know. */
export function parseArgs(argv) {
  const opts = { command: "", tests: [], wait: true, timeoutMin: 30, json: false, help: false, version: false };
  const takes = new Set(["--project", "--env", "--test", "--use-case", "--timeout"]);
  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i];
    let value;
    const eq = arg.indexOf("=");
    if (arg.startsWith("--") && eq > 0) {
      value = arg.slice(eq + 1);
      arg = arg.slice(0, eq);
    }
    if (takes.has(arg)) {
      if (value === undefined) value = argv[++i];
      if (value === undefined || value === "") throw new Error(`${arg} needs a value.`);
    }
    switch (arg) {
      case "--project":
        opts.project = value;
        break;
      case "--env":
        opts.env = value;
        break;
      case "--test":
        opts.tests.push(value);
        break;
      case "--use-case":
        opts.useCase = value;
        break;
      case "--timeout": {
        const n = Number(value);
        if (!Number.isFinite(n) || n <= 0) throw new Error("--timeout is a number of minutes.");
        opts.timeoutMin = n;
        break;
      }
      case "--no-wait":
        opts.wait = false;
        break;
      case "--json":
        opts.json = true;
        break;
      case "-h":
      case "--help":
        opts.help = true;
        break;
      case "-v":
      case "--version":
        opts.version = true;
        break;
      default:
        if (arg.startsWith("-") || opts.command) throw new Error(`Unknown option ${arg}.`);
        opts.command = arg;
    }
  }
  if (opts.tests.length && opts.useCase) throw new Error("Pick --test or --use-case, not both.");
  return opts;
}

/** The exit code for a finished set of runs. */
export function exitCodeFor(runs) {
  if (runs.some((r) => !r.done)) return EXIT.timeout;
  if (runs.some((r) => !r.passed && r.status === "failed")) return EXIT.failed;
  if (runs.some((r) => !r.passed)) return EXIT.setup;
  return EXIT.passed;
}

const seconds = (ms) => (ms == null ? "" : ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`);
const VERDICT = { app_bug: "app bug", flaky: "flaky", setup: "setup problem" };

/** One finished run, as lines for the terminal. */
export function describe(r) {
  if (r.passed) return [`PASS  ${r.test}${r.passed_on_retry ? " (passed on re-run)" : ""}  ${seconds(r.duration_ms)}`];
  const kind = r.status === "canceled" ? "canceled" : (VERDICT[r.verdict] ?? (r.status === "error" ? "couldn't run" : "failed"));
  const lines = [`FAIL  ${r.test}  ${kind}${r.reason ? `: ${r.reason}` : ""}`];
  if (r.failed_step) lines.push(`      Step ${r.failed_step.position}: ${r.failed_step.label}`);
  else if (r.error && !r.reason) lines.push(`      ${r.error.split("\n")[0]}`);
  lines.push(`      ${r.url}`);
  return lines;
}

export function summary(runs, ms) {
  const passed = runs.filter((r) => r.done && r.passed).length;
  const failed = runs.filter((r) => r.done && !r.passed).length;
  const waiting = runs.length - passed - failed;
  const bugs = runs.filter((r) => r.done && !r.passed && r.verdict === "app_bug").length;
  const parts = [`${passed} passed`];
  if (failed) parts.push(`${failed} failed${bugs ? ` (${bugs} app ${bugs === 1 ? "bug" : "bugs"})` : ""}`);
  if (waiting) parts.push(`${waiting} still running`);
  return `${parts.join(", ")} in ${seconds(ms)}`;
}

/** A Markdown table for the GitHub Actions job summary. */
export function markdown(runs, env) {
  const rows = runs.map((r) => {
    const result = !r.done ? "Still running" : r.passed ? (r.passed_on_retry ? "Passed on re-run" : "Passed") : `Failed${r.verdict ? `: ${VERDICT[r.verdict]}` : ""}`;
    const why = (r.reason ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
    return `| ${r.test.replace(/\|/g, "\\|")} | ${result} | ${why} | [Open](${r.url}) |`;
  });
  return [`### Claritia on ${env}`, "", "| Test | Result | Why | Run |", "| --- | --- | --- | --- |", ...rows, ""].join("\n");
}

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

function client(env, fetchFn) {
  const key = env.CLARITIA_API_KEY?.trim();
  if (!key) throw new ApiError("Set CLARITIA_API_KEY. Make a key in Claritia → Settings → API keys.", 401);
  const base = (env.CLARITIA_URL?.trim() || "https://app.tryclaritia.com").replace(/\/+$/, "");
  return async (method, path, body) => {
    const res = await fetchFn(`${base}/api/v1${path}`, {
      method,
      headers: { Authorization: `Bearer ${key}`, ...(body ? { "Content-Type": "application/json" } : {}), "User-Agent": `claritia-cli/${VERSION}` },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(data.error ?? `The API answered ${res.status}.`, res.status);
    return data;
  };
}

/** Run the CLI. Returns the exit code. */
export async function main(argv, env = process.env, io = {}) {
  const out = io.out ?? ((s) => process.stdout.write(`${s}\n`));
  const err = io.err ?? ((s) => process.stderr.write(`${s}\n`));
  const fetchFn = io.fetch ?? fetch;
  const sleep = io.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = io.now ?? Date.now;
  const pollMs = Number(env.CLARITIA_POLL_MS) || 5000;

  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    err(`${e.message}\n\n${HELP}`);
    return EXIT.usage;
  }
  if (opts.version) return out(VERSION), EXIT.passed;
  if (opts.help || !opts.command) return out(HELP), opts.help ? EXIT.passed : EXIT.usage;

  try {
    const api = client(env, fetchFn);

    if (opts.command === "projects") {
      const { projects } = await api("GET", "/projects");
      if (opts.json) return out(JSON.stringify(projects, null, 2)), EXIT.passed;
      for (const p of projects) {
        out(p.name);
        for (const e of p.environments) out(`  ${e.name}  ${e.base_url}`);
      }
      return EXIT.passed;
    }

    if (opts.command === "tests") {
      const q = opts.project ? `?project=${encodeURIComponent(opts.project)}` : "";
      const { tests } = await api("GET", `/tests${q}`);
      if (opts.json) return out(JSON.stringify(tests, null, 2)), EXIT.passed;
      for (const t of tests) out(`${t.use_case} / ${t.name}${t.steps ? "" : "  (no steps)"}`);
      return EXIT.passed;
    }

    if (opts.command !== "run") {
      err(`Unknown command ${opts.command}.\n\n${HELP}`);
      return EXIT.usage;
    }

    const started = now();
    const body = { project: opts.project, environment: opts.env };
    if (opts.tests.length) body.tests = opts.tests;
    if (opts.useCase) body.use_case = opts.useCase;
    const start = await api("POST", "/runs", body);
    const ids = start.runs.map((r) => r.id);
    if (!opts.json) out(`Running ${ids.length} ${ids.length === 1 ? "test" : "tests"} of ${start.project.name} on ${start.environment.name}`);
    if (!opts.wait) {
      if (opts.json) out(JSON.stringify(start.runs, null, 2));
      else for (const r of start.runs) out(`  ${r.test}  ${(env.CLARITIA_URL?.trim() || "https://app.tryclaritia.com").replace(/\/+$/, "")}/runs/${r.id}`);
      return EXIT.passed;
    }

    // Wait, printing each run as it finishes. A dropped connection is tried again until the timeout.
    const deadline = started + opts.timeoutMin * 60_000;
    const shown = new Set();
    let runs = [];
    let misses = 0;
    while (true) {
      try {
        ({ runs } = await api("GET", `/runs?ids=${ids.join(",")}`));
        misses = 0;
      } catch (e) {
        if (e instanceof ApiError && (e.status === 401 || e.status === 404)) throw e;
        if (++misses % 3 === 0) err(`Can't reach Claritia (${e.message}). Trying again.`);
      }
      for (const r of runs) {
        if (r.done && !shown.has(r.id)) {
          shown.add(r.id);
          if (!opts.json) for (const line of describe(r)) out(line);
        }
      }
      if (runs.length && runs.every((r) => r.done)) break;
      if (now() >= deadline) break;
      await sleep(now() - started > 120_000 ? pollMs * 2 : pollMs);
    }

    if (!runs.length) {
      err(`Timed out after ${opts.timeoutMin} minutes without reaching Claritia.`);
      return EXIT.timeout;
    }
    const code = exitCodeFor(runs);
    if (opts.json) out(JSON.stringify(runs, null, 2));
    else {
      if (code === EXIT.timeout) out(`Timed out after ${opts.timeoutMin} minutes.`);
      out(summary(runs, now() - started));
    }
    if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, markdown(runs, start.environment.name)).catch(() => undefined);
    return code;
  } catch (e) {
    err(e.message);
    // A wrong key or request is a usage problem. A full queue, a server error or no connection means it couldn't run.
    const status = e instanceof ApiError ? e.status : 0;
    return status >= 400 && status < 500 && status !== 429 ? EXIT.usage : EXIT.setup;
  }
}
