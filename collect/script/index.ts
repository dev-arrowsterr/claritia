// claritia.js: page views, engagement, clicks, consent, forms and identify (docs/m1-website-intelligence.md 5.1).
// The server decides the policy for each visit and answers every batch with it. Until it says "full", nothing that
// names a person leaves the browser and nothing is stored.
/* eslint-disable @typescript-eslint/no-explicit-any */

import { pathMatches, scrubProps, scrubText, scrubUrl } from "../scrub";
import { readConsent, watchConsent, type Consent } from "./consent";
import { watchForms } from "./forms";
import { watchHubspot } from "./adapters/hubspot";
import { watchMarketo } from "./adapters/marketo";
import { watchHops } from "./hop";
import { cookie, hash, ls, setCookie, ss, uuid7 } from "./util";

type Ev = { id: string; k: string; t: number; u: string; ti?: string; r?: string; n?: string; d?: object };
type Body = Record<string, unknown>;

const w = window as any;
const d = document;
const BATCH = 20;
const WAIT_MS = 5000;
const ACTIVE_MS = 15000;
const DEVICE_AGE_S = 34214400; // 13 months, never renewed past that
const BLOCKED_IDS = ["", "null", "undefined", "anonymous", "0", "none", "unknown"];

function main() {
  if (w.top !== w || w.__clr) return;
  const el = (d.currentScript || d.querySelector("script[data-site]")) as HTMLScriptElement | null;
  const site = el?.dataset.site || "";
  if (!el || !site) return;
  w.__clr = 1;

  const list = (s?: string) => (s || "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
  const base = (el.dataset.api || el.src.replace(/\/s(\.\w+)?\.js([?#].*)?$/, "")).replace(/\/$/, "");
  const api_ = new URL(base, location.href);
  // a: same origin (proxy path), s: same site (subdomain), d: direct to collect.
  const m = api_.origin === location.origin ? "a" : api_.hostname.endsWith("." + location.hostname.split(".").slice(-2).join(".")) ? "s" : "d";
  const cross = m !== "a";
  const mode = el.dataset.consent || "auto";
  const domains = list(el.dataset.domains);
  const priv = list(el.dataset.private);
  const gpc = (navigator as any).globalPrivacyControl === true;

  let off = !!(cookie("_clr_opt") || ls.get("_clr_opt"));
  let policy = ""; // "", "full", "cookieless" or "off", from the server
  let apiConsent: boolean | null = null;
  let q: Ev[] = [];
  let retry: Body[] = [];
  let held: [Body, boolean][] = [];
  let timer: ReturnType<typeof setTimeout> | 0 = 0;
  let sentOnce = false;
  let landing: Body | null = null;

  const consent = (): Consent => (mode === "on" ? { state: "granted", tool: "site" } : readConsent(w, apiConsent));
  const cookieless = () => gpc || policy === "cookieless" || consent().state === "denied";
  const identityOk = () => !off && !cookieless() && policy === "full";
  const waiting = () => mode === "wait" && consent().state === "unknown";
  const did = () => cookie("_clr_id") || ls.get("_clr_id");
  const head = (): Body => ({ v: 1, site, m, consent: consent(), gpc });

  // Sending ---------------------------------------------------------------------------------------------

  const post = (path: string, b: Body, beacon: boolean): Promise<any> => {
    const url = base + path;
    const data = JSON.stringify(b);
    if (beacon && navigator.sendBeacon && data.length < 60000 && navigator.sendBeacon(url, data)) return Promise.resolve(null);
    return fetch(url, { method: "POST", body: data, keepalive: data.length < 60000, credentials: "include" }).then((r) => {
      if (r.status === 429 || r.status >= 500) throw r.status;
      return r.status === 200 ? r.json().catch(() => null) : null;
    });
  };

  const saveRetry = () => {
    if (!identityOk()) return;
    if (retry.length) ss.set("_clr_q", JSON.stringify(retry));
    else ss.del("_clr_q");
  };

  const answer = (j: any) => {
    if (!j || typeof j !== "object") return;
    if (j.p === "off") {
      off = true;
      q = [];
      retry = [];
      held = [];
      return;
    }
    if (j.p) policy = j.p;
    if (policy === "cookieless" && did()) {
      ls.del("_clr_id");
      setCookie("_clr_id", "", 0);
    }
    if (j.did && cross && identityOk() && j.did !== did()) {
      ls.set("_clr_id", j.did);
      setCookie("_clr_id", j.did, DEVICE_AGE_S);
    }
    const h = held;
    held = [];
    if (policy === "full") h.forEach(([b, beacon]) => post("/i", b, beacon).catch(() => {}));
  };

  const body = (events: Ev[]): Body => {
    const b: Body = { ...head(), events };
    if (navigator.webdriver) b.wd = true;
    if (cross && !cookieless() && did()) b.did = did();
    if (landing && !gpc) Object.assign(b, landing);
    landing = null;
    if (identityOk() && !ss.get("_clr_h")) {
      const h = cookie("hubspotutk");
      if (h) {
        b.hutk = h;
        ss.set("_clr_h", "1");
      }
    }
    if (!human.sent && events.some((e) => e.k === "engage")) {
      human.sent = true;
      b.human = { pointer: human.pointer, scroll: human.scroll, keys: human.keys, first_input_ms: human.first };
    }
    return b;
  };

  // A batch that fails is tried once more, with the next batch. Event ids make a repeat land once.
  const send = (b: Body, beacon: boolean, last: boolean) =>
    post("/e", b, beacon).then(answer, () => {
      if (last || off) return;
      if (retry.length < 10) retry.push(b);
      saveRetry();
      if (!timer) timer = setTimeout(flush, WAIT_MS);
    });

  function flush(beacon = false) {
    clearTimeout(timer);
    timer = 0;
    if (off || waiting()) return;
    const again = retry;
    retry = [];
    saveRetry();
    again.forEach((b) => send(b, beacon, true));
    while (q.length) send(body(q.splice(0, BATCH)), beacon, false);
  }

  function push(k: string, u: string, extra: Partial<Ev> = {}) {
    if (off || q.length >= 200) return;
    q.push({ id: uuid7(), k, t: Date.now(), u, ...extra });
    // The first batch goes at once so the policy is known before anyone submits a form.
    if (!sentOnce || q.length >= BATCH) {
      sentOnce = true;
      flush();
    } else if (!timer) timer = setTimeout(flush, WAIT_MS);
  }

  /** Sends identity evidence once the server has said the policy allows it. */
  function ident(b: Body, beacon = false) {
    if (off || cookieless() || curPriv) return;
    const full: Body = { ...head(), page: cur, ...b };
    if (cross && did()) full.did = did();
    if (policy === "full") post("/i", full, beacon).catch(() => {});
    else if (!policy && held.length < 3) held.push([full, beacon]);
  }

  // Pages and engagement ------------------------------------------------------------------------------

  let cur = "";
  let curPriv = false;
  let firstView = true;
  let active = 0;
  let lastInput = 0;
  let depth = 0;
  const human = { pointer: 0, scroll: 0, keys: 0, first: 0, sent: false };

  const measure = () => {
    const h = d.documentElement;
    const pct = Math.min(100, Math.round(((w.scrollY + w.innerHeight) / Math.max(h.scrollHeight, 1)) * 100));
    if (pct > depth) depth = pct;
  };
  const input = (kind: "pointer" | "scroll" | "keys") => {
    lastInput = Date.now();
    if (human[kind] < 9999) human[kind]++;
    if (!human.first) human.first = Math.round(performance.now());
  };
  const engage = () => {
    if (cur && !curPriv && active > 0) push("engage", cur, { d: { active_s: active, scroll: depth } });
    active = 0;
  };

  function view(force = false) {
    const u = scrubUrl(location.href);
    if (!force && u === cur) return;
    engage();
    cur = u;
    curPriv = pathMatches(location.pathname, priv);
    depth = 0;
    measure();
    if (curPriv) return;
    const extra: Partial<Ev> = { ti: scrubText(d.title).slice(0, 200) };
    if (firstView && d.referrer) extra.r = scrubUrl(d.referrer, { origin: true });
    firstView = false;
    push("view", u, extra);
  }

  function start() {
    // Batches that failed on the last page.
    try {
      retry = JSON.parse(ss.get("_clr_q") || "[]");
    } catch {}
    ss.del("_clr_q");

    // Hop and email-link tokens ride on the first batch, then leave the address bar.
    const url = new URL(location.href);
    const hop = url.searchParams.get("_clr_x");
    const clr = url.searchParams.get("clr");
    if (hop || clr) {
      landing = {};
      if (hop) landing.hop = hop.slice(0, 512);
      if (clr) landing.clr = clr.slice(0, 512);
      url.searchParams.delete("_clr_x");
      url.searchParams.delete("clr");
      history.replaceState(history.state, "", url.toString());
    }

    for (const m of ["pushState", "replaceState"] as const) {
      const orig = history[m];
      history[m] = function (this: History, ...a: Parameters<History["pushState"]>) {
        const r = orig.apply(this, a);
        view();
        return r;
      };
    }
    w.addEventListener("popstate", () => view());
    w.addEventListener("pageshow", (e: PageTransitionEvent) => e.persisted && view(true));
    // A hidden tab may come back, so it sends with fetch and can retry. Leaving the page uses a beacon.
    const hide = (beacon: boolean) => {
      engage();
      flush(beacon);
    };
    d.addEventListener("visibilitychange", () => d.visibilityState === "hidden" && hide(false));
    w.addEventListener("pagehide", () => hide(true));

    const opts = { passive: true, capture: true };
    d.addEventListener("pointerdown", () => input("pointer"), opts);
    d.addEventListener("pointermove", () => (lastInput = Date.now()), opts);
    w.addEventListener("scroll", () => (input("scroll"), measure()), opts);
    // Counts keys outside fields only. Which key is never read.
    d.addEventListener("keydown", (e) => {
      const t = e.target as HTMLElement;
      if (!t || !(t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) input("keys");
    }, opts);
    setInterval(() => {
      if (d.visibilityState === "visible" && Date.now() - lastInput < ACTIVE_MS) active++;
    }, 1000);

    d.addEventListener("click", (e) => {
      if (curPriv) return;
      const t = (e.target as Element)?.closest?.("a,button,[role=button],input[type=submit],input[type=button]") as HTMLElement | null;
      if (!t) return;
      const a = t.tagName === "A" ? (t as HTMLAnchorElement) : null;
      let href = "";
      let out = false;
      if (a) {
        if (!/^https?:$/.test(a.protocol)) return;
        out = a.host !== location.host;
        if (!out && !a.hasAttribute("data-clr-cta") && !/btn|button|cta/i.test((a.getAttribute("class") || "") + (a.getAttribute("role") || ""))) return;
        href = scrubUrl(a.href, { origin: out });
      }
      const label = t.tagName === "INPUT" ? (t as HTMLInputElement).value : t.innerText || t.getAttribute("aria-label") || "";
      push("click", cur, { d: { text: scrubText(label.replace(/\s+/g, " ").trim()).slice(0, 80), href, out } });
    }, true);

    let lastForm = "";
    const form = (source: string) => (email: string, name: string) => {
      const mark = hash(email.toLowerCase()) + cur;
      if (mark === lastForm) return;
      lastForm = mark;
      setTimeout(() => (lastForm = ""), 5000);
      ident({ kind: source === "native" ? "form" : "adapter", source, email, form: name }, true);
    };
    watchForms(d, form("native"));
    watchHubspot(w, form("hubspot"));
    watchMarketo(w, form("marketo"));
    watchHops(d, domains, () =>
      identityOk()
        ? fetch(base + "/x?site=" + encodeURIComponent(site) + (cross && did() ? "&did=" + encodeURIComponent(did()) : ""), { credentials: "include" })
            .then((r) => (r.ok ? r.json() : {}))
            .then((j: any) => (typeof j.t === "string" ? j.t : ""))
        : Promise.resolve(""),
    );
    watchConsent(w, () => flush());

    view(true);
  }

  // The public API -------------------------------------------------------------------------------------

  const clean = (v: unknown, max: number) => {
    const s = typeof v === "number" ? String(v) : typeof v === "string" ? v.trim() : "";
    return s.length <= max && !BLOCKED_IDS.includes(s.toLowerCase()) ? s : "";
  };
  const api: any = (m: string, ...a: unknown[]) => typeof api[m] === "function" && api[m](...a);
  api.identify = (o: any) => {
    if (!o || typeof o !== "object") return;
    const userId = clean(o.userId, 200);
    const email = clean(o.email, 254);
    if (!userId && !email) return;
    const mark = hash(userId + "|" + email.toLowerCase());
    if (ss.get("_clr_i") === mark) return;
    if (identityOk()) ss.set("_clr_i", mark);
    ident({ kind: "identify", source: "native", userId: userId || null, email: email || null, iat: typeof o.iat === "number" ? o.iat : null, token: typeof o.token === "string" ? o.token.slice(0, 200) : null });
  };
  api.form = (email: unknown) => {
    const e = clean(email, 254);
    if (e.includes("@")) ident({ kind: "form", source: "native", email: e, form: "" }, true);
  };
  api.track = (name: unknown, props?: unknown) => {
    if (typeof name !== "string" || !name || curPriv) return;
    const p = scrubProps(props);
    push("track", cur, { n: scrubText(name).slice(0, 64), ...(p ? { d: p } : {}) });
  };
  api.consent = (v: unknown) => {
    apiConsent = !!v;
    if (!v) held = [];
    // Consent given after the server said cookieless: ask again with this page, so the visit can start as full.
    if (v && policy === "cookieless" && !gpc && cur) {
      policy = "";
      view(true);
    }
    flush();
  };
  api.optOut = () => {
    if (off) return;
    post("/opt", { ...head(), did: cross ? did() : undefined }, false).catch(() => {});
    off = true;
    q = [];
    retry = [];
    held = [];
    ls.set("_clr_opt", "1");
    ls.del("_clr_id");
    ss.del("_clr_q");
    setCookie("_clr_id", "", 0);
  };
  api.reset = () => {
    if (off) return;
    const old = cross ? did() : undefined;
    ss.del("_clr_i");
    ss.del("_clr_h");
    ls.del("_clr_id");
    setCookie("_clr_id", "", 0);
    post("/reset", { ...head(), did: old }, false).then(answer, () => {});
  };

  const queued = Array.from<ArrayLike<unknown>>((w.claritia && w.claritia.q) || []).map((a) => Array.from(a));
  w.claritia = api;
  // Consent calls made before the script loaded count for the first batch.
  for (const a of queued) if (a[0] === "consent") api(...a);
  const begin = () => {
    start();
    for (const a of queued) if (a[0] !== "consent") api(...a);
  };
  if (!off) {
    if ((d as any).prerendering) d.addEventListener("prerenderingchange", begin, { once: true });
    else begin();
  }
}

main();
