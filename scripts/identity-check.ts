// The identity cases of docs/identity.md 17.1, in Chromium, against the real script, collect, the stitch job and
// Postgres. Email-link cases (7–15) come with M6; the WebKit storage cases (22, 23) run where WebKit is installed.
// scripts/test-db.sh runs it when CHROMIUM_PATH is set.
//   PG_URL=… CHROMIUM_PATH=… node scripts/identity-check.ts

import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import pg from "pg";
import pw from "playwright-core";
import { createApp } from "../collect/app.ts";
import { WriteBuffer } from "../collect/buffer.ts";
import type { Geo } from "../collect/geo.ts";
import { PgStore } from "../collect/store.ts";
import { identifyToken, stitchDevice, type Settings } from "../src/lib/identity/stitch.ts";

const url = process.env.PG_URL;
if (!url) throw new Error("PG_URL is not set");
const store = new PgStore(url, 6);
const pool = new pg.Pool({ connectionString: url, max: 6 });
const q = async (sql: string, p: unknown[] = []) => (await store.pool.query(sql, p)).rows;
const WS = crypto.randomUUID();
const SECRET = "identity-check-secret-0123456789abcdef";
await q(`insert into workspaces (id, name) values ($1, 'identity check') on conflict do nothing`, [WS]);
const [site] = await q(`insert into sites (workspace_id, domain, private_paths) values ($1::uuid, 'identity-check-' || substr($1::uuid::text, 1, 8) || '.test', '{/account}') returning id, site_key, proxy_secret`, [WS]);
const settings: Settings = { own_domains: ["own-co.test"], partner_domains: [], secrets: [SECRET], checkDomain: async (d) => d !== "gmial.com" };

const US: Geo = { country: "US", subdivision: "NY", city: "New York", asn: 7922 };
const DE: Geo = { country: "DE", subdivision: "", city: "Berlin", asn: 3320 };
let geo: Geo = US;
let shift = 0;
const now = () => Date.now() + shift;
const code = await readFile(new URL("../collect/dist/s.js", import.meta.url), "utf8");
const buffer = new WriteBuffer(store, { flushMs: 100 });
const { app } = createApp({ store, secret: "identity-check-id-secret-0123456789", geo: () => geo, script: { code, tag: "0000000000" }, buffer, devOrigins: ["localhost", "127.0.0.1"], now });
buffer.start();

type PageOpts = { consent?: string; direct?: boolean; head?: string; body?: string };
const opts = new Map<string, PageOpts>();
let port = 0;
const page = (path: string, o: PageOpts) => `<!doctype html><html><head><title>${path}</title>
<script>window.claritia=window.claritia||function(){(claritia.q=claritia.q||[]).push(arguments)};</script>
${o.head ?? ""}
<script defer src="${o.direct ? `http://127.0.0.1:${port}/_clr/s.js` : "/_clr/s.js"}" data-site="${site.site_key}" data-domains="localhost,127.0.0.1" ${o.consent ? `data-consent="${o.consent}"` : ""}></script></head>
<body><h1>${path}</h1><a id="hop" href="http://127.0.0.1:${port}/landing">Other domain</a><a id="next" href="/next">Next</a>
<form id="f" onsubmit="event.preventDefault()"><input type="email" name="e"><input type="password" name="pw"><input name="card" autocomplete="cc-number"><button>Send</button></form>
${o.body ?? ""}</body></html>`;

const server = createServer(async (req, res) => {
  const u = new URL(req.url!, "http://localhost");
  if (!u.pathname.startsWith("/_clr/")) {
    const o = opts.get(u.searchParams.get("o") ?? "") ?? {};
    return void res.writeHead(200, { "content-type": "text/html" }).end(page(u.pathname, o));
  }
  let body = "";
  for await (const c of req) body += c;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
  headers.set("x-clr-proxy", site.proxy_secret);
  headers.set("x-clr-client-ip", "198.51.100.7");
  const r = await app.fetch(new Request("http://collect" + u.pathname.slice(5) + u.search, { method: req.method, headers, body: req.method === "POST" ? body : undefined }));
  const out: Record<string, string | string[]> = {};
  r.headers.forEach((v, k) => (out[k] = v));
  const cookies = r.headers.getSetCookie();
  if (cookies.length) out["set-cookie"] = cookies;
  res.writeHead(r.status, out).end(Buffer.from(await r.arrayBuffer()));
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
port = (server.address() as { port: number }).port;
const base = `http://localhost:${port}`;

