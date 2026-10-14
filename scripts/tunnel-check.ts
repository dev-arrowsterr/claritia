// Runs and explorations on localhost, through a real tunnel, with a real browser. The app listens only on this
// machine's loopback; the runner keeps refusing private addresses, so the only way in is the tunnel.
//   CHROMIUM_PATH=/path/to/chrome node scripts/tunnel-check.ts
// Covers: a test that signs in (form post, redirect, cookie) on localhost through the tunnel, slow pages and assets,
// a run with no tunnel open (a plain setup error), a tunnel for another port, and exploring localhost.

import { createServer, type Server } from "node:http";
import { createRelay } from "../relay/relay.mjs";
import { runTunnel } from "../cli/tunnel.mjs";
import { explore, type FoundPage } from "../worker/explorer.ts";
import { judgeByRules } from "../worker/judge.ts";
import { executeRun } from "../worker/runner.ts";
import { tunnelFor } from "../worker/tunnel.ts";

const chromiumPath = process.env.CHROMIUM_PATH;
const SECRET = "a-relay-secret-that-is-long-enough-123456";
const KEY = "clr_" + "k".repeat(40);
const listen = (s: Server) => new Promise<number>((r) => s.listen(0, "127.0.0.1", () => r((s.address() as { port: number }).port)));

const app = createServer((req, res) => {
  const signedIn = /session=ok/.test(req.headers.cookie ?? "");
  const html = (body: string) => res.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><title>Local</title>${body}`);
  if (req.url === "/") return html(`<h1>Local app</h1><a href="/login">Sign in</a> <a href="/about">About</a><link rel="stylesheet" href="/slow.css">`);
  if (req.url === "/slow.css") return void setTimeout(() => res.writeHead(200, { "content-type": "text/css" }).end("h1{color:red}"), 1200);
  if (req.url === "/about") return html(`<h1>About</h1><a href="/">Home</a>`);
  if (req.url === "/login" && req.method === "POST") return void setTimeout(() => res.writeHead(302, { location: "/account", "set-cookie": "session=ok; Path=/" }).end(), 800);
  if (req.url === "/login") return html(`<h1>Sign in</h1><form method="post" action="/login"><label for="e">Email</label><input id="e" name="e"><button type="submit">Sign in</button></form>`);
  if (req.url === "/account") return signedIn ? html(`<h1>Your account</h1>`) : res.writeHead(302, { location: "/login" }).end();
  res.writeHead(404).end();
});
let tunnelId = "";
const relay = createRelay({
  secret: SECRET,
  verifyKey: async (k: string) => (k === KEY ? { workspaceId: "ws1", keyId: "k1" } : null),
  saveTunnel: async () => "tun-1",
  touchTunnel: async () => undefined,
  closeTunnel: async () => undefined,
});
const appPort = await listen(app);
const relayUrl = `ws://127.0.0.1:${await listen(relay.server)}`;
const ac = new AbortController();
void runTunnel({ key: KEY, relay: relayUrl, ports: [appPort], out: () => undefined, err: (s: string) => console.log("  tunnel:", s), signal: ac.signal, onOpen: (id: string) => (tunnelId = id) });
for (let i = 0; i < 100 && !tunnelId; i++) await new Promise((r) => setTimeout(r, 20));

let failures = 0;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${what}`);
  if (!ok) failures++;
};
const sb = (rows: unknown[]) => ({ rpc: async () => ({ data: rows, error: null }) });
const relayOpts = { url: relayUrl, secret: SECRET };
const base = `http://localhost:${appPort}`;
const lock = `import { test, expect } from '@playwright/test';

test('Sign in locally', async ({ page }) => {
  // step 1: Open the app
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Local app' })).toBeVisible();
  // step 2: Sign in
  await page.getByRole('link', { name: 'Sign in' }).click();
  await page.getByLabel('Email').fill('qa@local.test');
  await page.getByRole('button', { name: 'Sign in' }).click();
  // step 3: check: It's signed in
  await expect(page.getByRole('heading', { name: 'Your account' })).toBeVisible();
});
`;
const steps: string[] = [];
const run = async (tunnel: Awaited<ReturnType<typeof tunnelFor>>, dir: string) =>
  executeRun({ baseUrl: base, lock, positions: [1, 2, 3], secrets: {}, dir, chromiumPath, tunnel: tunnel.client, tunnelError: tunnel.error }, { step: async (u) => void steps.push(`${u.position}:${u.status}`) });

// 1. Through the tunnel: passes, with the runner still refusing private addresses.
{
  const t = await tunnelFor(sb([{ id: tunnelId, ports: [appPort] }]), "ws1", base, relayOpts);
  check(!!t.client && !t.error, `the runner connects to the open tunnel (${t.error ?? "ok"})`);
  const r = await run(t, "/tmp/claritia-tunnel-1");
  t.client?.close();
  check(r.status === "passed", `a sign-in test on localhost passes through the tunnel (${r.status} ${r.error ?? ""})`);
  check(steps.join() === "1:running,1:passed,2:running,2:passed,3:running,3:passed", `every step passed (${steps.join()})`);
}

// 2. No tunnel open: a plain setup error, no browser needed.
{
  const t = await tunnelFor(sb([]), "ws1", base, relayOpts);
  const r = await run(t, "/tmp/claritia-tunnel-2");
  check(r.status === "error" && /npx claritia tunnel/.test(r.error ?? ""), `no tunnel says how to start one (${r.error})`);
  check(judgeByRules(r.error ?? "")?.verdict === "setup", "the Judge sorts it as setup, with no AI call");
}

// 3. A tunnel for another port.
{
  const t = await tunnelFor(sb([{ id: tunnelId, ports: [5173] }]), "ws1", base, relayOpts);
  check(!t.client && /not localhost:\d+/.test(t.error ?? ""), `a tunnel for another port is named (${t.error})`);
}

// 4. Without a tunnel the runner still can't reach localhost.
{
  const r = await executeRun({ baseUrl: base, lock, positions: [1, 2, 3], secrets: {}, dir: "/tmp/claritia-tunnel-4", chromiumPath }, { step: async () => undefined });
  check(r.status === "failed" && /private network/.test(r.error ?? ""), `with no tunnel, localhost stays blocked (${r.error?.slice(0, 90)})`);
}

// 5. Exploring localhost through the tunnel.
{
  const t = await tunnelFor(sb([{ id: tunnelId, ports: [appPort] }]), "ws1", base, relayOpts);
  const found: FoundPage[] = [];
  const r = await explore({ baseUrl: base, maxPages: 10, dir: "/tmp/claritia-tunnel-5", chromiumPath, tunnel: t.client, pageTimeoutMs: 8000 }, async (p) => void found.push(p));
  t.client?.close();
  const patterns = found.map((p) => p.pattern).sort();
  check(r.status === "done" && patterns.includes("/about") && patterns.includes("/login"), `the Explorer maps localhost through the tunnel (${patterns.join(" ")})`);
}

ac.abort();
await relay.close();
app.closeAllConnections();
app.close();
console.log(failures ? `${failures} failed` : "All tunnel checks passed");
process.exit(failures ? 1 : 0);
