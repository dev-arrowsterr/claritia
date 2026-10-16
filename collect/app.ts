// claritia-collect routes (docs/m1-website-intelligence.md 5.2–5.4). Order for every request: size, shape, site,
// origin, client IP, rate limits, geo, policy, device, bots, session, scrub, buffer, reply.

import { timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import { getCookie } from "hono/cookie";
import { decide, regionOf, type ConsentState, type Decision } from "../src/lib/web/policy.ts";
import { ipKey, sealIp } from "../src/lib/company/ipinfo.ts";
import { attribute } from "./attribution.ts";
import { botVerdict, looksAutomated } from "./bots.ts";
import { WriteBuffer } from "./buffer.ts";
import { cleanIp, ipNet, NO_GEO, type GeoLookup } from "./geo.ts";
import { cookielessKey, deviceBornAt, hopKey, makeHop, readHop, signDevice, siteKey, uuid7, verifyDevice } from "./ids.ts";
import { Buckets } from "./limits.ts";
import { pathMatches, scrubProps, scrubText, scrubUrl } from "./scrub.ts";
import { Sessions, type Live } from "./sessions.ts";
import type { EventRow, Site, Store } from "./store.ts";
import { parseAgent } from "./ua.ts";

export const MAX_BODY = 64 * 1024;
const SITE_TTL_MS = 60_000;
const DEVICE_LIFE_MS = 396 * 86400_000; // 13 months
const OPT_LIFE_S = 5 * 365 * 86400;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KINDS: Record<string, string> = { view: "view", engage: "engage", click: "click", track: "custom" };

export type Deps = {
  store: Store;
  geo?: GeoLookup;
  /** CLR_ID_SECRET */
  secret: string;
  /** CLR_IP_SECRET, also set on intel. Without it there are no company matches by IP. */
  ipSecret?: string;
  script?: { code: string; tag: string };
  now?: () => number;
  /** Hosts allowed as origins for every site (local testing only). */
  devOrigins?: string[];
  log?: (msg: string, extra?: Record<string, unknown>) => void;
  buffer?: WriteBuffer;
};

type Mode = "a" | "s" | "d";
type Batch = {
  v?: number;
  site?: string;
  m?: string;
  did?: unknown;
  consent?: { state?: string; tool?: string };
  gpc?: boolean;
  wd?: boolean;
  hutk?: unknown;
  clr?: unknown;
  hop?: unknown;
  human?: Record<string, unknown>;
  events?: unknown[];
};

export function createApp(deps: Deps) {
  const { store, secret } = deps;
  const geo = deps.geo ?? (() => NO_GEO);
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});
  const buffer = deps.buffer ?? new WriteBuffer(store, { log });
  const sessions = new Sessions();
  const perIp = new Buckets(50, 100);
  const perSite = new Buckets(2000, 4000);
  const siteCache = new Map<string, { site: Site | null; at: number }>();
  // IPs queued for a company lookup in the last hour, by their HMAC (never the address).
  const seenIps = new Map<string, number>();
  const touched = new Map<string, number>();
  const salts = new Map<string, Buffer>();
  const app = new Hono();

  // Helpers --------------------------------------------------------------------------------------------

  const getSite = async (key: unknown): Promise<Site | null> => {
    if (typeof key !== "string" || !/^[0-9a-f]{32}$/.test(key)) return null;
    const hit = siteCache.get(key);
    if (hit && now() - hit.at < SITE_TTL_MS) return hit.site;
    const site = await store.siteByKey(key);
    if (siteCache.size > 10_000) siteCache.clear();
    siteCache.set(key, { site, at: now() });
    return site;
  };

  /** The site domain the request's page is on, or null when the origin isn't one of the site's. */
  const originDomain = (c: Context, site: Site): string | null => {
    const raw = c.req.header("origin") || c.req.header("referer") || "";
    let host = "";
    try {
      host = new URL(raw).hostname.toLowerCase();
    } catch {
      return null;
    }
    if (deps.devOrigins?.includes(host)) return host;
    return [site.domain, ...site.extra_domains].find((d) => host === d || host.endsWith("." + d)) ?? null;
  };

  const cors = (c: Context) => {
    const o = c.req.header("origin");
    if (o) {
      c.header("Access-Control-Allow-Origin", o);
      c.header("Access-Control-Allow-Credentials", "true");
      c.header("Vary", "Origin");
    }
  };

  /** The visitor's IP. The proxy's forwarded IP counts only with the site's proxy secret. */
  const clientIp = (c: Context, site: Site, mode: Mode): { ip: string; trusted: boolean; viaProxy: boolean } => {
    const given = c.req.header("x-clr-proxy");
    if (given && safeEqual(given, site.proxy_secret)) {
      const ip = cleanIp(c.req.header("x-clr-client-ip"));
      if (ip) return { ip, trusted: true, viaProxy: true };
    }
    const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
    const ip = cleanIp(c.req.header("fly-client-ip") || env?.incoming?.socket?.remoteAddress);
    // Same-origin requests came through the customer's proxy; without the secret the IP is the proxy's own.
    return { ip, trusted: mode !== "a", viaProxy: false };
  };

  const readBody = async (c: Context): Promise<Batch | null | "too_big"> => {
    const len = Number(c.req.header("content-length") || 0);
    if (len > MAX_BODY) return "too_big";
    const text = await c.req.text();
    if (text.length > MAX_BODY) return "too_big";
    try {
      const b = JSON.parse(text);
      return b && typeof b === "object" && !Array.isArray(b) ? b : null;
    } catch {
      return null;
    }
  };

  const consentOf = (b: Batch): ConsentState => {
    const s = b.consent?.state;
    return s === "granted" || s === "denied" ? s : "unknown";
  };

  const today = () => new Date(now()).toISOString().slice(0, 10);
  const saltFor = async (day: string) => {
    let s = salts.get(day);
    if (!s) {
      s = await store.salt(day);
      salts.clear();
      salts.set(day, s);
    }
    return s;
  };

  const deviceCookie = (c: Context, domain: string, value: string, maxAgeS: number) => {
    const secure = new URL(c.req.url).protocol === "https:" || c.req.header("x-forwarded-proto") === "https";
    const parts = [`_clr_id=${value}`, `Max-Age=${Math.max(0, Math.floor(maxAgeS))}`, "Path=/", "SameSite=Lax", "HttpOnly"];
    if (!deps.devOrigins?.includes(domain)) parts.push(`Domain=${domain}`);
    if (secure) parts.push("Secure");
    c.header("Set-Cookie", parts.join("; "), { append: true });
  };

  /** The visit's device: from the cookie (modes a and s) or the body (mode d, or s with a stored copy). */
  const readDevice = (c: Context, site: Site, mode: Mode, did: unknown): string | null => {
    const key = siteKey(secret, site.id);
    const fromCookie = mode !== "d" ? verifyDevice(key, getCookie(c, "_clr_id")) : null;
    const uuid = fromCookie ?? (mode !== "a" ? verifyDevice(key, did) : null);
    if (!uuid || now() - deviceBornAt(uuid) > DEVICE_LIFE_MS) return null;
    return uuid;
  };

  type Ctx = {
    site: Site;
    domain: string;
    mode: Mode;
    ip: string;
    trusted: boolean;
    viaProxy: boolean;
    decision: Decision;
    geo: ReturnType<GeoLookup>;
  };

  /** Steps 1–6 shared by every POST. Returns a response to send, or the context. */
  const intake = async (c: Context): Promise<Response | { b: Batch; x: Ctx }> => {
    const b = await readBody(c);
    if (b === "too_big") return c.body(null, 413);
    if (!b || b.v !== 1) return c.body(null, 400);
    const site = await getSite(b.site);
    if (!site) return c.body(null, 403);
    const domain = originDomain(c, site);
    if (!domain) return c.body(null, 403);
    cors(c);
    const mode: Mode = b.m === "a" || b.m === "s" ? b.m : "d";
    const { ip, trusted, viaProxy } = clientIp(c, site, mode);
    if ((ip && !perIp.take(ip, now())) || !perSite.take(site.id, now())) return c.body(null, 429);
    if (site.paused) return c.json({ p: "off" });
    const g = ip ? geo(ip) : NO_GEO;
    const decision = decide({
      region: regionOf(g.country, g.subdivision, site.policy_overrides),
      consent: consentOf(b),
      gpc: b.gpc === true,
      optedOut: getCookie(c, "_clr_opt") === "1",
      dnt: c.req.header("dnt") === "1",
      honorDnt: site.honor_dnt,
    });
    return { b, x: { site, domain, mode, ip, trusted, viaProxy, decision, geo: g } };
  };

  // Routes ----------------------------------------------------------------------------------------------

  app.options("*", (c) => {
    cors(c);
    c.header("Access-Control-Allow-Methods", "GET, POST");
    c.header("Access-Control-Allow-Headers", "content-type");
    c.header("Access-Control-Max-Age", "86400");
    return c.body(null, 204);
  });

  app.get("/health", async (c) => c.json({ ok: true, buffered: buffer.size, sessions: sessions.size }));

  app.get("/s.js", (c) => script(c, false));
  app.get("/s.:tag{[0-9a-f]{10}}.js", (c) => script(c, true));
  const script = (c: Context, versioned: boolean) => {
    if (!deps.script) return c.body(null, 404);
    c.header("Content-Type", "text/javascript; charset=utf-8");
    c.header("Cache-Control", versioned ? "public, max-age=31536000, immutable" : "public, max-age=3600");
    return c.body(deps.script.code);
  };

  app.post("/e", async (c) => {
    if (buffer.full) {
      c.header("Retry-After", "5");
      return c.body(null, 503);
    }
    const r = await intake(c);
    if (r instanceof Response) return r;
    const { b, x } = r;
    const { site, decision } = x;
    if (decision.mode === "off") return c.json({ p: "off" });
    const events = Array.isArray(b.events) ? b.events.slice(0, 50) : [];
    if (!events.length) return c.body(null, 400);

    const ua = (c.req.header("user-agent") || "").slice(0, 400);
    const verdict = botVerdict({ ua, asn: x.geo.asn, ipTrusted: x.trusted, webdriver: b.wd === true });
    if (verdict === "drop") return c.json({ p: "off" });

    const t = now();
    const full = decision.mode === "full";
    let device: string | null = null;
    let madeDevice = false;
    let ckey: Buffer | null = null;
    if (full) {
      device = readDevice(c, site, x.mode, b.did);
      if (!device && b.hop) {
        const hop = readHop(hopKey(secret, site.workspace_id), b.hop, t);
        if (hop && (await store.useNonce(hop.nonce))) {
          device = hop.uuid;
          madeDevice = true;
        }
      }
      if (!device) {
        device = uuid7(t);
        madeDevice = true;
      }
    } else {
      ckey = cookielessKey(await saltFor(today()), site.id, x.ip ? (ipNet(x.ip) ?? "") : "", ua, (c.req.header("accept-language") || "").slice(0, 100));
    }

    const firstView = events.find((e) => (e as { k?: string })?.k === "view") as { u?: unknown; r?: unknown } | undefined;
    let landing: URL | null = null;
    try {
      landing = typeof firstView?.u === "string" ? new URL(firstView.u, `https://${x.domain}`) : null;
    } catch {}
    const campaign = landing?.searchParams.get("utm_campaign")?.slice(0, 200) || null;
    const key = device ?? "c:" + ckey!.toString("hex");

    if (device && !madeDevice && (await store.isOptedOut(site.id, device))) return c.json({ p: "off" });

    const { s, fresh } = await sessions.current(
      key,
      t,
      campaign,
      () => store.priorSession(site.id, device ? { deviceId: device } : { ckey: ckey! }),
      async () => {
        const id = uuid7(t);
        const a = attribute(landing, typeof firstView?.r === "string" ? firstView.r : null, [site.domain, ...site.extra_domains]);
        const agent = parseAgent(ua, c.req.header("sec-ch-ua-mobile"));
        const keepNet = x.ip && x.trusted && decision.lookup;
        const marked = verdict === "mark" || verdict === "hosting";
        await store.startSession(
          {
            id,
            workspace_id: site.workspace_id,
            site_id: site.id,
            device_id: device,
            cookieless_key: ckey,
            started_at: new Date(t),
            ended_at: new Date(t),
            policy: decision.label,
            consent: consentOf(b),
            gpc: b.gpc === true,
            country: x.geo.country || null,
            region: x.geo.subdivision || null,
            city: site.city_level && x.geo.city ? x.geo.city : null,
            device_type: agent.device_type,
            browser: agent.browser,
            os: agent.os,
            landing_path: landing ? scrubUrl(landing.toString(), { allow: site.url_param_allow }) || null : null,
            referrer_host: a.referrer_host,
            source: a.source && scrubText(a.source),
            medium: a.medium && scrubText(a.medium),
            campaign: a.campaign && scrubText(a.campaign),
            term: a.term && scrubText(a.term),
            content: a.content && scrubText(a.content),
            ref_class: a.ref_class,
            ip_net: keepNet ? ipNet(x.ip) : null,
            ip_kind: !x.ip ? null : x.viaProxy ? "proxy" : x.trusted ? "direct" : "untrusted",
            is_bot: marked,
          },
          device ? { id: device, consent: consentOf(b) } : null,
          keepNet && deps.ipSecret ? ipKey(x.ip, deps.ipSecret) : null,
        );
        return { id, startedAt: t, lastAt: t, campaign, pageviews: 0, inputs: 0, bot: marked, hosting: verdict === "hosting" };
      },
    );

    const rows = toRows(events, s.id, site, x.domain, t);
    buffer.push(rows);
    await afterEvents(s, rows, b, verdict, t);

    if (full && device) await identityBits(b, site, device, s.id);
    // Company match by the visitor's own IP: full visits, and GPC visits in notice regions (company stats only, no
    // person). The IP goes to intel encrypted and is erased from the job once looked up (docs/m1-website-intelligence.md 7.1).
    const net = x.ip && x.trusted && decision.lookup && deps.ipSecret ? ipNet(x.ip) : null;
    const seen = net ? ipKey(x.ip, deps.ipSecret!).toString("base64url") : "";
    if (net && (seenIps.get(seen) ?? 0) < t - 3600_000) {
      seenIps.set(seen, t);
      if (seenIps.size > 200_000) seenIps.clear();
      await store
        .enqueue(site.workspace_id, "ip_lookup", seen, { net, ip: sealIp(x.ip, deps.ipSecret!), site_id: site.id, session_id: s.id })
        .catch((e) => log("enqueue failed", { e: String(e) }));
    }
    if ((touched.get(site.id) ?? 0) < t - 60_000) {
      touched.set(site.id, t);
      void store.touchSite(site.id, x.mode === "a" ? "proxy" : x.mode === "s" ? "cname" : "direct").catch(() => {});
    }

    const out: Record<string, string> = { p: decision.mode };
    // Consent withdrawn or GPC turned on: the device cookie goes (docs/identity.md 4.5).
    if (!full && x.mode !== "d" && getCookie(c, "_clr_id")) {
      const domain = matchDomain(site, x.domain);
      const dom = deps.devOrigins?.includes(domain) ? "" : `; Domain=${domain}`;
      c.header("Set-Cookie", `_clr_id=; Max-Age=0; Path=/; SameSite=Lax; HttpOnly${dom}`, { append: true });
    }
    if (full && device) {
      const signed = signDevice(siteKey(secret, site.id), device);
      if (x.mode === "d") {
        if (madeDevice) out.did = signed;
      } else if (madeDevice || fresh) {
        deviceCookie(c, matchDomain(site, x.domain), signed, (deviceBornAt(device) + DEVICE_LIFE_MS - t) / 1000);
      }
    }
    return c.json(out);
  });

  /** Browser events to rows: kind map, scrub, private paths, sizes. */
  const toRows = (events: unknown[], sessionId: string, site: Site, domain: string, t: number): EventRow[] => {
    const rows: EventRow[] = [];
    for (const raw of events) {
      const e = raw as { id?: unknown; k?: unknown; t?: unknown; u?: unknown; ti?: unknown; n?: unknown; d?: unknown };
      const kind = typeof e.k === "string" ? KINDS[e.k] : undefined;
      if (!kind || typeof e.id !== "string" || !UUID.test(e.id) || typeof e.u !== "string") continue;
      const path = scrubUrl(e.u, { base: `https://${domain}`, allow: site.url_param_allow });
      if (!path || pathMatches(path.split("?")[0], site.private_paths)) continue;
      const clientAt = typeof e.t === "number" && Math.abs(e.t - t) < 86400_000 ? new Date(e.t) : null;
      rows.push({
        id: e.id.toLowerCase(),
        workspace_id: site.workspace_id,
        session_id: sessionId,
        day: eventDay(e.id, t),
        kind,
        path,
        title: kind === "view" && typeof e.ti === "string" ? scrubText(e.ti).slice(0, 300) : null,
        data: eventData(kind, e),
        client_at: clientAt,
      });
    }
    return rows;
  };

  const afterEvents = async (s: Live, rows: EventRow[], b: Batch, verdict: string, t: number) => {
    s.pageviews += rows.filter((r) => r.kind === "view").length;
    const h = b.human;
    if (h && typeof h === "object") {
      const n = ["pointer", "scroll", "keys"].reduce((sum, k) => sum + (typeof h[k] === "number" ? Math.max(0, Math.min(9999, h[k] as number)) : 0), 0);
      s.inputs += n;
      // A cloud network with real input is a person on a cloud desktop.
      if (n > 0 && s.bot && s.hosting && verdict !== "mark") {
        s.bot = false;
        await store.setBot(s.id, false).catch(() => {});
      }
    }
    if (!s.bot && looksAutomated(s, t)) {
      s.bot = true;
      await store.setBot(s.id, true).catch(() => {});
    }
  };

  /** hubspotutk and email-link tokens in the batch become evidence for the stitch job. */
  const identityBits = async (b: Batch, site: Site, device: string, sessionId: string) => {
    const add = async (source: string, level: "asserted" | "inferred", kind: string, value: unknown) => {
      if (typeof value !== "string" || !value || value.length > 512) return;
      const id = uuid7(now());
      await store.addEvidence({ id, workspace_id: site.workspace_id, site_id: site.id, device_id: device, session_id: sessionId, source, level, identifiers: [{ kind, value }], extra: {}, server_at: new Date(now()) });
      await store.enqueue(site.workspace_id, "stitch", device, { device_id: device });
    };
    await add("hutk", "asserted", "hubspot", b.hutk);
    await add("email_link", "inferred", "email_token", b.clr);
  };

  app.post("/i", async (c) => {
    const r = await intake(c);
    if (r instanceof Response) return r;
    const { b, x } = r;
    const body = b as Batch & { kind?: unknown; source?: unknown; email?: unknown; userId?: unknown; iat?: unknown; token?: unknown; page?: unknown; form?: unknown };
    if (x.decision.mode !== "full") return c.json({ p: x.decision.mode });
    const device = readDevice(c, x.site, x.mode, b.did);
    if (!device || (await store.isOptedOut(x.site.id, device))) return c.json({ p: x.decision.mode });

    const kind = body.kind === "identify" ? "identify" : body.kind === "form" || body.kind === "adapter" ? "form" : null;
    const src = body.source === "hubspot" || body.source === "marketo" ? body.source : "native";
    const email = typeof body.email === "string" && body.email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email.trim()) ? body.email.trim().toLowerCase() : null;
    const userId = typeof body.userId === "string" && body.userId.trim() && body.userId.length <= 200 ? body.userId.trim() : null;
    if (!kind || (!email && !userId) || (kind === "form" && !email)) return c.body(null, 400);

    const ids: { kind: string; value: string }[] = [];
    if (email) ids.push({ kind: "email", value: email });
    if (userId) ids.push({ kind: "user", value: userId });
    const page = typeof body.page === "string" ? scrubUrl(body.page, { base: `https://${x.domain}`, allow: x.site.url_param_allow }) : "";
    if (page && pathMatches(page.split("?")[0], x.site.private_paths)) return c.json({ p: "full" });
    const token = typeof body.token === "string" ? body.token.slice(0, 200) : null;
    const prior = await store.priorSession(x.site.id, { deviceId: device });
    const id = uuid7(now());
    await store.addEvidence({
      server_at: new Date(now()),
      id,
      workspace_id: x.site.workspace_id,
      site_id: x.site.id,
      device_id: device,
      session_id: prior?.id ?? null,
      source: kind,
      level: "asserted",
      identifiers: ids,
      extra: {
        page,
        form: typeof body.form === "string" ? scrubText(body.form).slice(0, 100) : "",
        ...(src !== "native" ? { adapter: src } : {}),
        ...(kind === "identify" ? { iat: typeof body.iat === "number" ? body.iat : null, token, unsigned: !token } : {}),
      },
    });
    await store.enqueue(x.site.workspace_id, "stitch", device, { device_id: device });
    if (prior) {
      buffer.push([
        {
          id,
          workspace_id: x.site.workspace_id,
          session_id: prior.id,
          day: eventDay(id, now()),
          kind,
          path: page || null,
          title: null,
          data: kind === "form" ? { form: typeof body.form === "string" ? scrubText(body.form).slice(0, 100) : "", ...(src !== "native" ? { adapter: src } : {}) } : null,
          client_at: null,
        },
      ]);
    }
    return c.json({ p: "full" });
  });

  app.get("/x", async (c) => {
    c.header("Cache-Control", "no-store");
    const site = await getSite(c.req.query("site"));
    if (!site || !originDomain(c, site)) return c.body(null, 403);
    cors(c);
    const did = c.req.query("did");
    const device = readDevice(c, site, did ? "s" : "a", did);
    return c.json({ t: device ? makeHop(hopKey(secret, site.workspace_id), device, now()) : "" });
  });

  app.post("/reset", async (c) => {
    const r = await intake(c);
    if (r instanceof Response) return r;
    const { b, x } = r;
    const old = readDevice(c, x.site, x.mode, b.did);
    if (old) {
      sessions.forget(old);
      await store.enqueue(x.site.workspace_id, "device_reset", old, { device_id: old, at: new Date(now()).toISOString() }).catch(() => {});
    }
    if (x.decision.mode !== "full") return c.json({ p: x.decision.mode });
    const fresh = uuid7(now());
    const signed = signDevice(siteKey(secret, x.site.id), fresh);
    if (x.mode === "d") return c.json({ p: "full", did: signed });
    deviceCookie(c, matchDomain(x.site, x.domain), signed, DEVICE_LIFE_MS / 1000);
    return c.json({ p: "full" });
  });

  app.post("/opt", async (c) => {
    const r = await intake(c);
    if (r instanceof Response) return r;
    const { b, x } = r;
    const device = readDevice(c, x.site, x.mode, b.did);
    await store.optOut(x.site, device);
    if (device) sessions.forget(device);
    const domain = matchDomain(x.site, x.domain);
    const dom = deps.devOrigins?.includes(domain) ? "" : `; Domain=${domain}`;
    c.header("Set-Cookie", `_clr_opt=1; Max-Age=${OPT_LIFE_S}; Path=/; SameSite=Lax; HttpOnly${dom}`, { append: true });
    c.header("Set-Cookie", `_clr_id=; Max-Age=0; Path=/; SameSite=Lax; HttpOnly${dom}`, { append: true });
    return c.json({ p: "off" });
  });

  return { app, buffer, sessions };
}

