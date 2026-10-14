// One-click connect, end to end in Chrome with the recorder extension loaded: a stand-in Claritia app on
// localhost:3000 hands the extension a key from its /extension page; the popup then shows the projects. The same page
// served from another address (a look-alike site) is refused.
//   CHROMIUM_PATH=/path/to/chrome node scripts/connect-check.ts

import { rmSync } from "node:fs";
import { createServer } from "node:http";
import pw from "playwright-core";

const KEY = "clr_" + "k".repeat(40);
const page = `<!doctype html><title>Connect</title><button id="go">Connect</button><p id="out"></p><script>
  document.getElementById('go').onclick = () => {
    addEventListener('message', (e) => { if (e.data && e.data.type === 'claritia-recorder-connected') document.getElementById('out').textContent = JSON.stringify(e.data); });
    postMessage({ type: 'claritia-recorder-connect', key: '${KEY}', app: location.origin }, location.origin);
  };
</script>`;
const app = createServer((req, res) => {
  if (req.url === "/extension") return res.writeHead(200, { "content-type": "text/html" }).end(page);
  if (req.url === "/api/v1/projects") {
    const ok = req.headers.authorization === `Bearer ${KEY}`;
    return res.writeHead(ok ? 200 : 401, { "content-type": "application/json" }).end(JSON.stringify(ok ? { projects: [{ id: "p1", name: "Arrowster", environments: [] }] } : { error: "This API key is wrong or was revoked." }));
  }
  res.writeHead(404).end();
});
await new Promise<void>((r) => app.listen(3000, "0.0.0.0", r));

let failures = 0;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${what}`);
  if (!ok) failures++;
};
const ext = new URL("../extension", import.meta.url).pathname;
const profile = "/tmp/claritia-connect-profile";
rmSync(profile, { recursive: true, force: true });
const ctx = await pw.chromium.launchPersistentContext(profile, {
  executablePath: process.env.CHROMIUM_PATH,
  headless: true,
  args: ["--headless=new", `--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});
const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker"));
const popupUrl = `chrome-extension://${new URL(sw.url()).host}/popup.html`;

// A look-alike page on another address is refused.
const fake = await ctx.newPage();
await fake.goto("http://127.0.0.1:3000/extension");
await fake.click("#go");
await fake.waitForFunction(() => document.getElementById("out")!.textContent !== "", null, { timeout: 5000 });
const refused = JSON.parse((await fake.textContent("#out"))!);
check(refused.ok === false && /only works from the Claritia app/.test(refused.error), `a look-alike site is refused (${refused.error})`);
const before = await ctx.newPage();
await before.goto(popupUrl);
check(await before.locator("#signin").isVisible(), "the popup still asks to connect after the refusal");
await before.close();

// The real app page connects.
const real = await ctx.newPage();
await real.goto("http://localhost:3000/extension");
await real.click("#go");
await real.waitForFunction(() => document.getElementById("out")!.textContent !== "", null, { timeout: 5000 });
const answer = JSON.parse((await real.textContent("#out"))!);
check(answer.ok === true, `the Claritia app connects the recorder (${JSON.stringify(answer)})`);
const popup = await ctx.newPage();
await popup.goto(popupUrl);
await popup.waitForSelector("#projects button", { timeout: 5000 }).catch(() => undefined);
check(await popup.locator("#main").isVisible(), "the popup opens straight to recording");
check((await popup.locator("#projects button").allTextContents()).includes("Arrowster"), "the workspace's projects are listed");

await ctx.close();
app.close();
console.log(failures ? `${failures} failed` : "All connect checks passed");
process.exit(failures ? 1 : 0);
