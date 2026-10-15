// claritia.js in a real browser against a fake collect: views, SPA, engage, clicks, scrubbing, forms, retries,
// private paths, hop links, consent wait, GPC, cookieless policy, opt-out and the early-call queue.
//   npm run build:script && CHROMIUM_PATH=/path/to/chrome node scripts/script-check.ts

import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import pw from "playwright-core";

type Hit = { path: string; body: Record<string, unknown> | null; status: number; at: number };
type Ev = { id: string; k: string; u: string; ti?: string; n?: string; d?: Record<string, unknown> };

const chromiumPath = process.env.CHROMIUM_PATH;
const script = await readFile(new URL("../collect/dist/s.js", import.meta.url), "utf8");
const hits: Hit[] = [];
let fail503 = 0;

const page = (site: string, path: string, attrs = "") => `<!doctype html><html><head><title>Pricing | Acme</title>
<script>window.claritia=window.claritia||function(){(claritia.q=claritia.q||[]).push(arguments)};claritia('track','Early');</script>
<script defer src="/_clr/s.js" data-site="${site}" data-domains="localhost,127.0.0.1" data-private="/p/account" ${attrs}></script></head>
<body style="height:3000px"><h1>${path}</h1>
<button id="cta">Book a demo</button>
<a id="btnlink" class="btn" href="/p/pricing">See pricing</a>
<a id="plain" href="/p/blog">Blog</a>
<a id="out" href="https://example.org/x?email=jane@acme.com">Out</a>
<a id="hop" href="http://127.0.0.1:${port()}/p/landing?utm_source=hop">Other domain</a>
<form id="demo" onsubmit="event.preventDefault()">
  <input name="name" value="">
  <input name="work" type="email">
  <input name="pw" type="password">
  <input name="card" autocomplete="cc-number">
  <button type="submit">Send</button>
</form>
</body></html>`;

const server = createServer(async (req, res) => {
  const url = new URL(req.url!, "http://x");
  if (url.pathname === "/_clr/s.js") return void res.writeHead(200, { "content-type": "text/javascript" }).end(script);
  if (url.pathname.startsWith("/_clr/")) {
    let raw = "";
    for await (const c of req) raw += c;
    let body: Record<string, unknown> | null = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {}
    const path = url.pathname.slice(5);
    if (path === "/x") {
      hits.push({ path, body: null, status: 200, at: Date.now() });
      return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ t: "tok123" }));
    }
    const status = path === "/e" && fail503 > 0 ? (fail503--, 503) : 200;
    hits.push({ path, body, status, at: Date.now() });
    if (status !== 200) return void res.writeHead(status).end();
    const p = body?.site === "CL" ? "cookieless" : "full";
    return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ p }));
  }
  const site = url.searchParams.get("site") || "FULL";
  const attrs = url.searchParams.get("wait") ? 'data-consent="wait"' : "";
  res.writeHead(200, { "content-type": "text/html" }).end(page(site, url.pathname, attrs));
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
function port() {
  return (server.address() as { port: number }).port;
}
const base = `http://localhost:${port()}`;

