// End to end: Chromium loads a page that installs claritia.js through a proxy path (mode A), the proxy forwards to
// collect with the site's proxy secret, and collect writes to a real Postgres built from the migrations.
// scripts/test-db.sh runs it when CHROMIUM_PATH is set.
//   PG_URL=… CHROMIUM_PATH=… node scripts/collect-check.ts

import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import pw from "playwright-core";
import { createApp } from "../collect/app.ts";
import { WriteBuffer } from "../collect/buffer.ts";
import { PgStore } from "../collect/store.ts";

const url = process.env.PG_URL;
if (!url) throw new Error("PG_URL is not set");
const store = new PgStore(url, 4);
const q = async (sql: string, p: unknown[] = []) => (await store.pool.query(sql, p)).rows;
const WS = "44444444-4444-4444-8444-444444444444";
await q(`insert into workspaces (id, name) values ($1, 'collect check') on conflict do nothing`, [WS]);
const [site] = await q(`insert into sites (workspace_id, domain, private_paths) values ($1, 'localhost.test', '{/account}') returning id, site_key, proxy_secret`, [WS]);

const code = await readFile(new URL("../collect/dist/s.js", import.meta.url), "utf8");
const buffer = new WriteBuffer(store, { flushMs: 200 });
const { app } = createApp({
  store,
  secret: "collect-check-secret-0123456789abcdef",
  geo: () => ({ country: "US", subdivision: "NY", city: "New York", asn: 7922 }),
  script: { code, tag: "0000000000" },
  buffer,
  devOrigins: ["localhost"],
});
buffer.start();

const page = (path: string) => `<!doctype html><title>Check ${path}</title>
<script defer src="/_clr/s.js" data-site="${site.site_key}"></script>
<body style="height:3000px"><h1>${path}</h1><button id="cta">Book a demo</button>
<form id="f" onsubmit="event.preventDefault()"><input type="email" name="e"><input type="password" name="p"><button>Send</button></form></body>`;

