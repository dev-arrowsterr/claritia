// The consent matrix (docs/account-intelligence.md, testing): 4 regions × 3 consent states × GPC × opt-out = 48 cases,
// each in a fresh Chromium context against the real script, collect and Postgres. Each case checks the cookie, the
// events stored, the identity made from a form, and whether a company lookup was queued.
// scripts/test-db.sh runs it when CHROMIUM_PATH is set.
//   PG_URL=… CHROMIUM_PATH=… node scripts/consent-check.ts

import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import pg from "pg";
import pw from "playwright-core";
import { createApp } from "../collect/app.ts";
import { WriteBuffer } from "../collect/buffer.ts";
import type { Geo } from "../collect/geo.ts";
import { PgStore } from "../collect/store.ts";
import { stitchDevice } from "../src/lib/identity/stitch.ts";

const url = process.env.PG_URL;
if (!url) throw new Error("PG_URL is not set");
const store = new PgStore(url, 6);
const pool = new pg.Pool({ connectionString: url, max: 4 });
const q = async (sql: string, p: unknown[] = []) => (await store.pool.query(sql, p)).rows;
const WS = crypto.randomUUID();
await q(`insert into workspaces (id, name) values ($1, 'consent check') on conflict do nothing`, [WS]);
const [site] = await q(`insert into sites (workspace_id, domain, policy_overrides) values ($1::uuid, 'consent-check-' || substr($1::uuid::text, 1, 8) || '.test', '{"off":["RU"]}') returning id, site_key, proxy_secret`, [WS]);

const REGIONS: { name: string; geo: Geo; kind: "strict" | "notice" | "off" }[] = [
  { name: "Germany", geo: { country: "DE", subdivision: "", city: "", asn: 3320 }, kind: "strict" },
  { name: "Quebec", geo: { country: "CA", subdivision: "QC", city: "", asn: 577 }, kind: "strict" },
  { name: "California", geo: { country: "US", subdivision: "CA", city: "", asn: 7922 }, kind: "notice" },
  { name: "Blocked by the site", geo: { country: "RU", subdivision: "", city: "", asn: 12389 }, kind: "off" },
];
let geo: Geo = REGIONS[0].geo;
let ip = "198.51.100.7";
const code = await readFile(new URL("../collect/dist/s.js", import.meta.url), "utf8");
const buffer = new WriteBuffer(store, { flushMs: 100 });
const { app } = createApp({ store, secret: "consent-check-id-secret-0123456789ab", geo: () => geo, script: { code, tag: "0000000000" }, buffer, devOrigins: ["localhost"] });
buffer.start();

const page = (consent: string) => `<!doctype html><title>consent</title>
<script>window.claritia=window.claritia||function(){(claritia.q=claritia.q||[]).push(arguments)};${consent}</script>
<script defer src="/_clr/s.js" data-site="${site.site_key}"></script>
<form id="f" onsubmit="event.preventDefault()"><input type="email" name="e"><button>Send</button></form>`;
const server = createServer(async (req, res) => {
  const u = new URL(req.url!, "http://localhost");
  if (!u.pathname.startsWith("/_clr/")) {
    const c = u.searchParams.get("c");
    return void res.writeHead(200, { "content-type": "text/html" }).end(page(c === "granted" ? "claritia('consent', true);" : c === "denied" ? "claritia('consent', false);" : ""));
  }
  let body = "";
  for await (const ch of req) body += ch;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
  headers.set("x-clr-proxy", site.proxy_secret);
  headers.set("x-clr-client-ip", ip);
  const r = await app.fetch(new Request("http://collect" + u.pathname.slice(5) + u.search, { method: req.method, headers, body: req.method === "POST" ? body : undefined }));
  const out: Record<string, string | string[]> = {};
  r.headers.forEach((v, k) => (out[k] = v));
  const cookies = r.headers.getSetCookie();
  if (cookies.length) out["set-cookie"] = cookies;
  res.writeHead(r.status, out).end(Buffer.from(await r.arrayBuffer()));
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://localhost:${(server.address() as { port: number }).port}`;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const browser = await pw.chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
let i = 0;
for (const region of REGIONS)
  for (const consent of ["granted", "denied", "unknown"] as const)
    for (const gpc of [false, true])
      for (const optOut of [false, true]) {
        i++;
        geo = region.geo;
        ip = `198.51.${i}.7`;
        const net = `198.51.${i}.0/24`;
        const email = `case${i}@matrix.io`;
        const ctx = await browser.newContext({ userAgent: UA });
        await ctx.addInitScript(() => Object.defineProperty(Navigator.prototype, "webdriver", { get: () => false }));
        if (gpc) await ctx.addInitScript(() => Object.defineProperty(Navigator.prototype, "globalPrivacyControl", { get: () => true }));
        if (optOut) await ctx.addCookies([{ name: "_clr_opt", value: "1", url: base }]);
        const tab = await ctx.newPage();
        await tab.goto(`${base}/c${i}?c=${consent}`);
        await sleep(400);
        await tab.fill("[name=e]", email);
        await tab.click("#f button");
        await sleep(400);
        await buffer.flush();
        const cookie = (await ctx.cookies(base)).find((c) => c.name === "_clr_id");
        const device = cookie?.value.split(".")[1] ?? null;
        if (device) await stitchDevice(pool, WS, device, { own_domains: [], partner_domains: [], secrets: [] });
        const sessions = await q(`select device_id, policy from sessions s where workspace_id = $1 and exists (select 1 from events e where e.session_id = s.id and e.path = $2)`, [WS, `/c${i}`]);
        const person = (await q(`select person_id from identifiers where workspace_id = $1 and value_clean = $2`, [WS, email]))[0]?.person_id ?? null;
        const lookup = (await q(`select count(*)::int n from jobs where workspace_id = $1 and kind = 'ip_lookup' and key = $2`, [WS, net]))[0].n > 0;
        await ctx.close();

        // What the rules say should happen (docs/account-intelligence.md 3.2).
        const nothing = region.kind === "off" || optOut;
        const full = !nothing && !gpc && (region.kind === "notice" ? consent !== "denied" : region.kind === "strict" ? consent === "granted" : false);
        const want = {
          cookie: full,
          events: !nothing,
          device: full,
          identity: full,
          lookup: full || (!nothing && region.kind === "notice" && gpc && consent !== "denied"),
        };
        const got = { cookie: !!cookie, events: sessions.length > 0, device: sessions.some((s) => !!s.device_id), identity: !!person, lookup };
        const ok = JSON.stringify(want) === JSON.stringify(got);
        if (!ok) failures++;
        console.log(`${ok ? "PASS" : "FAIL"} ${String(i).padStart(2)}. ${region.name}, consent ${consent}, GPC ${gpc ? "on" : "off"}, opt-out ${optOut ? "yes" : "no"}${ok ? "" : `: want ${JSON.stringify(want)}, got ${JSON.stringify(got)}`}`);
      }

await browser.close();
server.close();
await buffer.close(5000);
await store.pool.end();
await pool.end();
console.log(failures ? `${failures} of ${i} failed` : `All ${i} consent cases passed`);
process.exit(failures ? 1 : 0);
