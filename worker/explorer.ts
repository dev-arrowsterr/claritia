// The Explorer: crawls a site with a few browser tabs at once, following links on the same site, and reports each
// kind of page it finds (one per address pattern, like /orders/:id) with its title, headings, forms, main buttons,
// links and a screenshot. It only follows links; it never clicks buttons or submits forms, so it changes nothing.
// Links that would sign out or delete something are skipped.

import { lookup } from "node:dns/promises";
import { mkdir } from "node:fs/promises";
import { isIP } from "node:net";
import { join } from "node:path";
import pw from "playwright-core";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { isPrivateAddress } from "./runner.ts";

export type PageElements = {
  headings: string[];
  forms: { fields: { label: string; type: string }[]; submit: string }[];
  buttons: string[];
};
export type FoundPage = {
  pattern: string;
  url: string;
  title: string;
  status: number | null;
  depth: number;
  /** The patterns of the same-site pages this one links to. */
  links: string[];
  elements: PageElements;
  screenshot: string | null;
  /** The pattern of the page that linked here first. */
  from: string | null;
};
export type ExploreInput = {
  baseUrl: string;
  maxPages: number;
  dir: string;
  concurrency?: number;
  chromiumPath?: string;
  /** Only for local testing: lets the browser reach localhost and private networks. */
  allowPrivate?: boolean;
  /** Cookies and storage from a sign-in run, so pages behind the sign-in are reachable. */
  statePath?: string | null;
  pageTimeoutMs?: number;
  runTimeoutMs?: number;
  maxDepth?: number;
  /** Checked between pages; true stops the crawl (someone pressed Stop). */
  shouldStop?: () => Promise<boolean>;
};
export type ExploreResult = { status: "done" | "error" | "canceled"; error: string | null; pages: number; durationMs: number };

const VIEWPORT = { width: 1280, height: 720 };
const LOCAL_NAMES = /(^|\.)(localhost|local|internal|localdomain|home\.arpa)$/i;
const FILES = /\.(pdf|zip|gz|tgz|rar|7z|dmg|exe|msi|apk|png|jpe?g|gif|webp|svg|ico|mp4|mov|webm|mp3|wav|csv|xlsx?|docx?|pptx?|json|xml|txt|ics)$/i;
// Links that would sign out, delete or unsubscribe. The Explorer stays signed in and changes nothing.
const RISKY = /(log[-_ ]?out|sign[-_ ]?out|signout|logoff|delete|destroy|remove|unsubscribe|deactivate|cancel[-_ ]?(account|subscription|plan)|revoke|disconnect)/i;

/** A path segment that is an id rather than a name: a number, a UUID, a long hex or random-looking token. */
function isIdSegment(s: string) {
  return (
    /^\d+$/.test(s) ||
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s) ||
    /^[0-9a-f]{12,}$/i.test(s) ||
    (s.length >= 16 && /\d/.test(s) && /[a-z]/i.test(s) && !s.includes("-")) ||
    /^[a-z0-9-]+-\d{3,}$/i.test(s)
  );
}

/** The address pattern of a page: the path with ids swapped for :id, no query or hash. "/orders/123" → "/orders/:id". */
export function patternOf(url: URL): string {
  const parts = url.pathname
    .split("/")
    .filter(Boolean)
    .map((s) => (isIdSegment(decodeURIComponent(s)) ? ":id" : decodeURIComponent(s).toLowerCase()));
  return `/${parts.join("/")}`;
}

/** Whether a link is worth following: same site, a web page, and nothing that would sign out or delete. */
export function shouldFollow(link: URL, base: URL, text = ""): boolean {
  if (link.protocol !== "http:" && link.protocol !== "https:") return false;
  if (link.origin !== base.origin) return false;
  if (FILES.test(link.pathname)) return false;
  if (RISKY.test(link.pathname) || RISKY.test(link.search) || RISKY.test(text)) return false;
  return true;
}