// The customer's site: pages, and /_clr/* forwarded to collect with the proxy secret and the visitor's IP.
const server = createServer(async (req, res) => {
  const u = new URL(req.url!, "http://localhost");
  if (!u.pathname.startsWith("/_clr/")) return void res.writeHead(200, { "content-type": "text/html" }).end(page(u.pathname));
  let body = "";
  for await (const c of req) body += c;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
  headers.set("x-clr-proxy", site.proxy_secret);
  headers.set("x-clr-client-ip", "198.51.100.7");
  const r = await app.fetch(new Request("http://collect" + u.pathname.slice(5) + u.search, { method: req.method, headers, body: req.method === "POST" ? body : undefined }));
  if (process.env.DEBUG) console.log(req.method, u.pathname, r.status);
  const out: Record<string, string | string[]> = {};
  r.headers.forEach((v, k) => (out[k] = v));
  const cookies = r.headers.getSetCookie();
  if (cookies.length) out["set-cookie"] = cookies;
  res.writeHead(r.status, out).end(Buffer.from(await r.arrayBuffer()));
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://localhost:${(server.address() as { port: number }).port}`;

let failures = 0;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${what}`);
  if (!ok) failures++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (fn: () => Promise<boolean>, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(100);
  }
  return fn();
};
const hide = (p: pw.Page) =>
  p.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  });

const browser = await pw.chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH });
// Headless Chrome says so in its user agent, and collect drops it as a bot. Look like a normal browser.
const ctx = await browser.newContext({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36" });
const tab = await ctx.newPage();
await tab.goto(`${base}/pricing?utm_source=check&email=jane@acme.com`);

check(await until(async () => (await q(`select count(*)::int n from sessions where site_id = $1`, [site.id]))[0].n === 1), "a session is written");
const [s] = await q(`select * from sessions where site_id = $1`, [site.id]);
check(s.policy === "notice" && s.ip_net === "198.51.100.0/24" && s.ip_kind === "proxy", `policy and network from the proxy (${s.policy}, ${s.ip_net}, ${s.ip_kind})`);
check(s.landing_path === "/pricing?utm_source=check" && s.source === "check", `landing is scrubbed (${s.landing_path})`);
check(await until(async () => !!(await ctx.cookies()).find((c) => c.name === "_clr_id")), "the device cookie is set");
check(!!(await ctx.cookies()).find((c) => c.name === "_clr_id")?.httpOnly, "the device cookie is HttpOnly");
check(!!s.device_id, "the session has a device");

for (let i = 0; i < 3; i++) {
  await tab.mouse.move(50 + i * 20, 80);
  await tab.mouse.wheel(0, 500);
  await sleep(600);
}
await tab.click("#cta");
await tab.evaluate(() => history.pushState({}, "", "/demo"));
await hide(tab);
check(
  await until(async () => (await q(`select count(*)::int n from events where session_id = $1 and kind = 'view'`, [s.id]))[0].n === 2),
  "views from the first load and pushState land",
);
check(await until(async () => (await q(`select count(*)::int n from events where session_id = $1 and kind = 'engage'`, [s.id]))[0].n >= 1), "engage lands");
check(await until(async () => (await q(`select pageviews from sessions where id = $1`, [s.id]))[0].pageviews === 2), "the session counts 2 views");

await tab.fill("[name=e]", "jane@acme.com");
await tab.fill("[name=p]", "hunter2");
await tab.click("#f button");
check(await until(async () => (await q(`select count(*)::int n from identity_evidence where device_id = $1`, [s.device_id]))[0].n === 1), "form evidence is written");
const [e] = await q(`select identifiers, source from identity_evidence where device_id = $1`, [s.device_id]);
check(e.source === "form" && e.identifiers[0].value === "jane@acme.com", "evidence holds the email only");
check((await q(`select count(*)::int n from jobs where workspace_id = $1 and kind = 'stitch'`, [WS]))[0].n === 1, "a stitch job is queued");
check((await q(`select count(*)::int n from jobs where workspace_id = $1 and kind = 'ip_lookup'`, [WS]))[0].n === 1, "an IP lookup is queued once");
const dump = JSON.stringify(await q(`select (select json_agg(e) from events e where e.workspace_id = $1) a, (select json_agg(s) from sessions s where s.workspace_id = $1) b, (select json_agg(j) from jobs j where j.workspace_id = $1) c`, [WS]));
check(!dump.includes("198.51.100.7") && !dump.includes("hunter2"), "no full IP or password anywhere");

// Reload: same device, same session.
await tab.goto(`${base}/pricing`);
await sleep(1000);
check((await q(`select count(*)::int n from sessions where site_id = $1`, [site.id]))[0].n === 1, "a reload continues the visit");
check((await q(`select count(*)::int n from devices where site_id = $1`, [site.id]))[0].n === 1, "one device");

// Private path: nothing.
await tab.goto(`${base}/account/settings`);
await hide(tab);
await sleep(800);
check((await q(`select count(*)::int n from events where session_id = $1 and path like '/account%'`, [s.id]))[0].n === 0, "private path sends nothing");

// Shutdown with rows waiting: all land.
await tab.goto(`${base}/pricing`);
await sleep(500);
await tab.evaluate(() => (window as unknown as { claritia: (m: string, n: string) => void }).claritia("track", "Before shutdown"));
await tab.goto(`${base}/demo`);
await sleep(300);
const left = await buffer.close(10_000);
check(left === 0, "shutdown writes everything waiting");
check((await q(`select count(*)::int n from events where session_id = $1 and kind = 'custom'`, [s.id]))[0].n === 1, "the last event made it");

await browser.close();
server.close();
await store.pool.end();
console.log(failures ? `${failures} failed` : "All collect checks passed");
process.exit(failures ? 1 : 0);
