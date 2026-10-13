// Drives the runner against a tiny local site and checks the results. Needs Chromium.
//   CHROMIUM_PATH=/path/to/chrome node scripts/runner-check.ts
// Covers: a passing login with secrets, a failing check, a step that passes on retry,
// a blocked private address, and that secret values never reach errors, console logs or traces.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeRun, isPrivateAddress, maskSecrets, type StepUpdate } from "../worker/runner.ts";

const PASSWORD = "hunter2-very-secret";
const pages: Record<string, string> = {
  "/login": `<title>Log in</title><form onsubmit="event.preventDefault(); console.log('typed ' + document.querySelector('#pw').value); location.href='/dashboard?u=' + encodeURIComponent(document.querySelector('#email').value)">
    <label>Email <input id="email" name="email"></label><label>Password <input id="pw" type="password"></label><button>Sign in</button></form>`,
  "/dashboard": `<title>Dashboard</title><h1 id="hello"></h1><script>document.querySelector('#hello').textContent = 'Welcome, ' + new URLSearchParams(location.search).get('u')</script>`,
};
// The first visit to /flaky has no Ready button; later visits do. Like a page that's slow once.
let flakyVisits = 0;
const server = createServer((req, res) => {
  const path = new URL(req.url!, "http://x").pathname;
  if (path === "/flaky") pages[path] = ++flakyVisits === 1 ? "<title>Flaky</title>" : "<title>Flaky</title><button>Ready</button>";
  res.writeHead(pages[path] ? 200 : 404, { "content-type": "text/html" });
  res.end(pages[path] ?? "not found");
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const chromiumPath = process.env.CHROMIUM_PATH;
let failures = 0;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${what}`);
  if (!ok) failures++;
};
const lock = (body: string) => `import { test, expect } from '@playwright/test';\n\ntest('Check', async ({ page }) => {\n${body}\n});\n`;
const run = async (body: string, positions: number[], opts: { allowPrivate?: boolean } = {}) => {
  const updates: StepUpdate[] = [];
  const dir = mkdtempSync(join(tmpdir(), "claritia-run-"));
  const res = await executeRun(
    { baseUrl: base, lock: lock(body), positions, secrets: { LOGIN_EMAIL: "qa@acme.com", LOGIN_PASSWORD: PASSWORD }, dir, chromiumPath, allowPrivate: opts.allowPrivate ?? true, expectTimeoutMs: 2000, actionTimeoutMs: 3000 },
    { step: async (u) => void updates.push(u) },
  );
  const final = (p: number) => updates.filter((u) => u.position === p && u.status !== "running").at(-1);
  return { res, updates, final, dir };
};

// Pure helpers
check(isPrivateAddress("10.1.2.3") && isPrivateAddress("127.0.0.1") && isPrivateAddress("169.254.169.254") && isPrivateAddress("::1") && isPrivateAddress("::ffff:192.168.1.1") && isPrivateAddress("fd00::1"), "private addresses are caught");
check(!isPrivateAddress("8.8.8.8") && !isPrivateAddress("2606:4700::1111"), "public addresses are allowed");
check(maskSecrets(`pw=${PASSWORD}`, { P: PASSWORD }) === "pw=••••", "secrets are masked in text");

// 1. A passing login that uses secrets, plus a step with no code yet.
{
  const { res, final } = await run(
    `  // step 1: Sign in
  await page.goto('/login');
  await page.getByLabel('Email').fill(process.env.LOGIN_EMAIL);
  await page.getByLabel('Password').fill(process.env.LOGIN_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  // step 2: check: The dashboard greets the user
  await expect(page).toHaveURL(/dashboard/);
  await expect(page.locator('#hello')).toHaveText('Welcome, qa@acme.com');
  await expect(page.getByText('Error')).not.toBeVisible();
  // step 3: Not written yet`,
    [1, 2, 3],
  );
  check(res.status === "passed", `login run passes (${res.status} ${res.error ?? ""})`);
  check(final(1)?.status === "passed" && final(2)?.status === "passed", "steps 1 and 2 pass");
  check(final(3)?.status === "skipped" && /No code/.test(final(3)?.error ?? ""), "a step with no code is skipped");
  check(!!res.video && existsSync(res.video) && statSync(res.video).size > 1000, "a video is saved");
  check(res.traces.length === 1 && existsSync(res.traces[0]!), "a trace is saved");
  const consoleText = readFileSync(res.consoleFile!, "utf8");
  check(consoleText.includes("typed ••••") && !consoleText.includes(PASSWORD), "the page's console is saved with the secret hidden");
  const inTraces = res.traces.some((t) => execFileSync("unzip", ["-p", t]).toString("latin1").includes(PASSWORD));
  check(!inTraces, "the password isn't in any trace file");
  check(existsSync(join(res.consoleFile!, "..", "step-1.jpg")), "a screenshot is saved after each step");
}

// 2. A failing check stops the run and skips the rest.
{
  const { res, final } = await run(
    `  // step 1: Open the dashboard
  await page.goto('/dashboard?u=Sam');
  // step 2: check: It says goodbye
  await expect(page.locator('#hello')).toHaveText('Goodbye');
  // step 3: Never reached
  await page.goto('/login');`,
    [1, 2, 3],
  );
  check(res.status === "failed", "a failing check fails the run");
  check(final(2)?.status === "failed" && /Expected .*Goodbye.*Got: "Welcome, Sam"/.test(final(2)?.error ?? ""), `the failure says what was expected and what was found (${final(2)?.error})`);
  check(final(2)?.retried === true, "a failed step was tried twice");
  check(final(3)?.status === "skipped", "steps after a failure are skipped");
}

// 3. A slow element passes on the retry.
{
  const { res, final } = await run(
    `  // step 1: Wait for the Ready button
  await page.goto('/flaky');
  await expect(page.getByRole('button', { name: 'Ready' })).toBeVisible();`,
    [1],
  );
  check(res.status === "passed" && final(1)?.retried === true, `a step that passes on retry passes, marked as retried (${res.status})`);
}

// 4. A secret never shows in an error.
{
  const { final } = await run(
    `  // step 1: Look for the password on screen
  await page.goto('/login');
  await page.getByLabel('Email').fill(process.env.LOGIN_PASSWORD);
  await expect(page.getByLabel('Email')).toHaveValue('nope');`,
    [1],
  );
  check(final(1)?.status === "failed" && !(final(1)?.error ?? "").includes(PASSWORD) && (final(1)?.error ?? "").includes("••••"), `the secret is hidden in the error (${final(1)?.error})`);
}

// 5. Private addresses are blocked in real runs.
{
  const { res, final } = await run(`  // step 1: Open a private address\n  await page.goto('/login');`, [1], { allowPrivate: false });
  check(res.status === "failed" && /blocked 127\.0\.0\.1/.test(final(1)?.error ?? ""), `a private address is blocked (${final(1)?.error})`);
}

// 6. Missing secrets and bad code stop before the browser starts.
{
  const missing = await executeRun({ baseUrl: base, lock: lock(`  // step 1: x\n  await page.getByLabel('A').fill(process.env.API_TOKEN);`), positions: [1], secrets: {}, dir: mkdtempSync(join(tmpdir(), "c-")), chromiumPath }, { step: async () => {} });
  check(missing.status === "error" && /Add API_TOKEN/.test(missing.error ?? ""), "a missing secret is reported by name");
  const bad = await executeRun({ baseUrl: base, lock: lock(`  // step 1: x\n  await page.evaluate(() => 1);`), positions: [1], secrets: {}, dir: mkdtempSync(join(tmpdir(), "c-")), chromiumPath }, { step: async () => {} });
  check(bad.status === "error" && /line 5/.test(bad.error ?? ""), `code outside the allowed list is refused (${bad.error})`);
}

server.close();
console.log(failures ? `${failures} failed` : "All runner checks passed");
process.exit(failures ? 1 : 0);