let failures = 0;
const results: string[] = [];
const check = (n: number | string, ok: boolean, what: string) => {
  const line = `${ok ? "PASS" : "FAIL"} ${n}. ${what}`;
  console.log(line);
  results.push(line);
  if (!ok) failures++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const browser = await pw.chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH });

async function fresh(o: { gpc?: boolean } = {}) {
  const ctx = await browser.newContext({ userAgent: UA });
  // Playwright sets navigator.webdriver, and collect marks such visits as bots. These cases are people.
  await ctx.addInitScript(() => Object.defineProperty(Navigator.prototype, "webdriver", { get: () => false }));
  if (o.gpc) await ctx.addInitScript(() => Object.defineProperty(Navigator.prototype, "globalPrivacyControl", { get: () => true }));
  const tab = await ctx.newPage();
  const sent: string[] = [];
  tab.on("request", (r) => sent.push(r.url() + " " + (r.postData() ?? "")));
  return { ctx, tab, sent };
}
let n = 0;
const go = async (tab: pw.Page, path: string, o: PageOpts = {}) => {
  const key = String(++n);
  opts.set(key, o);
  await tab.goto(`${base}${path}${path.includes("?") ? "&" : "?"}o=${key}`);
  await sleep(400);
};
const deviceOf = async (ctx: pw.BrowserContext, host = "localhost") => {
  const c = (await ctx.cookies(`http://${host}:${port}`)).find((x) => x.name === "_clr_id");
  return c ? c.value.split(".")[1] : null;
};
const submit = async (tab: pw.Page, email: string) => {
  await tab.fill("[name=e]", email);
  await tab.click("#f button");
  await sleep(500);
};
const settle = async () => {
  await sleep(300);
  await buffer.flush();
  const devs = await q(`select distinct device_id from identity_evidence where workspace_id = $1 and stitched_at is null and device_id is not null`, [WS]);
  for (const d of devs) await stitchDevice(pool, WS, d.device_id, settings);
};
const dev = async (id: string | null) => (id ? (await q(`select state, no_backfill from devices where id = $1`, [id]))[0] : null);
const personOf = async (v: string) => (await q(`select person_id from identifiers where workspace_id = $1 and value_clean = $2`, [WS, v]))[0]?.person_id ?? null;
const sessionsOf = async (d: string | null) => (d ? q(`select id, person_id, person_source, device_id from sessions where device_id = $1 order by started_at`, [d]) : []);
const sign = (user: string, email: string) => {
  const iat = Math.floor(now() / 1000);
  return { userId: user, email, iat, token: identifyToken(SECRET, site.id, user, email, iat) };
};
const call = (tab: pw.Page, m: string, ...a: unknown[]) => tab.evaluate(([m, a]) => (window as unknown as { claritia: (...x: unknown[]) => void }).claritia(m, ...(a as unknown[])), [m, a] as const);

