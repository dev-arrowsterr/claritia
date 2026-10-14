// Drives the Explorer and its handler with a real browser, a stand-in database and a local site built to be awkward:
// a slow page, a page that errors, a page that never stops loading, ids in addresses, a popup, an alert, a sign-out
// link, a delete link, a link to another site, and pages behind a sign-in.
//   CHROMIUM_PATH=/path/to/chrome node scripts/explore-check.ts
// Covers: one page per address pattern, nothing risky followed, the page limit, slow and broken pages, signing in
// with a test first, pages saved with links and names, a sign-in test that fails, Stop, and a site that's down.

import { createServer } from "node:http";
import { handleExploration, type Exploration } from "../worker/exploreHandle.ts";
import { explore, patternOf, shouldFollow, type FoundPage } from "../worker/explorer.ts";
import type { Namer } from "../worker/namer.ts";

process.env.SECRETS_KEY = "a-local-check-key-that-is-long-enough-1234";
const chromiumPath = process.env.CHROMIUM_PATH;

let deletes = 0;
let signOuts = 0;
const page = (title: string, body: string) => `<!doctype html><title>${title}</title><body>${body}</body>`;
const nav = `<nav><a href="/">Home</a> <a href="/orders">Orders</a> <a href="/slow">Slow</a> <a href="/broken">Broken</a> <a href="/forever">Forever</a> <a href="/account">Account</a> <a href="/logout">Sign out</a> <a href="https://example.com/x">Elsewhere</a> <a href="/report.pdf">Report</a> <a href="mailto:a@b.c">Mail</a></nav>`;
const server = createServer((req, res) => {
  const url = new URL(req.url!, "http://x");
  const signedIn = /session=ok/.test(req.headers.cookie ?? "");
  const html = (status: number, body: string) => {
    res.writeHead(status, { "content-type": "text/html" });
    res.end(body);
  };
  switch (true) {
    case url.pathname === "/":
      return html(200, page("Shop", `${nav}<h1>Welcome</h1><button>Start</button><script>window.open('/popup')</script>`));
    case url.pathname === "/orders":
      return html(200, page("Orders", `${nav}<h1>Orders</h1>${[1, 2, 3, 4, 5].map((n) => `<a href="/orders/${n}">Order ${n}</a>`).join(" ")} <a href="/orders/1/delete">Delete order</a>`));
    case /^\/orders\/\d+$/.test(url.pathname):
      return html(200, page(`Order ${url.pathname.split("/")[2]}`, `${nav}<h1>Order</h1><form><label for="n">Note</label><input id="n" name="note"><button type="submit">Save note</button></form>`));
    case url.pathname.endsWith("/delete"):
      deletes++;
      return html(200, page("Deleted", "gone"));
    case url.pathname === "/logout":
      signOuts++;
      res.writeHead(302, { location: "/", "set-cookie": "session=; Max-Age=0" });
      return res.end();
    case url.pathname === "/slow":
      return void setTimeout(() => html(200, page("Slow", `${nav}<h1>Slow page</h1><script>alert('hi')</script>`)), 2500);
    case url.pathname === "/broken":
      return html(500, page("Error", "<h1>Something went wrong</h1>"));
    case url.pathname === "/forever":
      // Sends a page, then keeps a request open forever, so the network never goes quiet.
      return html(200, page("Forever", `${nav}<h1>Live feed</h1><img src="/hang">`));
    case url.pathname === "/hang":
      return; // never answers
    case url.pathname === "/popup":
      return html(200, page("Popup", "popup"));
    case url.pathname === "/account":
      if (!signedIn) {
        res.writeHead(302, { location: "/login" });
        return res.end();
      }
      return html(200, page("Account", `${nav}<h1>Your account</h1><a href="/account/billing">Billing</a>`));
    case url.pathname === "/account/billing":
      return signedIn ? html(200, page("Billing", `${nav}<h1>Billing</h1>`)) : (res.writeHead(302, { location: "/login" }), res.end());
    case url.pathname === "/login" && req.method === "POST":
      // Signing in is slow, like a real one.
      return void setTimeout(() => {
        res.writeHead(302, { location: "/account", "set-cookie": "session=ok; Path=/" });
        res.end();
      }, 1200);
    case url.pathname === "/login":
      return html(200, page("Sign in", `<h1>Sign in</h1><form method="post" action="/login"><label for="e">Email</label><input id="e" name="email"><label for="p">Password</label><input id="p" type="password" name="password"><button type="submit">Sign in</button></form>`));
    default:
      return html(404, page("Not found", "nope"));
  }
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

let failures = 0;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${what}`);
  if (!ok) failures++;
};

// Patterns and link rules, no browser.
check(patternOf(new URL("https://x.com/orders/123")) === "/orders/:id", "numbers in addresses become :id");
check(patternOf(new URL("https://x.com/u/3f2b8c1e-1a2b-4c3d-9e8f-0a1b2c3d4e5f/edit?tab=2#x")) === "/u/:id/edit", "UUIDs become :id, query and hash dropped");
check(patternOf(new URL("https://x.com/blog/hello-world")) === "/blog/hello-world", "plain names stay");
const b = new URL("https://x.com/");
check(!shouldFollow(new URL("https://x.com/logout"), b) && !shouldFollow(new URL("https://x.com/a"), b, "Sign out") && !shouldFollow(new URL("https://x.com/items/4/delete"), b), "sign-out and delete links aren't followed");
check(!shouldFollow(new URL("https://other.com/"), b) && !shouldFollow(new URL("https://x.com/r.pdf"), b) && !shouldFollow(new URL("mailto:a@b.c"), b), "other sites, files and mail links aren't followed");

// 1. A crawl of the awkward site, signed out.
{
  const found: FoundPage[] = [];
  const r = await explore({ baseUrl: base, maxPages: 20, dir: "/tmp/claritia-explore-1", chromiumPath, allowPrivate: true, pageTimeoutMs: 8000 }, async (p) => void found.push(p));
  const patterns = found.map((p) => p.pattern).sort();
  console.log("  found:", patterns.join(" "));
  check(r.status === "done", `the crawl finishes (${r.status} ${r.error ?? ""})`);
  check(patterns.filter((p) => p === "/orders/:id").length === 1, "five orders are one page, /orders/:id");
  check(patterns.includes("/slow"), "a slow page is found");
  check(patterns.includes("/forever"), "a page that never goes quiet is found, not waited on forever");
  check(patterns.includes("/broken") && found.find((p) => p.pattern === "/broken")!.status === 500, "a page that errors is found with its status");
  check(patterns.includes("/login") && !patterns.includes("/account"), "a page behind a sign-in shows as the sign-in page");
  check(deletes === 0 && signOuts === 0, `nothing was deleted or signed out (${deletes} deletes, ${signOuts} sign-outs)`);
  check(!patterns.some((p) => p.endsWith(".pdf") || p === "/popup" || p === "/hang"), "no files, popups or stray requests in the map");
  const order = found.find((p) => p.pattern === "/orders/:id")!;
  check(order.elements.forms[0]?.fields[0]?.label === "Note" && order.elements.forms[0]?.submit === "Save note", "forms are read with their fields and button");
  check(found.find((p) => p.pattern === "/")!.links.includes("/orders"), "links between pages are kept");
  check(found.every((p) => !!p.screenshot), `every page has a screenshot (missing: ${found.filter((p) => !p.screenshot).map((p) => p.pattern).join(" ") || "none"})`);
}

// 2. The page limit.
{
  const found: FoundPage[] = [];
  await explore({ baseUrl: base, maxPages: 3, dir: "/tmp/claritia-explore-2", chromiumPath, allowPrivate: true, pageTimeoutMs: 8000 }, async (p) => void found.push(p));
  check(found.length === 3, `the page limit holds (${found.length})`);
}

// 3. A site that's down fails fast with a plain reason.
{
  const r = await explore({ baseUrl: "http://127.0.0.1:1", maxPages: 5, dir: "/tmp/claritia-explore-3", chromiumPath, allowPrivate: true, pageTimeoutMs: 5000 }, async () => undefined);
  check(r.status === "error" && /didn't load/.test(r.error ?? ""), `a site that's down is an error (${r.error})`);
}

// 4. Private addresses are refused unless allowed.
{
  const r = await explore({ baseUrl: base, maxPages: 5, dir: "/tmp/claritia-explore-4", chromiumPath, pageTimeoutMs: 5000 }, async () => undefined);
  check(r.status === "error" && /private network/.test(r.error ?? ""), `a private address is refused (${r.error})`);
}

// The handler, with a stand-in database.
type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
function makeDb() {
  const db: Record<string, Row[]> = { explorations: [], app_pages: [], app_links: [], tests: [], env_secrets: [] };
  let seq = 0;
  const query = (table: string) => {
    const filters: ((r: Row) => boolean)[] = [];
    let patch: Row | null = null;
    let upsert: Row | Row[] | null = null;
    let single = false;
    const q: Row = {
      select: () => q,
      in: (k: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[k])), q),
      eq: (k: string, v: unknown) => (filters.push((r) => r[k] === v), q),
      update: (f: Row) => ((patch = f), q),
      upsert: (rows: Row | Row[]) => ((upsert = rows), q),
      maybeSingle: () => ((single = true), q),
      single: () => ((single = true), q),
      then: (ok: (v: unknown) => unknown) => {
        let rows: Row[];
        if (upsert) {
          rows = (Array.isArray(upsert) ? upsert : [upsert]).map((u) => {
            const hit = table === "app_pages" ? db.app_pages!.find((p) => p.project_id === u.project_id && p.pattern === u.pattern) : table === "app_links" ? db.app_links!.find((l) => l.from_page === u.from_page && l.to_page === u.to_page) : undefined;
            if (hit) return Object.assign(hit, u);
            const row = { id: `pg${++seq}`, ...u };
            db[table]!.push(row);
            return row;
          });
        } else {
          rows = (db[table] ?? []).filter((r) => filters.every((f) => f(r)));
          if (patch) for (const r of rows) Object.assign(r, patch);
        }
        return Promise.resolve({ data: single ? (rows[0] ?? null) : rows, error: null }).then(ok);
      },
    };
    return q;
  };
  const uploads: string[] = [];
  const sb = {
    from: query,
    rpc: async () => ({ data: [{ credits_used: 0, credits_limit: null }], error: null }),
    storage: { from: () => ({ upload: async (path: string) => (uploads.push(path), { error: null }) }) },
  };
  return { db, sb, uploads };
}
const namer: Namer = async (_site, pages) => ({ names: pages.map((p) => ({ pattern: p.pattern, name: `Name of ${p.pattern}`, purpose: "Does things." })), usage: { input: 1000, output: 100 } });
const signInLock = `import { test, expect } from '@playwright/test';

test('Sign in', async ({ page }) => {
  // step 1: Sign in
  await page.goto('/login');
  await page.getByLabel('Email').fill('qa@shop.test');
  await page.getByLabel('Password').fill('secret');
  await page.getByRole('button', { name: 'Sign in' }).click();
  // step 2: check: It's signed in
  await expect(page.getByRole('heading', { name: 'Your account' })).toBeVisible();
});
`;