/** What's on the page: title, headings, forms and their fields, main buttons, and links with their text. */
async function readPage(page: Page) {
  return page.evaluate(() => {
    const visible = (el: Element) => {
      const r = (el as HTMLElement).getBoundingClientRect?.();
      const st = window.getComputedStyle(el);
      return !!r && r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none";
    };
    const text = (el: Element | null | undefined) => (el?.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
    const labelOf = (f: Element) => {
      const id = f.getAttribute("id");
      const byFor = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
      return (text(byFor) || f.getAttribute("aria-label") || f.getAttribute("placeholder") || f.getAttribute("name") || text(f.closest("label")) || "").slice(0, 80);
    };
    const headings = [...document.querySelectorAll("h1, h2")].filter(visible).map(text).filter(Boolean).slice(0, 10);
    const forms = [...document.querySelectorAll("form")].filter(visible).slice(0, 10).map((form) => ({
      fields: [...form.querySelectorAll("input, select, textarea")]
        .filter((f) => (f as HTMLInputElement).type !== "hidden" && visible(f))
        .slice(0, 20)
        .map((f) => ({ label: labelOf(f), type: (f as HTMLInputElement).type || f.tagName.toLowerCase() })),
      submit: text(form.querySelector('button[type="submit"], input[type="submit"], button:not([type])')) || (form.querySelector('input[type="submit"]') as HTMLInputElement | null)?.value || "",
    }));
    const buttons = [...new Set([...document.querySelectorAll('button, [role="button"], input[type="submit"]')].filter(visible).map((b) => text(b) || (b as HTMLInputElement).value || b.getAttribute("aria-label") || "").filter(Boolean))].slice(0, 20);
    const links = [...document.querySelectorAll("a[href]")].slice(0, 400).map((a) => ({ href: (a as HTMLAnchorElement).href, text: text(a) }));
    return { title: document.title.trim().slice(0, 200), headings, forms, buttons, links };
  });
}

export async function explore(input: ExploreInput, onPage: (p: FoundPage) => Promise<void>): Promise<ExploreResult> {
  const started = Date.now();
  const base = new URL(input.baseUrl);
  const max = Math.max(1, Math.min(input.maxPages, 200));
  const concurrency = Math.max(1, Math.min(input.concurrency ?? 3, 6));
  const pageTimeout = input.pageTimeoutMs ?? 20_000;
  const runTimeout = input.runTimeoutMs ?? 10 * 60_000;
  const maxDepth = input.maxDepth ?? 8;
  await mkdir(input.dir, { recursive: true });

  // Same guard as runs: hosts that resolve to private addresses are refused.
  const hostChecks = new Map<string, Promise<boolean>>();
  const hostIsPrivate = (host: string) => {
    if (!hostChecks.has(host)) {
      hostChecks.set(
        host,
        (async () => {
          const bare = host.replace(/^\[|\]$/g, "");
          if (LOCAL_NAMES.test(bare)) return true;
          if (isIP(bare)) return isPrivateAddress(bare);
          try {
            return (await lookup(bare, { all: true })).some((a) => isPrivateAddress(a.address));
          } catch {
            return false;
          }
        })(),
      );
    }
    return hostChecks.get(host)!;
  };

  const queue: { url: URL; depth: number; from: string | null }[] = [{ url: base, depth: 0, from: null }];
  const queued = new Set<string>([patternOf(base)]);
  const done = new Set<string>();
  let found = 0;
  let active = 0;
  let stop: ExploreResult["status"] | null = null;
  let firstError: string | null = null;
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;

  const enqueue = (url: URL, depth: number, from: string) => {
    const p = patternOf(url);
    if (queued.has(p) || depth > maxDepth || queued.size >= max * 4) return;
    queued.add(p);
    url.hash = "";
    queue.push({ url, depth, from });
  };

  const visit = async (page: Page, item: (typeof queue)[number]) => {
    const pattern = patternOf(item.url);
    let status: number | null = null;
    try {
      const res = await page.goto(item.url.href, { waitUntil: "domcontentloaded", timeout: pageTimeout });
      status = res?.status() ?? null;
      // Give the page a moment to draw its content, without waiting forever on pages that never go quiet.
      await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => undefined);
    } catch (e) {
      const message = e instanceof Error ? e.message.split("\n")[0]! : String(e);
      if (item.depth === 0) firstError = /ERR_BLOCKED_BY_CLIENT/.test(message) ? `Claritia blocked ${base.hostname} because it points to a private network address.` : `The site didn't load: ${message}`;
      return;
    }
    // A redirect to another site, or to a page already found (a sign-in page, the home page), adds nothing new.
    const landed = new URL(page.url());
    if (landed.origin !== base.origin) return;
    const landedPattern = patternOf(landed);
    if (landedPattern !== pattern && (done.has(landedPattern) || queued.has(landedPattern))) return;
    if (done.has(landedPattern) || found >= max) return;
    done.add(landedPattern);
    queued.add(landedPattern);
    found++;

    const info = await readPage(page).catch(() => null);
    const links: string[] = [];
    for (const l of info?.links ?? []) {
      let u: URL;
      try {
        u = new URL(l.href);
      } catch {
        continue;
      }
      if (!shouldFollow(u, base, l.text)) continue;
      const lp = patternOf(u);
      if (lp !== landedPattern && !links.includes(lp)) links.push(lp);
      enqueue(u, item.depth + 1, landedPattern);
    }
    // A page still loading something (a stream, a request that never ends) is stopped, so the screenshot doesn't wait on it.
    await page.evaluate(() => window.stop()).catch(() => undefined);
    const shot = join(input.dir, `page-${found}.jpg`);
    const screenshot = await page
      .screenshot({ path: shot, type: "jpeg", quality: 60, timeout: 5000 })
      .then(() => shot)
      .catch(() => null);
    await onPage({
      pattern: landedPattern,
      url: `${landed.origin}${landed.pathname}`,
      title: info?.title ?? "",
      status,
      depth: item.depth,
      links,
      elements: { headings: info?.headings ?? [], forms: info?.forms ?? [], buttons: info?.buttons ?? [] },
      screenshot,
      from: item.from,
    });
  };

  const worker = async () => {
    const page = await context!.newPage();
    page.on("dialog", (d) => void d.dismiss().catch(() => undefined));
    try {
      for (;;) {
        if (stop) return;
        if (found >= max) return;
        const item = queue.shift();
        if (!item) {
          if (active === 0) return;
          await new Promise((r) => setTimeout(r, 100));
          continue;
        }
        active++;
        try {
          await visit(page, item);
        } finally {
          active--;
        }
        if (input.shouldStop && (await input.shouldStop().catch(() => false))) stop = "canceled";
        if (Date.now() - started > runTimeout) stop = "done";
      }
    } finally {
      await page.close().catch(() => undefined);
    }
  };

  try {
    browser = await pw.chromium.launch({ headless: true, executablePath: input.chromiumPath || undefined, args: ["--disable-dev-shm-usage"] });
    context = await browser.newContext({ viewport: VIEWPORT, acceptDownloads: false, serviceWorkers: "block", ...(input.statePath ? { storageState: input.statePath } : {}) });
    context.setDefaultTimeout(10_000);
    // Pages that open new windows: close them, the crawl follows links in its own tabs.
    context.on("page", (p) => void p.opener().then((o) => (o ? p.close() : undefined)).catch(() => undefined));
    if (!input.allowPrivate) {
      await context.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if ((url.protocol === "http:" || url.protocol === "https:") && (await hostIsPrivate(url.hostname))) return route.abort("blockedbyclient");
        return route.continue();
      });
    }
    // The first page alone, so a site that doesn't load fails fast and clearly.
    const first = queue.shift()!;
    const page = await context.newPage();
    page.on("dialog", (d) => void d.dismiss().catch(() => undefined));
    await visit(page, first);
    await page.close().catch(() => undefined);
    if (!found) return { status: "error", error: firstError ?? "The first page didn't load.", pages: 0, durationMs: Date.now() - started };
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    return { status: stop === "canceled" ? "canceled" : "done", error: null, pages: found, durationMs: Date.now() - started };
  } catch (e) {
    return { status: "error", error: e instanceof Error ? e.message.split("\n")[0]! : String(e), pages: found, durationMs: Date.now() - started };
  } finally {
    await (context as BrowserContext | null)?.close().catch(() => undefined);
    await (browser as Browser | null)?.close().catch(() => undefined);
  }
}
