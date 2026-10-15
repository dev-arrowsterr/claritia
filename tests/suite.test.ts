import assert from "node:assert/strict";
import { test } from "node:test";
import { checkConnection, cleanBaseUrl, keyHint } from "../src/lib/suite.ts";
import { hostIsPrivate } from "../src/lib/privateNet.ts";

const ok = (status: number, body: unknown) => (async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status })) as unknown as typeof fetch;
const publicHost = async () => false;

test("base addresses are cleaned to https://host", () => {
  assert.deepEqual(cleanBaseUrl("app.omniscient.ai"), { url: "https://app.omniscient.ai" });
  assert.deepEqual(cleanBaseUrl("  https://App.Omniscient.ai/some/path?x=1 "), { url: "https://app.omniscient.ai" });
  assert.deepEqual(cleanBaseUrl("https://app.example.com:8443"), { url: "https://app.example.com:8443" });
  assert.ok("error" in cleanBaseUrl("http://app.example.com"));
  assert.ok("error" in cleanBaseUrl("https://user:pw@app.example.com"));
  assert.ok("error" in cleanBaseUrl("not a url at all"));
});

test("a good answer names the workspace on the other side", async () => {
  const seen: { url: string; init: RequestInit }[] = [];
  const fetchSpy = (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    return new Response(JSON.stringify({ workspace: "Acme" }), { status: 200 });
  }) as unknown as typeof fetch;
  assert.deepEqual(await checkConnection("omniscient", "https://app.omniscient.ai", "omn_x", { fetch: fetchSpy, isPrivate: publicHost }), { ok: true, detail: "Acme" });
  assert.equal(seen[0]!.url, "https://app.omniscient.ai/api/v1/me");
  assert.equal((seen[0]!.init.headers as Record<string, string>).Authorization, "Bearer omn_x");
  assert.equal(seen[0]!.init.redirect, "manual");
});

test("each failure gets its own plain message", async () => {
  const run = (f: typeof fetch) => checkConnection("arrowsterr", "https://app.arrowsterr.com", "k", { fetch: f, isPrivate: publicHost });
  assert.deepEqual(await run(ok(401, {})), { ok: false, error: "Arrowsterr didn't accept the key." });
  assert.deepEqual(await run(ok(404, {})), { ok: false, error: "app.arrowsterr.com doesn't have the Claritia connection yet." });
  const moved = await run(ok(302, ""));
  assert.ok(!moved.ok && /somewhere else/.test(moved.error));
  assert.deepEqual(await run(ok(500, {})), { ok: false, error: "Arrowsterr answered with an error (500)." });
  assert.deepEqual(await run(ok(200, "<html>")), { ok: false, error: "app.arrowsterr.com didn't answer like Arrowsterr." });
  assert.deepEqual(await run((async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch), { ok: false, error: "Couldn't reach app.arrowsterr.com." });
});

test("private addresses are refused before any call", async () => {
  let called = false;
  const spy = (async () => { called = true; return new Response("{}"); }) as unknown as typeof fetch;
  const r = await checkConnection("omniscient", "https://intranet.example", "k", { fetch: spy, isPrivate: async () => true });
  assert.deepEqual(r, { ok: false, error: "intranet.example points to a private network address." });
  assert.ok(!called);
  assert.ok(await hostIsPrivate("localhost"));
  assert.ok(await hostIsPrivate("10.0.0.5"));
  assert.ok(await hostIsPrivate("[::1]"));
  assert.ok(!(await hostIsPrivate("8.8.8.8")));
  assert.ok(await hostIsPrivate("evil.example", (async () => [{ address: "169.254.169.254", family: 4 }]) as never));
});

test("key hints show only the end", () => {
  assert.equal(keyHint("omn_abcdefghijklmnop"), "…mnop");
});