// 5. Signed in with a test first: pages behind the sign-in are found, saved, linked and named.
{
  const { db, sb, uploads } = makeDb();
  db.tests!.push({ id: "t-sign-in", name: "Sign in", steps: [{}, {}], lock: signInLock });
  const x: Exploration = { id: "x1", workspace_id: "ws1", project_id: "p1", environment_id: null, base_url: base, sign_in_test_id: "t-sign-in", max_pages: 20, attempts: 1 };
  db.explorations!.push({ ...x, status: "running", locked_by: "w1" });
  await handleExploration(sb as never, x, { workerId: "w1", chromiumPath, allowPrivate: true, namer, pageTimeoutMs: 8000 });
  const row = db.explorations![0]!;
  const patterns = db.app_pages!.map((p) => p.pattern);
  check(row.status === "done", `the signed-in exploration finishes (${row.status} ${row.error ?? ""})`);
  check(patterns.includes("/account") && patterns.includes("/account/billing"), "pages behind the sign-in are found");
  check(signOuts === 0, "the Explorer never signed itself out");
  check(row.pages_found === db.app_pages!.length && row.pages_found > 5, `pages_found matches the map (${row.pages_found})`);
  check(db.app_pages!.every((p) => p.name?.startsWith("Name of") && p.purpose), "every page is named");
  check(row.ai_calls === Math.ceil(db.app_pages!.length / 10), `naming goes in batches of 10 (${row.ai_calls} calls)`);
  check(db.app_links!.length > 3 && uploads.every((u) => u.startsWith("ws1/explore/x1/")), "pages are linked and screenshots stored under the workspace");
}

