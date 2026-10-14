// Drives the runner through a sign-up that needs an emailed code and a confirm link, with a stand-in inbox and
// a local site that sends its email late, like a real mail service.
//   CHROMIUM_PATH=/path/to/chrome node scripts/inbox-check.ts
// Covers: inbox addresses, reading a code and a link, waiting on a subject, an email that never comes, an old
// email that must be ignored, the writer seeing inboxes, and the network log.

import { mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeRun, type Inbox, type InboxMail, type StepUpdate } from "../worker/runner.ts";
import type { Writer } from "../worker/writer.ts";

// The stand-in mail service. The site "sends" mail here; the runner reads it through the Inbox.
const mailbox: (InboxMail & { to: string })[] = [];
const codes = new Map<string, string>();
const send = (to: string, subject: string, text: string, html: string, delayMs: number) =>
  setTimeout(() => mailbox.push({ to, subject, text, html, receivedAt: new Date().toISOString() }), delayMs);

const server = createServer((req, res) => {
  const url = new URL(req.url!, "http://x");
  const html = (body: string) => (res.writeHead(200, { "content-type": "text/html" }), res.end(body));
  if (url.pathname === "/signup") {
    return html(`<title>Sign up</title><form method="post" action="/api/signup"><label>Email <input name="email" type="email"></label><button>Create account</button></form>`);
  }
  if (url.pathname === "/api/signup" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const email = new URLSearchParams(body).get("email") ?? "";
      const code = String(Math.floor(100000 + Math.random() * 900000));
      codes.set(email, code);
      const token = Buffer.from(email).toString("base64url");
      // The email arrives a moment later, like a real one.
      send(
        email,
        "Your Acme verification code",
        "",
        `<p>Hi! Your verification code is <b>${code}</b>.</p><p><a href="http://${req.headers.host}/confirm?t=${token}">Confirm your email</a></p><p><a href="http://${req.headers.host}/unsubscribe">Unsubscribe</a></p>`,
        1600,
      );
      // A welcome email with a stray number lands first. It must never be read as the code.
      send(email, "Welcome to Acme", "Thanks for joining Acme. Order 2024 ships soon.", "", 1000);
      res.writeHead(303, { location: `/verify?email=${encodeURIComponent(email)}` });
      res.end();
    });
    return;
  }
  if (url.pathname === "/verify") {
    const email = url.searchParams.get("email") ?? "";
    return html(`<title>Verify</title><p>We sent a code to ${email}</p><label>Code <input id="code"></label><button onclick="fetch('/api/check?email=${encodeURIComponent(email)}&code=' + document.querySelector('#code').value).then(r => r.text()).then(t => document.body.insertAdjacentHTML('beforeend', '<h1>' + t + '</h1>'))">Verify</button>`);
  }
  if (url.pathname === "/api/check") {
    res.writeHead(200, { "content-type": "text/plain" });
    return res.end(codes.get(url.searchParams.get("email") ?? "") === url.searchParams.get("code") ? "Welcome aboard" : "Wrong code");
  }
  if (url.pathname === "/confirm") {
    const email = Buffer.from(url.searchParams.get("t") ?? "", "base64url").toString();
    return html(`<title>Confirmed</title><h1>Email confirmed for ${email}</h1>`);
  }
  res.writeHead(404);
  res.end();
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

