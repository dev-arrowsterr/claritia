import assert from "node:assert/strict";
import { test } from "node:test";
import { proxyToCollect } from "../src/lib/web/proxy.ts";

test("the proxy forwards the visitor's IP with the secret, and passes cookies both ways", async () => {
  let seen: { url: string; headers: Headers; body?: string } | null = null;
  const fetcher = (async (url: URL, init: RequestInit) => {
    seen = { url: url.toString(), headers: new Headers(init.headers), body: init.body as string };
    const h = new Headers({ "content-type": "application/json", "x-internal": "no" });
    h.append("set-cookie", "_clr_id=v1.x; Path=/; HttpOnly");
    h.append("set-cookie", "_clr_opt=1; Path=/");
    return new Response('{"p":"full"}', { status: 200, headers: h });
  }) as unknown as typeof fetch;
  const req = new Request("https://tryclaritia.com/_clr/e?x=1", { method: "POST", body: '{"v":1}', headers: { cookie: "_clr_id=old", origin: "https://tryclaritia.com", "x-clr-client-ip": "6.6.6.6", authorization: "Bearer t" } });
  const res = await proxyToCollect(req, "e", { collectUrl: "https://collect.example/", clientIp: "198.51.100.7", proxySecret: "s3", fetcher });
  assert.equal(seen!.url, "https://collect.example/e?x=1");
  assert.equal(seen!.headers.get("x-clr-client-ip"), "198.51.100.7", "the visitor can't pick their own IP");
  assert.equal(seen!.headers.get("x-clr-proxy"), "s3");
  assert.equal(seen!.headers.get("cookie"), "_clr_id=old");
  assert.equal(seen!.headers.get("authorization"), null);
  assert.equal(seen!.body, '{"v":1}');
  assert.equal(res.status, 200);
  assert.deepEqual(res.headers.getSetCookie().length, 2);
  assert.equal(res.headers.get("x-internal"), null);
});

test("no secret means no IP header; bad paths and a down collect are handled", async () => {
  let headers: Headers | null = null;
  const ok = (async (_u: URL, init: RequestInit) => ((headers = new Headers(init.headers)), new Response(null, { status: 204 }))) as unknown as typeof fetch;
  await proxyToCollect(new Request("https://a.com/_clr/s.js"), "s.js", { collectUrl: "https://c", clientIp: "1.2.3.4", proxySecret: null, fetcher: ok });
  assert.equal(headers!.get("x-clr-client-ip"), null);
  assert.equal((await proxyToCollect(new Request("https://a.com/_clr/x"), "../etc", { collectUrl: "https://c", fetcher: ok })).status, 404);
  const down = (async () => {
    throw new Error("refused");
  }) as unknown as typeof fetch;
  assert.equal((await proxyToCollect(new Request("https://a.com/_clr/e", { method: "POST", body: "{}" }), "e", { collectUrl: "https://c", fetcher: down })).status, 503);
});