// 6. A sign-in test that fails stops the exploration with its reason.
{
  const { db, sb } = makeDb();
  db.tests!.push({ id: "t-bad", name: "Bad sign in", steps: [{}, {}], lock: signInLock.replace("Your account", "Nope") });
  const x: Exploration = { id: "x2", workspace_id: "ws1", project_id: "p1", environment_id: null, base_url: base, sign_in_test_id: "t-bad", max_pages: 5, attempts: 1 };
  db.explorations!.push({ ...x, status: "running", locked_by: "w1" });
  await handleExploration(sb as never, x, { workerId: "w1", chromiumPath, allowPrivate: true, namer, pageTimeoutMs: 8000 });
  const row = db.explorations![0]!;
  check(row.status === "error" && /Bad sign in didn't pass/.test(row.error), `a failed sign-in test is the reason (${row.error?.slice(0, 80)})`);
  check(db.app_pages!.length === 0, "nothing is crawled after a failed sign-in");
}

// 7. Stop: a canceled exploration ends early and stays canceled.
{
  const { db, sb } = makeDb();
  const x: Exploration = { id: "x3", workspace_id: "ws1", project_id: "p1", environment_id: null, base_url: base, sign_in_test_id: null, max_pages: 50, attempts: 1 };
  db.explorations!.push({ ...x, status: "running", locked_by: "w1" });
  setTimeout(() => (db.explorations![0]!.status = "canceled"), 1500);
  await handleExploration(sb as never, x, { workerId: "w1", chromiumPath, allowPrivate: true, namer, pageTimeoutMs: 8000, concurrency: 1 });
  check(db.explorations![0]!.status === "canceled", `Stop keeps it canceled (${db.explorations![0]!.status}, ${db.app_pages!.length} pages)`);
}

server.closeAllConnections();
server.close();
console.log(failures ? `${failures} failed` : "All explore checks passed");
process.exit(failures ? 1 : 0);