let failures = 0;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${what}`);
  if (!ok) failures++;
};

let runNo = 0;
const inboxFor = (code: string): Inbox => ({
  address: (tag) => `k7x2q9-${tag}-${code}@inbox.test`,
  read: async (address, since) => mailbox.filter((m) => m.to === address && new Date(m.receivedAt) >= since).reverse(),
});
const lock = (body: string) => `import { test, expect } from '@playwright/test';\n\ntest('Sign up', async ({ page }) => {\n${body}\n});\n`;
const run = async (body: string, positions: number[], opts: { inboxTimeoutMs?: number; writer?: Writer; inbox?: Inbox | null } = {}) => {
  const updates: StepUpdate[] = [];
  const code = `run${++runNo}`;
  const res = await executeRun(
    {
      baseUrl: base,
      lock: lock(body),
      positions,
      secrets: {},
      dir: mkdtempSync(join(tmpdir(), "claritia-inbox-")),
      chromiumPath: process.env.CHROMIUM_PATH,
      allowPrivate: true,
      expectTimeoutMs: 3000,
      actionTimeoutMs: 3000,
      inbox: opts.inbox === null ? undefined : (opts.inbox ?? inboxFor(code)),
      inboxTimeoutMs: opts.inboxTimeoutMs ?? 10_000,
      writer: opts.writer,
      steps: opts.writer ? positions.map((p) => ({ position: p, kind: "do" as const, label: `Step ${p}`, intent: `Step ${p}` })) : undefined,
    },
    { step: async (u) => void updates.push(u) },
  );
  const final = (p: number) => updates.filter((u) => u.position === p && u.status !== "running").at(-1);
  return { res, final, code };
};

const SIGN_UP = `  // step 1: Sign up with a new email
  await page.goto('/signup');
  await page.getByLabel('Email').fill(inbox.address('signup'));
  await page.getByRole('button', { name: 'Create account' }).click();`;

// 1. A code from an email that arrives late.
{
  const { res, final } = await run(
    `${SIGN_UP}
  // step 2: Enter the code from the email
  await page.getByLabel('Code').fill(inbox.code('signup'));
  await page.getByRole('button', { name: 'Verify' }).click();
  // step 3: check: Signed up
  await expect(page.getByRole('heading', { name: 'Welcome aboard' })).toBeVisible();`,
    [1, 2, 3],
  );
  check(res.status === "passed", `a sign-up with an emailed code passes (${res.status} ${res.error ?? ""} ${final(2)?.error ?? ""})`);
  check(mailbox.some((m) => m.to === "k7x2q9-signup-run1@inbox.test"), "the site sent mail to the run's inbox address");
  const net = JSON.parse(readFileSync(res.networkFile!, "utf8")) as { method: string; url: string; status: number | null; type: string }[];
  check(net.some((n) => n.method === "POST" && n.url.endsWith("/api/signup") && n.status === 303) && net.some((n) => n.url.includes("/api/check") && n.status === 200), "the network log has the sign-up post and the code check, with statuses");
}

// 2. A confirm link, picked by a pattern, and a wait on the welcome email's subject.
{
  const { res, final } = await run(
    `${SIGN_UP}
  // step 2: Open the confirm link
  await page.goto(inbox.link('signup', /confirm/));
  // step 3: check: The welcome email came
  await inbox.waitFor('signup', /Welcome/);
  await expect(page.getByRole('heading')).toContainText('Email confirmed for k7x2q9-signup-');`,
    [1, 2, 3],
  );
  check(res.status === "passed", `a confirm link opens and the welcome email is found (${res.status} ${final(2)?.error ?? ""} ${final(3)?.error ?? ""})`);
}

// 3. An email that never comes fails the step with a plain message.
{
  const { res, final } = await run(`  // step 1: Wait for mail\n  await page.goto('/signup');\n  await inbox.waitFor('nothing');`, [1], { inboxTimeoutMs: 2000 });
  check(res.status === "failed" && /No email reached k7x2q9-nothing-run3@inbox\.test within 2 seconds/.test(final(1)?.error ?? ""), `a missing email says so (${final(1)?.error})`);
}

// 4. An email from before the run is ignored.
{
  mailbox.push({ to: "k7x2q9-old-run4@inbox.test", subject: "Old", text: "Your code is 111111", html: "", receivedAt: new Date(Date.now() - 60_000).toISOString() });
  const { final } = await run(`  // step 1: Read an old code\n  await page.goto('/signup');\n  await page.getByLabel('Email').fill(inbox.code('old'));`, [1], { inboxTimeoutMs: 2000 });
  check(final(1)?.status === "failed" && /No email reached/.test(final(1)?.error ?? ""), "mail sent before the run started is ignored");
}

// 5. Mail that came but has no matching link says what was missing.
{
  const { final } = await run(`${SIGN_UP}\n  // step 2: Open a reset link\n  await page.goto(inbox.link('signup', /reset-password/));`, [1, 2], { inboxTimeoutMs: 4000 });
  check(final(2)?.status === "failed" && /reached .* but none had a link matching/.test(final(2)?.error ?? ""), `mail without the link says what was missing (${final(2)?.error})`);
}

// 6. A test that reads email can't run without inboxes.
{
  const { res } = await run(SIGN_UP, [1], { inbox: null });
  check(res.status === "error" && /test inboxes aren't set up/.test(res.error ?? ""), "a test that reads email needs inboxes");
}

// 7. The writer is told inboxes are on, and its inbox lines run.
{
  let sawInbox = false;
  const script: Record<number, string[]> = {
    1: ["await page.goto('/signup');", "await page.getByLabel('Email').fill(inbox.address('signup'));", "await page.getByRole('button', { name: 'Create account' }).click();"],
    2: ["await page.getByLabel('Code').fill(inbox.code('signup'));", "await page.getByRole('button', { name: 'Verify' }).click();", "await expect(page.getByText('Welcome aboard')).toBeVisible();"],
  };
  const writer: Writer = async (r) => {
    sawInbox = r.inbox;
    return { lines: script[r.position]!, done: true, problem: "", usage: { input: 1, output: 1 } };
  };
  const { res } = await run("", [1, 2], { writer });
  check(sawInbox && res.status === "passed" && !!res.lock && res.lock.includes("inbox.code('signup')"), `the writer uses inboxes and its code is saved (${res.status} ${res.error ?? ""})`);
}

server.close();
console.log(failures ? `${failures} failed` : "All inbox checks passed");
process.exit(failures ? 1 : 0);