try {
  // 1. Browse, then fill the demo form.
  {
    const { ctx, tab } = await fresh();
    await go(tab, "/pricing");
    shift += 31 * 60_000;
    await go(tab, "/pricing");
    const d = await deviceOf(ctx);
    await submit(tab, "case1@one.io");
    await settle();
    const ss = await sessionsOf(d);
    const p = await personOf("case1@one.io");
    check(1, ss.length === 2 && ss.every((s) => s.person_id === p) && ss[0].person_source === "backfill" && ss[1].person_source === "live", "linked at Asserted, earlier visit backfilled");
    await ctx.close();
  }
  // 2. Signed identify at login.
  {
    const { ctx, tab } = await fresh();
    await go(tab, "/app");
    await call(tab, "identify", sign("u_case2", "case2@two.io"));
    await settle();
    const p = await personOf("case2@two.io");
    const [ev] = await q(`select level, hard_edge from identity_evidence where device_id = $1`, [await deviceOf(ctx)]);
    check(2, !!p && p === (await personOf("u_case2")) && ev?.level === "verified" && ev.hard_edge, "Verified, user id and email tied");
    await ctx.close();
  }
  // 3. Unsigned identify from the console.
  {
    const { ctx, tab } = await fresh();
    await go(tab, "/x");
    await call(tab, "identify", { userId: "u_case3", email: "case3@three.io" });
    await settle();
    const [ev] = await q(`select level, hard_edge from identity_evidence where device_id = $1`, [await deviceOf(ctx)]);
    check(3, ev?.level === "asserted" && !ev.hard_edge && !(await personOf("u_case3")) && !!(await personOf("case3@three.io")), "Asserted, no hard edge");
    await ctx.close();
  }
  // 4. Two unsigned identities in one day.
  {
    const { ctx, tab } = await fresh();
    await go(tab, "/x");
    await call(tab, "identify", { userId: "u_case4a" });
    await sleep(300);
    await call(tab, "identify", { userId: "u_case4b" });
    await settle();
    check(4, (await dev(await deviceOf(ctx)))?.state === "tainted", "tainted");
    await ctx.close();
  }
  // 5. Two people fill forms on one browser.
  {
    const { ctx, tab } = await fresh();
    await go(tab, "/demo");
    await submit(tab, "case5a@five.io");
    await settle();
    await sleep(1100);
    await submit(tab, "case5b@five.io");
    await settle();
    const d = await deviceOf(ctx);
    const ss = await sessionsOf(d);
    const b = await personOf("case5b@five.io");
    check(5, (await dev(d))?.state === "shared" && ss.length === 2 && ss[0].person_id === (await personOf("case5a@five.io")) && ss[1].person_id === b, "shared, each gets their own window, no backfill for the second");
    await ctx.close();
  }
  // 6. Trade show laptop, 6 emails.
  {
    const { ctx, tab } = await fresh();
    await go(tab, "/booth");
    for (let i = 0; i < 6; i++) {
      await submit(tab, `case6-${i}@six.io`);
      await sleep(5200); // the script ignores the same form twice in 5 s
    }
    await settle();
    const d = await deviceOf(ctx);
    const open = (await q(`select count(*)::int n from device_links where device_id = $1 and to_at is null`, [d]))[0].n;
    check(6, (await dev(d))?.state === "tainted" && open === 0, "tainted, no person links");
    await ctx.close();
  }
  // 16. Own-domain email in a form.
  {
    const { ctx, tab } = await fresh();
    await go(tab, "/x");
    await submit(tab, "rep@own-co.test");
    await settle();
    check(16, (await dev(await deviceOf(ctx)))?.state === "internal", "device internal");
    await ctx.close();
  }
  // 17. reset() on logout, then another user logs in.
  {
    const { ctx, tab } = await fresh();
    await go(tab, "/app");
    await call(tab, "identify", sign("u_17a", "case17a@x.io"));
    await sleep(400);
    const d1 = await deviceOf(ctx);
    await call(tab, "reset");
    await sleep(500);
    const d2 = await deviceOf(ctx);
    await go(tab, "/app");
    await call(tab, "identify", sign("u_17b", "case17b@x.io"));
    await settle();
    const l1 = await q(`select distinct person_id from device_links where device_id = $1`, [d1]);
    const l2 = await q(`select distinct person_id from device_links where device_id = $1`, [d2]);
    check(17, !!d1 && !!d2 && d1 !== d2 && l1.length === 1 && l2.length === 1 && l1[0].person_id !== l2[0].person_id, "new device, no mixing");
    await ctx.close();
  }
  // 18. Logout and login as another user without reset().
  {
    const { ctx, tab } = await fresh();
    await go(tab, "/app");
    await call(tab, "identify", sign("u_18a", "case18a@x.io"));
    await settle();
    await sleep(1100);
    await call(tab, "identify", sign("u_18b", "case18b@x.io"));
    await settle();
    const d = await deviceOf(ctx);
    const ss = await sessionsOf(d);
    check(18, (await dev(d))?.state === "shared" && ss.length === 2 && ss[1].person_source === "split", "session split, device shared");
    await ctx.close();
  }
  // 19–21. Cross-domain hop: works, can't be replayed, expires.
  {
    const { ctx, tab } = await fresh();
    await go(tab, "/x");
    const d = await deviceOf(ctx);
    await tab.hover("#hop");
    await sleep(300);
    let hopUrl = "";
    tab.on("request", (r) => r.url().includes("/landing") && (hopUrl ||= r.url()));
    await Promise.all([tab.waitForURL(/127\.0\.0\.1/), tab.click("#hop")]);
    await sleep(600);
    check(19, (await deviceOf(ctx, "127.0.0.1")) === d, "same device on both domains");
    const other = await fresh();
    await other.tab.goto(hopUrl);
    await sleep(600);
    const replayed = await deviceOf(other.ctx, "127.0.0.1");
    check(20, !!replayed && replayed !== d, "a replayed hop token is refused");
    await other.ctx.close();
    await ctx.close();
    const late = await fresh();
    await go(late.tab, "/x");
    const d3 = await deviceOf(late.ctx);
    await late.tab.hover("#hop");
    await sleep(300);
    shift += 3 * 60_000;
    await Promise.all([late.tab.waitForURL(/127\.0\.0\.1/), late.tab.click("#hop")]);
    await sleep(600);
    const d4 = await deviceOf(late.ctx, "127.0.0.1");
    check(21, !!d4 && d4 !== d3, "a hop token after 3 minutes is refused: new device");
    await late.ctx.close();
  }
  // 24. Direct mode: cookie cleared, localStorage kept.
  {
    const { ctx, tab } = await fresh();
    await go(tab, "/x", { direct: true });
    const did = await tab.evaluate(() => localStorage.getItem("_clr_id"));
    await ctx.clearCookies();
    await go(tab, "/y", { direct: true });
    const after = await tab.evaluate(() => localStorage.getItem("_clr_id"));
    const id = did?.split(".")[1];
    const devs = id ? (await q(`select count(*)::int n from sessions where device_id = $1`, [id]))[0].n : 0;
    check(24, !!did && did === after && devs >= 1, "same device from the localStorage copy");
    await ctx.close();
  }
  // 25. strict, no consent.
  {
    geo = DE;
    const { ctx, tab, sent } = await fresh();
    await go(tab, "/x");
    await submit(tab, "case25@eu.io");
    await settle();
    check(25, !(await deviceOf(ctx)) && !(await personOf("case25@eu.io")) && !sent.some((s) => s.includes("/_clr/i")), "no cookie, no evidence, the form sends nothing");
    await ctx.close();
  }
  // 26. strict, consent given mid-visit.
  {
    const { ctx, tab } = await fresh();
    await go(tab, "/x");
    const before = await q(`select id from sessions where workspace_id = $1 and device_id is null order by started_at desc limit 1`, [WS]);
    await call(tab, "consent", true);
    await go(tab, "/y", { head: "<script>claritia('consent', true)</script>" });
    const d = await deviceOf(ctx);
    await submit(tab, "case26@eu.io");
    await settle();
    const [early] = await q(`select person_id, device_id from sessions where id = $1`, [before[0]?.id]);
    check(26, !!d && !!(await personOf("case26@eu.io")) && !!early && !early.device_id && !early.person_id, "new device from consent, earlier visit never linked");
    await ctx.close();
  }
  // 27. Consent withdrawn.
  {
    const { ctx, tab } = await fresh();
    await go(tab, "/x", { head: "<script>claritia('consent', true)</script>" });
    const d = await deviceOf(ctx);
    await go(tab, "/y", { head: "<script>claritia('consent', false)</script>" });
    await settle();
    const later = d ? (await q(`select count(*)::int n from events e join sessions s on s.id = e.session_id where s.device_id = $1 and e.path like '/y%'`, [d]))[0].n : -1;
    check(27, !!d && !(await deviceOf(ctx)) && later === 0, "cookie deleted, no new events on the device");
    await ctx.close();
    geo = US;
  }
  // 28. GPC on.
  {
    const { ctx, tab, sent } = await fresh({ gpc: true });
    await go(tab, "/x");
    await submit(tab, "case28@gpc.io");
    await settle();
    check(28, !(await deviceOf(ctx)) && !sent.some((s) => s.includes("/_clr/i")) && !(await personOf("case28@gpc.io")), "cookieless, no evidence");
    await ctx.close();
  }
  // 29. Opt-out.
  {
    const { ctx, tab, sent } = await fresh();
    await go(tab, "/x");
    await call(tab, "optOut");
    await sleep(400);
    const opt = (await ctx.cookies(base)).find((c) => c.name === "_clr_opt");
    const before = sent.length;
    await go(tab, "/y");
    check(29, opt?.value === "1" && !sent.slice(before).some((s) => s.includes("/_clr/e")), "_clr_opt set, nothing after");
    await ctx.close();
  }
  // 30. HubSpot form adapter.
  {
    const { ctx, tab } = await fresh();
    await go(tab, "/x");
    await tab.evaluate(() => window.postMessage({ type: "hsFormCallback", eventName: "onFormSubmitted", id: "hs-form-1", data: { submissionValues: { email: "case30@hub.io", firstname: "Hub" } } }, "*"));
    await sleep(500);
    await settle();
    const [ev] = await q(`select extra from identity_evidence where device_id = $1`, [await deviceOf(ctx)]);
    check(30, !!(await personOf("case30@hub.io")) && ev?.extra?.adapter === "hubspot", "email captured from the callback");
    await ctx.close();
  }
  // 31. fetch form without submit, then with data-clr-form.
  {
    const { ctx, tab } = await fresh();
    await go(tab, "/x", { body: `<div><input type="email" id="fe" value="case31a@fetch.io"><button id="b1" onclick="fetch('/noop')">Go</button></div><div><input type="email" value="case31b@fetch.io"><button id="b2" data-clr-form="signup">Go</button></div>` });
    await tab.click("#b1");
    await tab.click("#b2");
    await sleep(500);
    await settle();
    check(31, !(await personOf("case31a@fetch.io")) && !!(await personOf("case31b@fetch.io")), "nothing without data-clr-form, captured with it");
    await ctx.close();
  }
  // 32. Password and card fields.
  {
    const { ctx, tab, sent } = await fresh();
    await go(tab, "/x");
    await tab.fill("[name=pw]", "hunter2-secret");
    await tab.fill("[name=card]", "4242424242424242");
    await submit(tab, "case32@safe.io");
    await settle();
    check(32, !sent.some((s) => /hunter2-secret|4242424242424242/.test(s)) && sent.some((s) => s.includes("case32@safe.io")), "only the email leaves the browser");
    await ctx.close();
  }
  // 33. J.ane+news@Gmail.com then jane@gmail.com.
  {
    const a = await fresh();
    await go(a.tab, "/x");
    await submit(a.tab, "J.ane33+news@Gmail.com");
    const b = await fresh();
    await go(b.tab, "/x");
    await submit(b.tab, "jane33@gmail.com");
    await settle();
    const people = await q(`select count(distinct person_id)::int n from device_links where device_id = any($1)`, [[await deviceOf(a.ctx), await deviceOf(b.ctx)]]);
    check(33, people[0].n === 1, "one person");
    await a.ctx.close();
    await b.ctx.close();
  }
  // 34. sales@ form.
  {
    const { ctx, tab } = await fresh();
    await go(tab, "/x");
    await submit(tab, "sales@case34.io");
    await settle();
    const [ev] = await q(`select ignored from identity_evidence where device_id = $1`, [await deviceOf(ctx)]);
    check(34, ev?.ignored === "role" && !(await personOf("sales@case34.io")), "no person, account hint");
    await ctx.close();
  }
  // 35. jane@gmial.com (no MX).
  {
    const { ctx, tab } = await fresh();
    await go(tab, "/x");
    await submit(tab, "jane35@gmial.com");
    await settle();
    check(35, !(await personOf("jane35@gmial.com")), "dropped");
    await ctx.close();
  }
  // 36. Back navigation.
  {
    const { ctx, tab } = await fresh();
    await go(tab, "/a36");
    await tab.click("#next");
    await sleep(400);
    await tab.goBack();
    await sleep(600);
    await settle();
    const d = await deviceOf(ctx);
    const ss = await sessionsOf(d);
    const views = ss.length ? (await q(`select count(*)::int n from events where session_id = $1 and kind = 'view' and path like '/a36%'`, [ss[0].id]))[0].n : 0;
    check(36, ss.length === 1 && views === 2, `one session, two views of the page (${ss.length}, ${views})`);
    await ctx.close();
  }
  // 37. A prerendered page that's never shown.
  {
    const { ctx, tab } = await fresh();
    await go(tab, "/x", { head: `<script type="speculationrules">{"prerender":[{"urls":["/pre37"]}]}</script>` });
    await sleep(1500);
    await settle();
    const n37 = (await q(`select count(*)::int n from events where workspace_id = $1 and path like '/pre37%'`, [WS]))[0].n;
    check(37, n37 === 0, "nothing sent");
    await ctx.close();
  }
  // 38. Campaign change mid-visit.
  {
    const { ctx, tab } = await fresh();
    await go(tab, "/x?utm_campaign=spring");
    await go(tab, "/x?utm_campaign=summer");
    await settle();
    check(38, (await sessionsOf(await deviceOf(ctx))).length === 2, "new session");
    await ctx.close();
  }
} finally {
  await browser.close();
  server.close();
  await buffer.close(5000);
  await store.pool.end();
  await pool.end();
}
console.log(failures ? `${failures} failed` : `All ${results.length} identity checks passed`);
process.exit(failures ? 1 : 0);