let failures = 0;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${what}`);
  if (!ok) failures++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const events = (from = 0) => hits.slice(from).filter((h) => h.path === "/e" && h.status === 200).flatMap((h) => (h.body?.events as Ev[]) ?? []);
const until = async (fn: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await sleep(50);
  }
  return fn();
};
const hide = (p: pw.Page) =>
  p.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  });

const browser = await pw.chromium.launch({ headless: true, executablePath: chromiumPath });
const ctx = await browser.newContext();
const tab = await ctx.newPage();

// 1. First view goes at once, scrubbed.
const t0 = Date.now();
await tab.goto(`${base}/p/home?utm_source=news&email=jane@acme.com&token=abc`);
check(await until(() => events().some((e) => e.k === "view")), "first view is sent");
const first = hits.find((h) => h.path === "/e")!;
check(first.at - t0 < 2000, "first batch goes at once");
const v = events().find((e) => e.k === "view")!;
check(v.u === "/p/home?utm_source=news", `view URL is scrubbed (${v.u})`);
check(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v.id), "event id is a uuid v7");
check(v.ti === "Pricing | Acme", "title is sent");
check(JSON.stringify(first.body?.consent) === JSON.stringify({ state: "unknown", tool: "none" }) && first.body?.gpc === false, "consent and GPC are reported");
check(await until(() => events().some((e) => e.k === "track" && e.n === "Early"), 7000), "calls made before the script loaded are replayed");

// 2. Engage, clicks and the timer flush.
let mark = hits.length;
for (let i = 0; i < 4; i++) {
  await tab.mouse.move(100 + i * 10, 100 + i * 10);
  await tab.mouse.wheel(0, 400);
  await sleep(700);
}
await tab.click("#cta");
await tab.click("#plain");
await tab.goBack().catch(() => {});
check(await until(() => events(mark).some((e) => e.k === "click"), 7000), "clicks go with the 5 s timer");
const clicks = events(mark).filter((e) => e.k === "click");
check(clicks.some((c) => c.d?.text === "Book a demo"), "button click is sent with its label");
check(!clicks.some((c) => c.d?.text === "Blog"), "plain internal links are not clicks");

await tab.goto(`${base}/p/home`);
await until(() => events(mark).filter((e) => e.k === "view").length >= 2);
mark = hits.length;
for (let i = 0; i < 4; i++) {
  await tab.mouse.move(200 + i * 10, 100);
  await tab.mouse.wheel(0, 500);
  await sleep(600);
}
await tab.evaluate(() => {
  const a = document.querySelector("#out") as HTMLAnchorElement;
  a.addEventListener("click", (e) => e.preventDefault(), { once: true });
  a.click();
});
await hide(tab);
check(await until(() => events(mark).some((e) => e.k === "engage")), "engage is sent when the tab hides");
const eng = events(mark).find((e) => e.k === "engage")!;
check(Number(eng?.d?.active_s) >= 2 && Number(eng?.d?.scroll) > 20, `engage has active time and depth (${JSON.stringify(eng?.d)})`);
const human = hits.slice(mark).find((h) => h.body?.human)?.body?.human as Record<string, number> | undefined;
check(!!human && human.scroll > 0 && human.first_input_ms > 0, "human counts ride with the first engage");
const out = events(mark).find((e) => e.k === "click" && e.d?.out);
check(!!out && out.d?.href === "https://example.org/x", `outbound click is scrubbed (${out?.d?.href})`);

// 3. SPA navigation.
mark = hits.length;
await tab.evaluate(() => history.pushState({}, "", "/p/next?x=1"));
await hide(tab);
check(await until(() => events(mark).some((e) => e.k === "view" && e.u === "/p/next?x=1")), "pushState sends a view");

// 4. Forms send only the email.
mark = hits.length;
await tab.fill("[name=name]", "Jane Roe");
await tab.fill("[name=work]", "jane@acme.com");
await tab.fill("[name=pw]", "hunter2");
await tab.fill("[name=card]", "4242424242424242");
await tab.click("#demo button");
check(await until(() => hits.slice(mark).some((h) => h.path === "/i")), "form submit sends identity");
const idHit = hits.slice(mark).find((h) => h.path === "/i")!;
check(idHit?.body?.email === "jane@acme.com" && idHit.body.kind === "form" && idHit.body.page === "/p/next?x=1", "identity carries the email, kind and page");
const all = JSON.stringify(hits.map((h) => h.body));
check(!/hunter2|4242424242424242|Jane Roe/.test(all), "password, card and name never leave the browser");

// 5. A failed batch is sent again once, with the same ids.
fail503 = 1;
mark = hits.length;
await tab.evaluate(() => (window as unknown as { claritia: (m: string, n: string) => void }).claritia("track", "Retry me"));
await hide(tab);
await until(() => hits.slice(mark).some((h) => h.status === 503));
await tab.evaluate(() => (window as unknown as { claritia: (m: string, n: string) => void }).claritia("track", "After"));
await hide(tab);
check(await until(() => events(mark).some((e) => e.n === "Retry me")), "failed batch is retried");
const failedIds = ((hits.slice(mark).find((h) => h.status === 503)?.body?.events as Ev[]) ?? []).map((e) => e.id);
check(failedIds.length > 0 && failedIds.every((id) => events(mark).some((e) => e.id === id)), "retry keeps the same event ids");

// 6. Track props are scrubbed.
mark = hits.length;
await tab.evaluate(() => (window as unknown as { claritia: (m: string, n: string, p: object) => void }).claritia("track", "Signup", { plan: "pro", email: "x@y.com", note: "call +1 415 555 0132" }));
await hide(tab);
await until(() => events(mark).some((e) => e.n === "Signup"));
const sig = events(mark).find((e) => e.n === "Signup");
check(JSON.stringify(sig?.d) === JSON.stringify({ plan: "pro", note: "call [removed]" }), `track props are scrubbed (${JSON.stringify(sig?.d)})`);

// 7. Private paths send nothing.
mark = hits.length;
await tab.goto(`${base}/p/account/billing`);
await tab.click("#cta");
await hide(tab);
await sleep(800);
check(!events(mark).some((e) => e.u.startsWith("/p/account")), "private path sends nothing");

// 8. Hop link carries the token only at click time; the landing page sends it and strips it.
await tab.goto(`${base}/p/home`);
await until(() => true, 300);
mark = hits.length;
await tab.hover("#hop");
await until(() => hits.slice(mark).some((h) => h.path === "/x"));
check((await tab.getAttribute("#hop", "href"))?.includes("_clr_x") === false, "hop link isn't changed before the click");
await Promise.all([tab.waitForURL(/127\.0\.0\.1.*\/p\/landing/), tab.click("#hop")]);
check(!tab.url().includes("_clr_x"), `landing URL is cleaned (${tab.url()})`);
check(await until(() => hits.slice(mark).some((h) => h.path === "/e" && h.body?.hop === "tok123")), "landing batch carries the hop token");

// 9. Consent wait: nothing until the site answers.
await tab.goto(`${base}/p/wait?wait=1`);
mark = hits.length;
const waitHits = () => hits.slice(mark).filter((h) => h.path === "/e" && ((h.body?.events as Ev[]) ?? []).some((e) => e.u.startsWith("/p/wait")));
await sleep(1200);
check(!waitHits().length, "wait mode holds events until consent");
await tab.evaluate(() => (window as unknown as { claritia: (m: string, v: boolean) => void }).claritia("consent", true));
check(await until(() => waitHits().length > 0), "events go once consent is given");
check(JSON.stringify(waitHits()[0]?.body?.consent) === JSON.stringify({ state: "granted", tool: "api" }), "consent source is the API");

// 10. Opt-out stops everything.
mark = hits.length;
await tab.evaluate(() => (window as unknown as { claritia: (m: string) => void }).claritia("optOut"));
await tab.evaluate(() => history.pushState({}, "", "/p/after-opt"));
await hide(tab);
await sleep(800);
check(hits.slice(mark).some((h) => h.path === "/opt"), "opt-out is sent");
check(!events(mark).length, "nothing is sent after opt-out");
await tab.goto(`${base}/p/home`);
await sleep(800);
check(!events(mark).length, "opt-out holds on the next page");
await ctx.close();

// 11. GPC: events go, identity never does.
const gctx = await browser.newContext();
await gctx.addInitScript(() => Object.defineProperty(Navigator.prototype, "globalPrivacyControl", { get: () => true }));
const g = await gctx.newPage();
mark = hits.length;
await g.goto(`${base}/p/home`);
await until(() => events(mark).length > 0);
check(hits.slice(mark).find((h) => h.path === "/e")?.body?.gpc === true, "GPC is reported");
await g.fill("[name=work]", "jane@acme.com");
await g.click("#demo button");
await sleep(800);
check(!hits.slice(mark).some((h) => h.path === "/i"), "GPC sends no identity");
await gctx.close();

// 12. Cookieless policy from the server: no identity.
const cctx = await browser.newContext();
const c = await cctx.newPage();
mark = hits.length;
await c.goto(`${base}/p/home?site=CL`);
await until(() => events(mark).length > 0);
await sleep(200);
await c.fill("[name=work]", "jane@acme.com");
await c.click("#demo button");
await c.evaluate(() => (window as unknown as { claritia: (m: string, o: object) => void }).claritia("identify", { email: "jane@acme.com" }));
await sleep(800);
check(!hits.slice(mark).some((h) => h.path === "/i"), "cookieless policy sends no identity");
await cctx.close();

await browser.close();
server.close();
console.log(failures ? `${failures} failed` : "All script checks passed");
process.exit(failures ? 1 : 0);
