import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { createApp, eventDay } from "../collect/app.ts";
import { attribute } from "../collect/attribution.ts";
import { botVerdict, looksAutomated } from "../collect/bots.ts";
import { WriteBuffer } from "../collect/buffer.ts";
import { cleanIp, ipNet, readRecord, type Geo } from "../collect/geo.ts";
import { cookielessKey, deviceBornAt, hopKey, makeHop, readHop, signDevice, siteKey, uuid7, verifyDevice } from "../collect/ids.ts";
import { Buckets } from "../collect/limits.ts";
import { continues, Sessions, type Live } from "../collect/sessions.ts";
import type { EventRow, EvidenceRow, Prior, SessionRow, Site, Store } from "../collect/store.ts";
import { parseAgent } from "../collect/ua.ts";
import { decide, regionOf, type ConsentState, type Region } from "../src/lib/web/policy.ts";

const SECRET = "x".repeat(40);
const CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

// Policy ------------------------------------------------------------------------------------------------

test("regions", () => {
  assert.equal(regionOf("DE", ""), "strict");
  assert.equal(regionOf("GB", ""), "strict");
  assert.equal(regionOf("US", "CA"), "notice");
  assert.equal(regionOf("CA", "ON"), "notice");
  assert.equal(regionOf("CA", "QC"), "strict");
  assert.equal(regionOf("CA", ""), "strict", "Canada without a province could be Quebec");
  assert.equal(regionOf("", ""), "strict", "unknown is strict");
  assert.equal(regionOf("JP", ""), "notice");
  assert.equal(regionOf("JP", "", { strict: ["JP"] }), "strict");
  assert.equal(regionOf("US", "TX", { off: ["US-TX"] }), "off");
  assert.equal(regionOf("DE", "", { off: ["de"] }), "off");
});

test("policy matrix: every case keeps the rules", () => {
  let n = 0;
  for (const region of ["strict", "notice", "off"] as Region[])
    for (const consent of ["granted", "denied", "unknown"] as ConsentState[])
      for (const gpc of [false, true])
        for (const optedOut of [false, true])
          for (const dnt of [false, true])
            for (const honorDnt of [false, true]) {
              const d = decide({ region, consent, gpc, optedOut, dnt, honorDnt });
              const tag = JSON.stringify({ region, consent, gpc, optedOut, dnt, honorDnt, d });
              n++;
              if (region === "off" || optedOut) assert.equal(d.mode, "off", tag);
              if (gpc) assert.notEqual(d.mode, "full", tag);
              if (consent === "denied") assert.notEqual(d.mode, "full", tag);
              if (region === "strict" && consent !== "granted") assert.ok(d.mode !== "full" && !d.lookup, tag);
              if (dnt && honorDnt) assert.notEqual(d.mode, "full", tag);
              if (d.mode === "full") assert.ok(!gpc && consent !== "denied" && !optedOut && region !== "off", tag);
              if (region === "notice" && !gpc && consent !== "denied" && !optedOut && !(dnt && honorDnt)) assert.equal(d.mode, "full", tag);
              if (region === "strict" && consent === "granted" && !gpc && !optedOut && !(dnt && honorDnt)) assert.equal(d.mode, "full", tag);
              if (d.mode === "off") assert.equal(d.lookup, false, tag);
            }
  assert.equal(n, 144);
});

// Ids ---------------------------------------------------------------------------------------------------

test("device ids are signed per site", () => {
  const a = siteKey(SECRET, "site-a");
  const b = siteKey(SECRET, "site-b");
  const u = uuid7();
  const id = signDevice(a, u);
  assert.equal(verifyDevice(a, id), u);
  assert.equal(verifyDevice(b, id), null, "another site's id");
  // Change a middle character of the signature: the last base64url character can carry only padding bits.
  const sig = id.split(".")[2];
  const at = Math.floor(sig.length / 2);
  const tampered = `${id.slice(0, id.length - sig.length)}${sig.slice(0, at)}${sig[at] === "A" ? "B" : "A"}${sig.slice(at + 1)}`;
  assert.equal(verifyDevice(a, tampered), null, "tampered");
  assert.equal(verifyDevice(a, `v1.${uuid7()}.${id.split(".")[2]}`), null, "other uuid with this signature");
  assert.equal(verifyDevice(a, "v2." + id.slice(3)), null);
  assert.equal(verifyDevice(a, 42), null);
  assert.equal(verifyDevice(a, "x".repeat(200)), null);
});

