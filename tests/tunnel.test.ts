// The tunnel end to end, all on this machine: a local app, the relay, the CLI's tunnel and the runner's client.
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, test } from "node:test";
// @ts-expect-error Plain JavaScript modules.
import { createRelay } from "../relay/relay.mjs";
// @ts-expect-error Plain JavaScript modules.
import { runTunnel } from "../cli/tunnel.mjs";
import { connectTunnel, isLocalHost, tunnelFetch } from "../worker/tunnel.ts";

const SECRET = "a-relay-secret-that-is-long-enough-123456";
const KEY = "clr_" + "k".repeat(40);
const listen = (s: Server) => new Promise<number>((r) => s.listen(0, "127.0.0.1", () => r((s.address() as { port: number }).port)));

const app = createServer((req, res) => {
  if (req.url === "/hello") return res.writeHead(200, { "content-type": "text/html", "set-cookie": ["a=1", "b=2"] }).end("<h1>Hello from localhost</h1>");
  if (req.url === "/echo" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => res.writeHead(201, { "content-type": "application/json" }).end(JSON.stringify({ got: body, host: req.headers.host, enc: req.headers["accept-encoding"] })));
    return;
  }
  if (req.url === "/slow") return void setTimeout(() => res.end("late"), 1500);
  if (req.url === "/go") return res.writeHead(302, { location: "/hello" }).end();
  if (req.url === "/big") return res.end("x".repeat(3_000_000));
  res.writeHead(404).end("nope");
});
const saved: { workspaceId: string; ports: number[] }[] = [];
const closed: string[] = [];
const relay = createRelay({
  secret: SECRET,
  verifyKey: async (k: string) => (k === KEY ? { workspaceId: "ws1", keyId: "key1" } : null),
  saveTunnel: async (t: { workspaceId: string; ports: number[] }) => (saved.push(t), `tun-${saved.length}`),
  touchTunnel: async () => undefined,
  closeTunnel: async (id: string) => void closed.push(id),
});
let appPort = 0;
let relayUrl = "";
const stops: AbortController[] = [];
before(async () => {
  appPort = await listen(app);
  relayUrl = `ws://127.0.0.1:${await listen(relay.server)}`;
});
after(async () => {
  stops.forEach((s) => s.abort());
  await relay.close();
  app.closeAllConnections();
  app.close();
});

async function openTunnel(ports: number[], key = KEY) {
  const ac = new AbortController();
  stops.push(ac);
  const lines: string[] = [];
  let id = "";
  const done = runTunnel({ key, relay: relayUrl, ports, out: (s: string) => lines.push(s), err: (s: string) => lines.push(s), signal: ac.signal, onOpen: (t: string) => (id = t) });
  for (let i = 0; i < 100 && !id; i++) await new Promise((r) => setTimeout(r, 20));
  return { id, lines, stop: () => ac.abort(), done };
}

test("local host names are spotted", () => {
  for (const h of ["localhost", "127.0.0.1", "::1", "[::1]", "app.localhost"]) assert.ok(isLocalHost(h), h);
  for (const h of ["example.com", "10.0.0.5", "localhost.evil.com"]) assert.ok(!isLocalHost(h), h);
});

test("pages on localhost come back through the tunnel: GET, POST, redirects, cookies, slow and big answers", async () => {
  const t = await openTunnel([appPort]);
  assert.ok(t.id, t.lines.join("\n"));
  assert.match(t.lines[0]!, new RegExp(`Tunnel open: Claritia can reach localhost:${appPort}`));
  assert.deepEqual(saved.at(-1), { workspaceId: "ws1", keyId: "key1", ports: [appPort] });
  const c = await connectTunnel({ relayUrl, secret: SECRET, tunnelId: t.id });
  const get = await tunnelFetch(c, { url: `http://localhost:${appPort}/hello`, method: "GET", headers: { "accept-encoding": "gzip, br" } });
  assert.equal(get.status, 200);
  assert.equal(get.body.toString(), "<h1>Hello from localhost</h1>");
  assert.equal(get.headers["set-cookie"], "a=1\nb=2");
  const post = await tunnelFetch(c, { url: `http://127.0.0.1:${appPort}/echo`, method: "POST", headers: { "content-type": "text/plain" }, body: Buffer.from("hi") });
  assert.equal(post.status, 201);
  assert.deepEqual(JSON.parse(post.body.toString()), { got: "hi", host: `127.0.0.1:${appPort}`, enc: "identity" });
  const go = await tunnelFetch(c, { url: `http://localhost:${appPort}/go`, method: "GET", headers: {} });
  assert.equal(go.status, 302);
  assert.equal(go.headers.location, "/hello");
  const [slow, big] = await Promise.all([tunnelFetch(c, { url: `http://localhost:${appPort}/slow`, method: "GET", headers: {} }), tunnelFetch(c, { url: `http://localhost:${appPort}/big`, method: "GET", headers: {} })]);
  assert.equal(slow.body.toString(), "late");
  assert.equal(big.body.length, 3_000_000);
  c.close();
  t.stop();
  assert.equal(await t.done, 0);
});

test("only the shared ports are reachable, and a port with nothing on it says so", async () => {
  const t = await openTunnel([appPort]);
  const c = await connectTunnel({ relayUrl, secret: SECRET, tunnelId: t.id });
  await assert.rejects(tunnelFetch(c, { url: "http://localhost:22/", method: "GET", headers: {} }), /isn't shared by the tunnel/);
  const dead = await openTunnel([1]);
  const c2 = await connectTunnel({ relayUrl, secret: SECRET, tunnelId: dead.id });
  await assert.rejects(tunnelFetch(c2, { url: "http://localhost:1/", method: "GET", headers: {} }), /Nothing answered on localhost:1/);
  c.close();
  c2.close();
  t.stop();
  dead.stop();
});

test("a wrong relay secret or a closed tunnel is refused; a wrong key stops the CLI", async () => {
  const t = await openTunnel([appPort]);
  await assert.rejects(connectTunnel({ relayUrl, secret: "wrong", tunnelId: t.id }), /secret/i);
  await assert.rejects(connectTunnel({ relayUrl, secret: SECRET, tunnelId: "nope" }), /isn't open/);
  t.stop();
  await t.done;
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(closed.includes(t.id), "the closed tunnel wasn't recorded");
  const bad = await openTunnel([appPort], "clr_" + "x".repeat(40));
  assert.equal(await bad.done, 3);
  assert.match(bad.lines.join("\n"), /wrong or was revoked/);
});

test("when the tunnel drops mid-request, the request fails instead of hanging", async () => {
  const t = await openTunnel([appPort]);
  const c = await connectTunnel({ relayUrl, secret: SECRET, tunnelId: t.id });
  const pending = tunnelFetch(c, { url: `http://localhost:${appPort}/slow`, method: "GET", headers: {} });
  setTimeout(() => t.stop(), 200);
  await assert.rejects(pending, /closed|socket hang up|aborted/i);
  c.close();
});
