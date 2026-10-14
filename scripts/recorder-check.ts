// Record, then replay: drives a real browser through a local site with the recorder's content script in the page,
// builds the test the recorder would save, checks Claritia can read it, then replays it with the runner in a fresh
// browser. A recorded test that doesn't replay is a broken recorder.
//   CHROMIUM_PATH=/path/to/chrome node scripts/recorder-check.ts

import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import pw from "playwright-core";
import { addStep } from "../extension/steps.js";
import { buildLock, parseLock } from "../src/lib/lock.ts";
import { executeRun } from "../worker/runner.ts";

const chromiumPath = process.env.CHROMIUM_PATH;
const content = await readFile(new URL("../extension/content.js", import.meta.url), "utf8");

const page = (title: string, body: string) => `<!doctype html><title>${title}</title><body>${body}</body>`;
const server = createServer((req, res) => {
  const url = new URL(req.url!, "http://x");
  const html = (b: string) => res.writeHead(200, { "content-type": "text/html" }).end(b);
  const signedIn = /session=ok/.test(req.headers.cookie ?? "");
  if (url.pathname === "/login" && req.method === "POST") return void setTimeout(() => res.writeHead(302, { location: "/cart", "set-cookie": "session=ok; Path=/" }).end(), 600);
  if (url.pathname === "/login") return html(page("Sign in", `<h1>Sign in</h1><form method="post" action="/login"><label for="e">Email</label><input id="e" name="e"><label for="p">Password</label><input id="p" type="password" name="p"><button type="submit">Sign in</button></form>`));
  if (url.pathname === "/cart") {
    if (!signedIn) return res.writeHead(302, { location: "/login" }).end();
    return html(
      page(
        "Cart",
        `<h1>Your cart</h1>
        <ul><li>Hoodie <button onclick="this.parentNode.remove()">Remove</button></li><li>Cap <button onclick="this.parentNode.remove(); document.getElementById('msg').textContent='Cap removed'">Remove</button></li></ul>
        <p id="msg"></p>
        <label><input type="checkbox" id="gift"> Gift wrap</label>
        <label for="ship">Shipping</label><select id="ship"><option>Standard</option><option>Express</option></select>
        <input placeholder="Search products" onkeydown="if(event.key==='Enter'){document.getElementById('res').textContent='Results for '+this.value}">
        <p id="res"></p>
        <button aria-label="Open menu" onclick="document.getElementById('menu').hidden=false">☰</button>
        <div id="menu" hidden><a href="/orders">Orders</a></div>
        <button data-testid="apply-coupon" onclick="document.getElementById('res').textContent='Coupon applied'">Apply</button>`,
      ),
    );
  }
  if (url.pathname === "/orders") return html(page("Orders", `<h1>Orders</h1><div class="empty">No orders yet</div>`));
  res.writeHead(404).end();
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

let failures = 0;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${what}`);
  if (!ok) failures++;
};

// 1. Record.
type Step = { kind: "do" | "check"; text: string; code: string[]; key?: string; checkDone?: boolean };
let steps: Step[] = [{ kind: "do", text: "Go to /login", code: ["await page.goto('/login');"] }];
const browser = await pw.chromium.launch({ headless: true, executablePath: chromiumPath });
const ctx = await browser.newContext();
let mode = "record";
await ctx.exposeBinding("__recordStep", (_src, step: Step) => {
  const { checkDone, ...s } = step;
  steps = addStep(steps, s);
  if (checkDone) mode = "record";
});
await ctx.exposeBinding("__mode", () => mode);
await ctx.addInitScript(`
  window.chrome = { runtime: {
    sendMessage: (m, cb) => {
      if (m.type === 'step') { window.__recordStep(m.step).then(() => window.__mode()).then((md) => window.__claritiaApply && window.__claritiaApply({ recording: true, mode: md })); }
      else if (m.type === 'hello') { window.__mode().then((md) => cb && cb({ recording: true, mode: md })); }
    },
    onMessage: { addListener() {} },
  } };
`);
await ctx.addInitScript(content);
const p = await ctx.newPage();
const checkMode = async () => {
  mode = "check";
  await p.evaluate(() => (window as unknown as { __claritiaApply: (s: object) => void }).__claritiaApply({ recording: true, mode: "check" }));
};
await p.goto(`${base}/login`);
await p.getByLabel("Email").click();
await p.getByLabel("Email").pressSequentially("qa@shop.test");
await p.getByLabel("Password").pressSequentially("hunter2-secret");
await p.getByRole("button", { name: "Sign in" }).click();
await p.waitForURL("**/cart");
await p.getByRole("button", { name: "Remove" }).nth(1).click();
await checkMode();
await p.getByText("Cap removed").click();
await p.getByLabel("Gift wrap").check();
// The way a person picks with the keyboard: focus the dropdown, arrow down to Express.
await p.getByLabel("Shipping").focus();
await p.keyboard.press("ArrowDown");
await p.getByPlaceholder("Search products").pressSequentially("hood");
await p.getByPlaceholder("Search products").press("Enter");
await p.getByTestId("apply-coupon").click();
await p.getByRole("button", { name: "Open menu" }).click();
await p.getByRole("link", { name: "Orders" }).click();
await p.waitForURL("**/orders");
await checkMode();
await p.getByText("No orders yet").click();
await new Promise((r) => setTimeout(r, 300));
await browser.close();

const texts = steps.map((s) => (s.kind === "check" ? `check: ${s.text}` : s.text));
console.log(texts.map((t, i) => `  ${i + 1}. ${t}`).join("\n"));
check(texts.includes('Type "qa@shop.test" into the "Email" field'), "typing is one step with the final value");
check(texts.includes('Type process.env.PASSWORD into the "Password" field') && !JSON.stringify(steps).includes("hunter2"), "the password is never recorded, only its secret name");
check(texts.filter((t) => t.startsWith("Click the \"Email\"")).length === 0, "clicking into a field before typing isn't a step");
check(steps.some((s) => s.code[0]!.includes("getByRole('button', { name: 'Remove', exact: true }).nth(1)")), "the second of two Remove buttons is told apart with nth(1)");
check(texts.includes('check: "Cap removed" shows'), "check mode records a check, not a click");
check(texts.includes('Tick the "Gift wrap" checkbox') && texts.includes('Choose "Express" in the "Shipping" field'), "ticking and choosing are recorded");
check(texts.includes('Press Enter in the "Search products" field'), "Enter is recorded after the typing");
check(texts.includes("Click the apply-coupon element") && texts.includes('Click the "Open menu" button'), "test ids and icon buttons with labels get good locators");
check(texts.at(-1) === 'check: "No orders yet" shows', "a check after following a link works on the new page");

// 2. Build what the recorder saves, and check Claritia can read it.
const lock = buildLock("Recorded checkout", steps.map((s) => ({ label: s.kind === "check" ? `check: ${s.text}` : s.text, lines: s.code })));
const parsed = parseLock(lock);
check(parsed.ok, `Claritia can read the recorded code${parsed.ok ? "" : `: ${parsed.errors.map((e) => `line ${e.line} ${e.message}`).join("; ")}`}`);
check(parsed.ok && parsed.secrets.join() === "PASSWORD", "the password comes from the PASSWORD secret");

// 3. Replay it with the runner, in a fresh browser.
const statuses: string[] = [];
const r = await executeRun({ baseUrl: base, lock, positions: steps.map((_, i) => i + 1), secrets: { PASSWORD: "hunter2-secret" }, dir: "/tmp/claritia-recorder", chromiumPath, allowPrivate: true }, { step: async (u) => void (u.status !== "running" && statuses.push(`${u.position}:${u.status}`)) });
check(r.status === "passed", `the recorded test replays and passes (${r.status} ${r.error ?? ""})`);
check(statuses.length === steps.length && statuses.every((s) => s.endsWith(":passed")), `every recorded step passes on replay (${statuses.filter((s) => !s.endsWith(":passed")).join(" ") || "all"})`);

server.closeAllConnections();
server.close();
console.log(failures ? `${failures} failed` : "All recorder checks passed");
process.exit(failures ? 1 : 0);