test("uuid v7 carries the time", () => {
  const t = Date.UTC(2026, 9, 15, 12, 0, 0);
  const u = uuid7(t);
  assert.match(u, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(deviceBornAt(u), t);
  assert.equal(eventDay(u, t), "2026-10-15");
  assert.equal(eventDay(u, t + 3 * 86400_000), "2026-10-18", "a far-off client clock uses the server day");
  assert.equal(eventDay(uuid7(Date.UTC(2026, 9, 15, 23, 59, 59)), Date.UTC(2026, 9, 16, 0, 0, 5)), "2026-10-15", "a retry after midnight keeps its day");
});

test("hop tokens: valid once, expire, can't be forged", () => {
  const k = hopKey(SECRET, "ws1");
  const u = uuid7();
  const t = makeHop(k, u, 1_000_000_000);
  const r = readHop(k, t, 1_000_000_000 + 60_000);
  assert.equal(r?.uuid, u);
  assert.equal(r?.nonce.length, 8);
  assert.equal(readHop(k, t, 1_000_000_000 + 121_000), null, "expired");
  assert.equal(readHop(hopKey(SECRET, "ws2"), t, 1_000_000_000), null, "another workspace");
  const [p, s] = t.split(".");
  const bytes = Buffer.from(p, "base64url");
  bytes[0] ^= 1;
  assert.equal(readHop(k, `${bytes.toString("base64url")}.${s}`, 1_000_000_000), null, "changed device");
  assert.equal(readHop(k, "nope", 1), null);
});

test("cookieless keys change with the salt", () => {
  const s1 = randomBytes(32);
  const s2 = randomBytes(32);
  const a = cookielessKey(s1, "site", "1.2.3.0/24", CHROME, "en");
  assert.deepEqual(a, cookielessKey(s1, "site", "1.2.3.0/24", CHROME, "en"));
  assert.notDeepEqual(a, cookielessKey(s2, "site", "1.2.3.0/24", CHROME, "en"));
  assert.notDeepEqual(a, cookielessKey(s1, "site", "1.2.4.0/24", CHROME, "en"));
});

// Geo, agent, attribution ---------------------------------------------------------------------------------

test("networks are /24 and /48 only", () => {
  assert.equal(ipNet("203.0.113.77"), "203.0.113.0/24");
  assert.equal(ipNet("2001:db8:abcd:12::1"), "2001:db8:abcd::/48");
  assert.equal(ipNet("2001:db8::1"), "2001:db8:0::/48");
  assert.equal(ipNet("::1"), "0:0:0::/48");
  assert.equal(ipNet("nope"), null);
  assert.equal(cleanIp("::ffff:203.0.113.5"), "203.0.113.5");
  assert.equal(cleanIp("1.2.3"), "");
});

test("geo records from MaxMind and IPinfo files", () => {
  assert.deepEqual(readRecord({ country: { iso_code: "CA" }, subdivisions: [{ iso_code: "QC" }], city: { names: { en: "Montreal" } } }), { country: "CA", subdivision: "QC", city: "Montreal", asn: null } satisfies Geo);
  assert.deepEqual(readRecord({ country: "US", asn: "AS16509", as_name: "Amazon" }), { country: "US", subdivision: "", city: "", asn: 16509 });
  assert.deepEqual(readRecord(null), { country: "", subdivision: "", city: "", asn: null });
  // IPinfo Lite: country is the name, country_code the code.
  assert.deepEqual(readRecord({ country: "United States", country_code: "US", continent: "North America", asn: "AS7922", as_name: "Comcast", as_domain: "comcast.net" }), { country: "US", subdivision: "", city: "", asn: 7922 });
});

test("a failed geo download leaves lookups empty, never broken", async () => {
  const { ipinfoGeo } = await import("../collect/geo.ts");
  const logs: string[] = [];
  const geo = await ipinfoGeo({ token: "t", path: `/tmp/geo-test-${process.pid}.mmdb`, fetcher: (async () => new Response("no", { status: 403 })) as unknown as typeof fetch, log: (m) => logs.push(m), refreshMs: 3600_000 });
  assert.deepEqual(geo("8.8.8.8"), { country: "", subdivision: "", city: "", asn: null });
  assert.ok(logs.includes("geo load failed"));
});

test("agents", () => {
  assert.deepEqual(parseAgent(CHROME), { device_type: "desktop", browser: "Chrome", os: "macOS" });
  assert.deepEqual(parseAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1"), { device_type: "mobile", browser: "Safari", os: "iOS" });
  assert.deepEqual(parseAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36 Edg/140.0"), { device_type: "desktop", browser: "Edge", os: "Windows" });
  assert.equal(parseAgent("Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 Chrome/140 Safari/537.36").device_type, "tablet");
});

test("attribution", () => {
  const u = (s: string) => new URL(s);
  assert.equal(attribute(u("https://acme.com/"), "https://www.google.com/", ["acme.com"]).ref_class, "search");
  assert.equal(attribute(u("https://acme.com/"), "https://chatgpt.com/", ["acme.com"]).ref_class, "ai_assistant");
  assert.equal(attribute(u("https://acme.com/"), "https://www.g2.com/products/x", ["acme.com"]).ref_class, "review_site");
  assert.equal(attribute(u("https://acme.com/"), "https://www.linkedin.com/feed", ["acme.com"]).ref_class, "social");
  assert.equal(attribute(u("https://acme.com/?gclid=abc"), "https://www.google.com/", ["acme.com"]).ref_class, "paid");
  assert.equal(attribute(u("https://acme.com/?utm_medium=email&utm_source=nl"), null, ["acme.com"]).ref_class, "email");
  assert.equal(attribute(u("https://acme.com/"), null, ["acme.com"]).ref_class, "direct");
  assert.equal(attribute(u("https://acme.com/"), "https://docs.acme.com/x", ["acme.com"]).ref_class, "direct", "own domain is not a referrer");
  const a = attribute(u("https://acme.com/?utm_source=Newsletter&utm_campaign=q4"), "https://news.example.org/", ["acme.com"]);
  assert.deepEqual([a.source, a.campaign, a.referrer_host, a.ref_class], ["Newsletter", "q4", "news.example.org", "other"]);
});

// Bots, limits, sessions ------------------------------------------------------------------------------------

test("bots", () => {
  assert.equal(botVerdict({ ua: "Googlebot/2.1 (+http://www.google.com/bot.html)", asn: null, ipTrusted: true }), "drop");
  assert.equal(botVerdict({ ua: "", asn: null, ipTrusted: true }), "drop");
  assert.equal(botVerdict({ ua: CHROME, asn: 16509, ipTrusted: true }), "hosting");
  assert.equal(botVerdict({ ua: CHROME, asn: 16509, ipTrusted: false }), "ok", "the proxy's network says nothing");
  assert.equal(botVerdict({ ua: CHROME, asn: 13335, ipTrusted: true }), "ok", "Cloudflare carries Private Relay users");
  assert.equal(botVerdict({ ua: CHROME, asn: null, ipTrusted: true, webdriver: true }), "mark");
  assert.ok(looksAutomated({ pageviews: 11, inputs: 0, startedAt: 0 }, 31_000));
  assert.ok(!looksAutomated({ pageviews: 11, inputs: 1, startedAt: 0 }, 31_000));
  assert.ok(!looksAutomated({ pageviews: 11, inputs: 0, startedAt: 0 }, 29_000));
});

test("token buckets", () => {
  const b = new Buckets(2, 2);
  assert.ok(b.take("a", 0) && b.take("a", 0));
  assert.ok(!b.take("a", 0));
  assert.ok(b.take("a", 600));
  assert.ok(b.take("b", 0));
});

test("session split rules", () => {
  const s = { startedAt: 0, lastAt: 0, campaign: "q4" };
  assert.ok(continues(s, 29 * 60_000, null));
  assert.ok(!continues(s, 31 * 60_000, null), "30 minutes idle");
  assert.ok(continues(s, 60_000, "q4"));
  assert.ok(!continues(s, 60_000, "spring"), "new campaign");
  assert.ok(!continues({ startedAt: 0, lastAt: 12 * 3600_000, campaign: null }, 12 * 3600_000 + 1, null), "12 hours");
});

test("two requests for one device at once start one visit", async () => {
  const s = new Sessions();
  let starts = 0;
  const start = async (): Promise<Live> => {
    starts++;
    await new Promise((r) => setTimeout(r, 20));
    return { id: "s" + starts, startedAt: 0, lastAt: 0, campaign: null, pageviews: 0, inputs: 0, bot: false, hosting: false };
  };
  const [a, b, c] = await Promise.all([1, 2, 3].map(() => s.current("dev", 1, null, async () => null, start)));
  assert.equal(starts, 1);
  assert.deepEqual([a.s.id, b.s.id, c.s.id], ["s1", "s1", "s1"]);
  assert.equal([a, b, c].filter((x) => x.fresh).length, 1);
});

test("a visit found in Postgres goes on; a stale one doesn't", async () => {
  const s = new Sessions();
  const prior: Prior = { id: "old", startedAt: 0, endedAt: 10 * 60_000, campaign: null, pageviews: 3 };
  const start = async (): Promise<Live> => ({ id: "new", startedAt: 0, lastAt: 0, campaign: null, pageviews: 0, inputs: 0, bot: false, hosting: false });
  assert.equal((await s.current("d1", 20 * 60_000, null, async () => prior, start)).s.id, "old");
  assert.equal((await s.current("d2", 45 * 60_000, null, async () => prior, start)).s.id, "new");
});

// Write buffer -----------------------------------------------------------------------------------------------

const row = (id: string, kind = "view"): EventRow => ({ id, workspace_id: "w", session_id: "s", day: "2026-10-15", kind, path: "/", title: null, data: null, client_at: null });

test("buffer: the database down then back loses nothing", async () => {
  const written: string[] = [];
  let down = true;
  const store = { writeEvents: async (rows: EventRow[]) => {
    if (down) throw Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" });
    written.push(...rows.map((r) => r.id));
  } } as unknown as Store;
  const buf = new WriteBuffer(store, { batch: 3 });
  buf.push([row("1"), row("2"), row("3"), row("4"), row("5")]);
  await buf.flush();
  assert.equal(buf.size, 5);
  down = false;
  const left = await buf.close(5000);
  assert.equal(left, 0);
  assert.deepEqual(written, ["1", "2", "3", "4", "5"]);
});

test("buffer: a bad row is dropped alone", async () => {
  const written: string[] = [];
  const store = { writeEvents: async (rows: EventRow[]) => {
    if (rows.some((r) => r.id === "bad")) throw Object.assign(new Error("invalid input"), { code: "22P02" });
    written.push(...rows.map((r) => r.id));
  } } as unknown as Store;
  const buf = new WriteBuffer(store, { batch: 10 });
  buf.push(["1", "2", "bad", "4", "5"].map((id) => row(id)));
  await buf.flush();
  assert.deepEqual(written.sort(), ["1", "2", "4", "5"]);
  assert.equal(buf.dropped, 1);
  assert.equal(buf.size, 0);
});

test("buffer: shutdown during a slow write waits for it and writes the rest", async () => {
  const written: string[] = [];
  const store = { writeEvents: async (rows: EventRow[]) => {
    await new Promise((r) => setTimeout(r, 100));
    written.push(...rows.map((r) => r.id));
  } } as unknown as Store;
  const buf = new WriteBuffer(store, { batch: 2 });
  buf.push([row("1"), row("2")]);
  const first = buf.flush();
  buf.push([row("3")]);
  const left = await buf.close(5000);
  await first;
  assert.equal(left, 0);
  assert.deepEqual(written, ["1", "2", "3"]);
});

test("buffer: full means backpressure", () => {
  const buf = new WriteBuffer({ writeEvents: async () => new Promise(() => {}) } as unknown as Store, { limit: 3, batch: 100 });
  buf.push([row("1"), row("2")]);
  assert.ok(!buf.full);
  buf.push([row("3")]);
  assert.ok(buf.full);
});

// Routes -----------------------------------------------------------------------------------------------------

class FakeStore implements Store {
  site: Site = {
    id: "11111111-1111-4111-8111-111111111111",
    workspace_id: "22222222-2222-4222-8222-222222222222",
    domain: "acme.com",
    extra_domains: ["acme.io"],
    proxy_secret: "proxysecret",
    policy_overrides: {},
    private_paths: ["/account"],
    url_param_allow: ["utm_source", "utm_medium", "utm_campaign", "q"],
    city_level: true,
    honor_dnt: false,
    paused: false,
  };
  key = "a".repeat(32);
  sessions: SessionRow[] = [];
  devices: string[] = [];
  events: EventRow[] = [];
  evidence: EvidenceRow[] = [];
  jobs: { kind: string; key: string }[] = [];
  nonces = new Set<string>();
  opted = new Set<string>();
  bots = new Map<string, boolean>();
  async siteByKey(k: string) {
    return k === this.key ? this.site : null;
  }
  async priorSession(_site: string, by: { deviceId?: string; ckey?: Buffer }) {
    const s = [...this.sessions].reverse().find((x) => (by.deviceId ? x.device_id === by.deviceId : x.cookieless_key?.equals(by.ckey!)));
    return s ? { id: s.id, startedAt: +s.started_at, endedAt: +s.ended_at, campaign: s.campaign, pageviews: 0 } : null;
  }
  async isOptedOut(_s: string, d: string) {
    return this.opted.has(d);
  }
  async startSession(s: SessionRow, device: { id: string } | null) {
    this.sessions.push(s);
    if (device) this.devices.push(device.id);
  }
  async writeEvents(rows: EventRow[]) {
    for (const r of rows) if (!this.events.some((e) => e.id === r.id)) this.events.push(r);
  }
  async setBot(id: string, b: boolean) {
    this.bots.set(id, b);
  }
  async touchSite() {}
  async useNonce(n: Buffer) {
    const k = n.toString("hex");
    if (this.nonces.has(k)) return false;
    this.nonces.add(k);
    return true;
  }
  async salt() {
    return Buffer.alloc(32, 7);
  }
  async optOut(_site: Site, d: string | null) {
    if (d) this.opted.add(d);
  }
  async addEvidence(e: EvidenceRow) {
    this.evidence.push(e);
  }
  async enqueue(_w: string, kind: string, key: string) {
    this.jobs.push({ kind, key });
  }
  async ping() {}
}

const US: Geo = { country: "US", subdivision: "NY", city: "New York", asn: 7922 };
const DE: Geo = { country: "DE", subdivision: "", city: "Berlin", asn: 3320 };

function setup(geo: Geo = US) {
  const store = new FakeStore();
  const { app, buffer } = createApp({ store, secret: SECRET, geo: () => geo });
  const send = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
    const res = await app.request(path, {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
      headers: { origin: "https://www.acme.com", "user-agent": CHROME, "fly-client-ip": "203.0.113.9", "content-type": "text/plain", ...headers },
    });
    const text = await res.text();
    return { res, status: res.status, json: text ? JSON.parse(text) : null, cookies: res.headers.getSetCookie() };
  };
  const ev = (k: string, extra: Record<string, unknown> = {}) => ({ id: uuid7(), k, t: Date.now(), u: "/pricing", ...extra });
  const batch = (events: unknown[], extra: Record<string, unknown> = {}) => ({ v: 1, site: store.key, m: "a", consent: { state: "unknown", tool: "none" }, gpc: false, events, ...extra });
  return { store, app, buffer, send, ev, batch };
}

test("route checks: size, shape, site, origin", async () => {
  const { send, batch, ev } = setup();
  assert.equal((await send("/e", "x".repeat(70_000))).status, 413);
  assert.equal((await send("/e", "not json")).status, 400);
  assert.equal((await send("/e", { v: 2 })).status, 400);
  assert.equal((await send("/e", { ...batch([ev("view")]), site: "b".repeat(32) })).status, 403);
  assert.equal((await send("/e", batch([ev("view")]), { origin: "https://evil.com" })).status, 403);
  assert.equal((await send("/e", batch([ev("view")]), { origin: "https://notacme.com" })).status, 403);
  assert.equal((await send("/e", batch([ev("view")]), { origin: "https://app.acme.io" })).status, 200, "extra domain");
  assert.equal((await send("/e", batch([]))).status, 400);
});

test("notice region: device cookie, session, scrubbed events, CORS", async () => {
  const { send, batch, ev, store, buffer } = setup(US);
  const r = await send("/e", batch([ev("view", { u: "/pricing?utm_source=g&utm_campaign=q4&email=jane@acme.com&secret=1", ti: "Pricing", r: "https://www.google.com/" }), ev("click", { d: { text: "Mail jane@acme.com", href: "/demo", out: false } })]), { "x-clr-proxy": "proxysecret", "x-clr-client-ip": "203.0.113.9" });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { p: "full" });
  assert.equal(r.res.headers.get("access-control-allow-origin"), "https://www.acme.com");
  const ck = r.cookies.find((c) => c.startsWith("_clr_id="))!;
  assert.match(ck, /HttpOnly/);
  assert.match(ck, /Domain=acme\.com/);
  assert.match(ck, /Max-Age=3421\d{4}/);
  const s = store.sessions[0];
  assert.equal(s.policy, "notice");
  assert.equal(s.ref_class, "search");
  assert.equal(s.campaign, "q4");
  assert.equal(s.ip_net, "203.0.113.0/24");
  assert.equal(s.country, "US");
  assert.equal(s.landing_path, "/pricing?utm_source=g&utm_campaign=q4");
  await buffer.flush();
  assert.deepEqual(store.events.map((e) => [e.kind, e.path]), [["view", "/pricing?utm_source=g&utm_campaign=q4"], ["click", "/pricing"]]);
  assert.equal((store.events[1].data as { text: string }).text, "Mail [removed]");
  assert.deepEqual(store.jobs.map((j) => j.kind), ["ip_lookup"]);
  assert.ok(!JSON.stringify(store).includes("203.0.113.9"), "full IP never stored");
});

test("the cookie brings the same device back; a second batch in the visit reuses the session", async () => {
  const { send, batch, ev, store } = setup(US);
  const first = await send("/e", batch([ev("view")]));
  const cookie = first.cookies[0].split(";")[0];
  const second = await send("/e", batch([ev("view", { u: "/demo" })]), { cookie });
  assert.equal(second.status, 200);
  assert.equal(second.cookies.length, 0, "no new cookie mid-visit");
  assert.equal(store.sessions.length, 1);
  assert.equal(store.devices.length, 1);
});

test("strict region without consent: cookieless, no cookie, no network, no lookup", async () => {
  const { send, batch, ev, store } = setup(DE);
  const r = await send("/e", batch([ev("view")]));
  assert.deepEqual(r.json, { p: "cookieless" });
  assert.equal(r.cookies.length, 0);
  const s = store.sessions[0];
  assert.equal(s.device_id, null);
  assert.ok(s.cookieless_key);
  assert.equal(s.ip_net, null);
  assert.equal(s.policy, "cookieless");
  assert.equal(store.jobs.length, 0);
  assert.equal(store.devices.length, 0);
});

test("strict region with consent: full", async () => {
  const { send, batch, ev } = setup(DE);
  const r = await send("/e", batch([ev("view")], { consent: { state: "granted", tool: "gcm" } }));
  assert.deepEqual(r.json, { p: "full" });
  assert.equal(r.cookies.length, 1);
});

test("unknown country is strict", async () => {
  const { send, batch, ev } = setup({ country: "", subdivision: "", city: "", asn: null });
  assert.deepEqual((await send("/e", batch([ev("view")]))).json, { p: "cookieless" });
});

test("GPC: cookieless everywhere", async () => {
  const { send, batch, ev, store } = setup(US);
  const r = await send("/e", batch([ev("view")], { gpc: true, hutk: "abc" }));
  assert.deepEqual(r.json, { p: "cookieless" });
  assert.equal(r.cookies.length, 0);
  assert.equal(store.evidence.length, 0);
});

test("opt-out cookie and opted-out device: nothing", async () => {
  const { send, batch, ev, store } = setup(US);
  assert.deepEqual((await send("/e", batch([ev("view")]), { cookie: "_clr_opt=1" })).json, { p: "off" });
  assert.equal(store.sessions.length, 0);
  const r = await send("/e", batch([ev("view")]));
  const cookie = r.cookies[0].split(";")[0];
  const opt = await send("/opt", batch([]), { cookie });
  assert.deepEqual(opt.json, { p: "off" });
  assert.ok(opt.cookies.some((c) => c.startsWith("_clr_opt=1")));
  assert.ok(opt.cookies.some((c) => c.startsWith("_clr_id=;")));
  const after = await send("/e", batch([ev("view")]), { cookie });
  assert.deepEqual(after.json, { p: "off" });
});

test("bots are dropped; automation is marked", async () => {
  const { send, batch, ev, store } = setup(US);
  assert.deepEqual((await send("/e", batch([ev("view")]), { "user-agent": "Googlebot/2.1 (+http://www.google.com/bot.html)" })).json, { p: "off" });
  assert.equal(store.sessions.length, 0);
  await send("/e", batch([ev("view")], { wd: true }));
  assert.equal(store.sessions[0].is_bot, true);
});

test("cloud network is marked, then unmarked by real input", async () => {
  const { send, batch, ev, store } = setup({ ...US, asn: 8075 });
  const r = await send("/e", batch([ev("view")], { m: "s" }));
  const cookie = r.cookies[0].split(";")[0];
  assert.equal(store.sessions[0].is_bot, true);
  await send("/e", batch([ev("engage", { d: { active_s: 5, scroll: 50 } })], { m: "s", human: { pointer: 3, scroll: 2, keys: 0, first_input_ms: 900 } }), { cookie });
  assert.equal(store.bots.get(store.sessions[0].id), false);
});

test("proxy without its secret: the IP isn't trusted; with it, the forwarded IP is used", async () => {
  const { send, batch, ev, store } = setup(US);
  await send("/e", batch([ev("view")]), { "fly-client-ip": "54.1.2.3" });
  assert.equal(store.sessions[0].ip_net, null);
  assert.equal(store.sessions[0].ip_kind, "untrusted");
  await send("/e", batch([ev("view")]), { "fly-client-ip": "54.1.2.3", "x-clr-proxy": "proxysecret", "x-clr-client-ip": "198.51.100.20" });
  assert.equal(store.sessions[1].ip_net, "198.51.100.0/24");
  assert.equal(store.sessions[1].ip_kind, "proxy");
  await send("/e", batch([ev("view")]), { "fly-client-ip": "54.1.2.3", "x-clr-proxy": "wrong", "x-clr-client-ip": "198.51.100.20" });
  assert.equal(store.sessions[2].ip_net, null, "a wrong secret is ignored");
});

test("direct mode returns the id instead of a cookie, and takes it back", async () => {
  const { send, batch, ev, store } = setup(US);
  const r = await send("/e", batch([ev("view")], { m: "d" }));
  assert.equal(r.cookies.length, 0);
  assert.match(r.json.did, /^v1\./);
  const again = await send("/e", batch([ev("view")], { m: "d", did: r.json.did }));
  assert.equal(again.json.did, undefined);
  assert.equal(store.devices.length, 1);
  const forged = await send("/e", batch([ev("view")], { m: "d", did: r.json.did.slice(0, -2) + "zz" }));
  assert.match(forged.json.did, /^v1\./, "a forged id gets a new device");
});

test("private paths and bad events are dropped; retried batches land once", async () => {
  const { send, batch, ev, store, buffer } = setup(US);
  const good = ev("view");
  const b = batch([good, ev("view", { u: "/account/billing" }), { id: "nope", k: "view", u: "/" }, ev("weird"), ev("track", { n: "Signup", d: { plan: "pro", password: "x", email: "a@b.co" } })]);
  await send("/e", b);
  const cookie = (await send("/e", b)).cookies[0];
  void cookie;
  await buffer.flush();
  assert.deepEqual(store.events.map((e) => e.kind).sort(), ["custom", "view"]);
  assert.deepEqual(store.events.find((e) => e.kind === "custom")!.data, { name: "Signup", props: { plan: "pro" } });
});

test("backpressure answers 503", async () => {
  const store = new FakeStore();
  const buffer = new WriteBuffer({ writeEvents: () => new Promise(() => {}) } as unknown as Store, { limit: 1, batch: 1000 });
  const { app } = createApp({ store, secret: SECRET, geo: () => US, buffer });
  buffer.push([row("1")]);
  const res = await app.request("/e", { method: "POST", body: "{}", headers: { origin: "https://acme.com" } });
  assert.equal(res.status, 503);
  assert.equal(res.headers.get("retry-after"), "5");
});

test("rate limit per IP", async () => {
  const { send, batch, ev } = setup(US);
  let limited = 0;
  for (let i = 0; i < 120; i++) if ((await send("/e", batch([ev("view")]))).status === 429) limited++;
  assert.ok(limited > 0);
});

test("identity: forms and identify become evidence and a stitch job, only with full policy", async () => {
  const { send, batch, ev, store } = setup(US);
  const r = await send("/e", batch([ev("view")]));
  const cookie = r.cookies[0].split(";")[0];
  const form = await send("/i", { ...batch([]), kind: "form", source: "native", email: " Jane@Acme.com ", page: "/demo?email=jane@acme.com", form: "demo" }, { cookie });
  assert.deepEqual(form.json, { p: "full" });
  const e = store.evidence[0];
  assert.deepEqual(e.identifiers, [{ kind: "email", value: "jane@acme.com" }]);
  assert.equal(e.source, "form");
  assert.equal(e.level, "asserted");
  assert.equal(e.extra.page, "/demo");
  assert.ok(store.jobs.some((j) => j.kind === "stitch" && j.key === e.device_id));
  await send("/i", { ...batch([]), kind: "identify", userId: "u_88", email: "jane@acme.com", iat: 1760000000, token: "tok" }, { cookie });
  assert.deepEqual(store.evidence[1].identifiers.map((i) => i.kind), ["email", "user"]);
  assert.equal(store.evidence[1].extra.unsigned, false);
  assert.equal((await send("/i", { ...batch([]), kind: "form", email: "not-an-email" }, { cookie })).status, 400);
  const before = store.evidence.length;
  await send("/i", { ...batch([]), kind: "form", email: "jane@acme.com" }, { cookie: "" });
  assert.equal(store.evidence.length, before, "no device, no evidence");
  await send("/i", { ...batch([], { gpc: true }), kind: "form", email: "jane@acme.com" }, { cookie });
  assert.equal(store.evidence.length, before, "GPC, no evidence");
});

test("hutk rides the batch as evidence", async () => {
  const { send, batch, ev, store } = setup(US);
  await send("/e", batch([ev("view")], { hutk: "abc123" }));
  assert.deepEqual(store.evidence[0].identifiers, [{ kind: "hubspot", value: "abc123" }]);
  assert.equal(store.evidence[0].source, "hutk");
});

test("hop: a token moves the device to the other domain once", async () => {
  const { app, send, batch, ev, store } = setup(US);
  const r = await send("/e", batch([ev("view")]));
  const cookie = r.cookies[0].split(";")[0];
  const x = await app.request(`/x?site=${store.key}`, { headers: { origin: "https://www.acme.com", cookie } });
  const { t } = (await x.json()) as { t: string };
  assert.ok(t);
  const landed = await send("/e", batch([ev("view")], { hop: t }), { origin: "https://acme.io" });
  assert.match(landed.cookies[0], /Domain=acme\.io/);
  assert.equal(landed.cookies[0].split(";")[0], cookie, "same device, signed for the same site");
  assert.equal(store.sessions.length, 1, "the visit goes on across domains");
  await send("/e", batch([ev("view")], { hop: t }), { origin: "https://acme.io" });
  assert.equal(store.sessions.length, 2);
  assert.notEqual(store.sessions[1].device_id, store.sessions[0].device_id, "a used token gives a new device");
  const none = await app.request(`/x?site=${store.key}`, { headers: { origin: "https://www.acme.com" } });
  assert.deepEqual(await none.json(), { t: "" });
});

test("reset gives a new device", async () => {
  const { send, batch, ev, store } = setup(US);
  const r = await send("/e", batch([ev("view")]));
  const cookie = r.cookies[0].split(";")[0];
  const reset = await send("/reset", batch([]), { cookie });
  const next = reset.cookies[0].split(";")[0];
  assert.notEqual(next, cookie);
  assert.ok(store.jobs.some((j) => j.kind === "device_reset"));
});

test("paused site stops the script", async () => {
  const { send, batch, ev, store } = setup(US);
  store.site.paused = true;
  assert.deepEqual((await send("/e", batch([ev("view")]))).json, { p: "off" });
});