/** The registrable domain a cookie goes on: the site domain or extra domain the page is under. */
function matchDomain(site: Site, host: string): string {
  return [site.domain, ...site.extra_domains].find((d) => host === d || host.endsWith("." + d)) ?? host;
}

/** The event's day comes from its uuid v7 time, so a batch retried after midnight lands in the same table. */
export function eventDay(id: string, serverNow: number): string {
  const ms = parseInt(id.replace(/-/g, "").slice(0, 12), 16);
  const at = Number.isFinite(ms) && Math.abs(ms - serverNow) < 86400_000 ? ms : serverNow;
  return new Date(at).toISOString().slice(0, 10);
}

function eventData(kind: string, e: { n?: unknown; d?: unknown }): Record<string, unknown> | null {
  const d = e.d && typeof e.d === "object" && !Array.isArray(e.d) ? (e.d as Record<string, unknown>) : {};
  const num = (v: unknown, max: number) => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(max, Math.round(v))) : 0);
  const str = (v: unknown, max: number) => (typeof v === "string" ? scrubText(v).slice(0, max) : "");
  if (kind === "engage") return { active_s: num(d.active_s, 3600), scroll: num(d.scroll, 100) };
  if (kind === "click") {
    const href = typeof d.href === "string" && d.href ? scrubUrl(d.href, { base: "https://x.invalid", origin: d.out === true }) : "";
    return { text: str(d.text, 80), href: href.replace(/^https:\/\/x\.invalid/, ""), out: d.out === true };
  }
  if (kind === "custom") return { name: str(e.n, 64), props: scrubProps(d) ?? {} };
  return null;
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
