// Runs one test in a fresh browser. Reads the lock into allowed actions (src/lib/lock.ts) and carries them out
// with Playwright. Records a video, a trace, a screenshot after each step, and the page's console.
// Knows nothing about the database: the worker passes in what to run and gets results back through hooks.

import { lookup } from "node:dns/promises";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { join } from "node:path";
import { unzipSync, zipSync } from "fflate";
import pw from "playwright-core";
import type { Browser, BrowserContext, Locator, Page } from "playwright-core";
import { parseLock, type Action, type Arg, type Call } from "../src/lib/lock.ts";

export type StepStatus = "running" | "passed" | "failed" | "skipped";
export type StepUpdate = { position: number; status: StepStatus; retried?: boolean; startedMs?: number; durationMs?: number; error?: string | null; screenshot?: string };
export type RunInput = {
  baseUrl: string;
  lock: string;
  /** The run's step positions, 1 to n, from the test's steps. */
  positions: number[];
  secrets: Record<string, string>;
  dir: string;
  chromiumPath?: string;
  /** Only for local testing: lets the browser reach localhost and private networks. */
  allowPrivate?: boolean;
  actionTimeoutMs?: number;
  expectTimeoutMs?: number;
  runTimeoutMs?: number;
};
export type RunResult = { status: "passed" | "failed" | "error"; error: string | null; durationMs: number; video: string | null; traces: string[]; consoleFile: string | null };
export type Hooks = { step: (u: StepUpdate) => Promise<void> };

const VIEWPORT = { width: 1280, height: 720 };

// Private and local addresses the browser may never reach from our servers.
export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (v === 6) {
    const s = ip.toLowerCase();
    if (s === "::1" || s === "::") return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
    if (mapped) return isPrivateAddress(mapped[1]!);
    return /^f[cd]/.test(s) || /^fe[89ab]/.test(s) || s.startsWith("ff");
  }
  return false;
}

const LOCAL_NAMES = /(^|\.)(localhost|local|internal|localdomain|home\.arpa)$/i;

/** Hide every secret value in a piece of text. */
export function maskSecrets(text: string, secrets: Record<string, string>) {
  let out = text;
  for (const v of Object.values(secrets).filter((s) => s.length >= 3).sort((a, b) => b.length - a.length)) out = out.split(v).join("••••");
  return out;
}

/** The forms a secret can take inside a trace: as typed, escaped inside JSON, and URL-encoded. */
function secretForms(secrets: Record<string, string>) {
  const forms = new Set<string>();
  for (const v of Object.values(secrets)) {
    if (v.length < 3) continue;
    forms.add(v);
    forms.add(JSON.stringify(v).slice(1, -1));
    forms.add(encodeURIComponent(v));
    forms.add(encodeURIComponent(v).replace(/%20/g, "+"));
  }
  return [...forms].sort((a, b) => b.length - a.length).map((f) => Buffer.from(f, "utf8"));
}

/**
 * Playwright traces keep what was typed into fields, page snapshots and console messages.
 * Before a trace leaves the runner, every secret in every file inside it is overwritten with * of the same length.
 */
export async function scrubTrace(path: string, secrets: Record<string, string>) {
  const forms = secretForms(secrets);
  if (!forms.length) return 0;
  const files = unzipSync(new Uint8Array(await readFile(path)));
  let hits = 0;
  for (const [name, data] of Object.entries(files)) {
    const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    for (const f of forms) {
      for (let i = buf.indexOf(f); i >= 0; i = buf.indexOf(f, i + f.length)) {
        buf.fill(0x2a, i, i + f.length);
        hits++;
      }
    }
    files[name] = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  if (hits) await writeFile(path, zipSync(files, { level: 6 }));
  return hits;
}

/** The useful part of a Playwright error: its first lines, without the long call log. */
function shortError(e: unknown) {
  const text = e instanceof Error ? e.message : String(e);
  const lines = text.split("\n").filter((l) => l.trim() && !/^\s*-\s/.test(l) && !/Call log:/i.test(l));
  return lines.slice(0, 3).join(" ").replace(/\s+/g, " ").slice(0, 600);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function executeRun(input: RunInput, hooks: Hooks): Promise<RunResult> {
  const started = Date.now();
  const actionTimeout = input.actionTimeoutMs ?? 10_000;
  const expectTimeout = input.expectTimeoutMs ?? 5_000;
  const runTimeout = input.runTimeoutMs ?? 5 * 60_000;
  const mask = (t: string) => maskSecrets(t, input.secrets);
  const result = (status: RunResult["status"], error: string | null, extra: Partial<RunResult> = {}): RunResult => ({ status, error: error && mask(error), durationMs: Date.now() - started, video: null, traces: [], consoleFile: null, ...extra });

  const parsed = parseLock(input.lock);
  if (!parsed.ok) return result("error", `The test's code has a problem on line ${parsed.errors[0]!.line}: ${parsed.errors[0]!.message}`);
  const missing = parsed.secrets.filter((s) => !(s in input.secrets));
  if (missing.length) return result("error", `Add ${missing.join(", ")} to this environment in Settings.`);
  if (!parsed.actionCount) return result("error", "This test has no Playwright code yet.");

  await mkdir(input.dir, { recursive: true });
  const videoDir = join(input.dir, "video");
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let page: Page | null = null;
  const traces: string[] = [];
  const consoleLines: { ms: number; type: string; text: string }[] = [];
  const blocked = new Set<string>();
  let pageStart = Date.now();

  // Hosts are looked up once per run, and private ones are refused.
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
            const all = await lookup(bare, { all: true });
            return all.some((a) => isPrivateAddress(a.address));
          } catch {
            return false;
          }
        })(),
      );
    }
    return hostChecks.get(host)!;
  };

  const resolve = (a: Arg): unknown => {
    switch (a.kind) {
      case "string":
      case "number":
      case "boolean":
        return a.value;
      case "regex":
        return new RegExp(a.source, a.flags);
      case "secret":
        return input.secrets[a.name];
      case "object":
        return Object.fromEntries(Object.entries(a.entries).map(([k, v]) => [k, resolve(v)]));
      case "array":
        return a.items.map(resolve);
    }
  };

  const locate = (p: Page, chain: Call[]): Locator => {
    let loc: unknown = p;
    for (const c of chain) loc = (loc as Record<string, (...x: unknown[]) => unknown>)[c.fn]!(...c.args.map(resolve));
    return loc as Locator;
  };

  const absolute = (url: string) => {
    const u = new URL(url, input.baseUrl);
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("Only http and https addresses can be opened.");
    return u.toString();
  };

  const poll = async (describe: string, not: boolean, check: () => Promise<{ pass: boolean; actual: string }>) => {
    const deadline = Date.now() + expectTimeout;
    let last = "";
    for (;;) {
      try {
        const r = await check();
        last = r.actual;
        if (r.pass !== not) return;
      } catch (e) {
        last = shortError(e);
      }
      if (Date.now() > deadline) throw new Error(`Expected ${not ? "not " : ""}${describe}. Got: ${last || "nothing"}`);
      await sleep(150);
    }
  };

  const textMatch = (actual: string, want: unknown, contains: boolean) => {
    const norm = actual.replace(/\s+/g, " ").trim();
    if (want instanceof RegExp) return want.test(norm);
    const w = String(want).replace(/\s+/g, " ").trim();
    return contains ? norm.includes(w) : norm === w;
  };

  const perform = async (p: Page, a: Action) => {
    if (a.type === "page") {
      const args = a.args.map(resolve);
      switch (a.method) {
        case "goto":
          await p.goto(absolute(String(args[0])), { waitUntil: "load" });
          return;
        case "waitForURL":
          await p.waitForURL(args[0] instanceof RegExp ? args[0] : absolute(String(args[0])));
          return;
        case "waitForTimeout":
          await p.waitForTimeout(Number(args[0]));
          return;
        case "waitForLoadState":
          await p.waitForLoadState((args[0] as "load" | "domcontentloaded" | "networkidle" | undefined) ?? "load");
          return;
        case "reload":
          await p.reload();
          return;
        case "goBack":
          await p.goBack();
          return;
        case "goForward":
          await p.goForward();
          return;
      }
      throw new Error(`Unknown page action ${a.method}.`);
    }
    if (a.type === "keyboard") {
      const arg = String(resolve(a.args[0]!));
      if (a.method === "press") await p.keyboard.press(arg);
      else if (a.method === "type") await p.keyboard.type(arg);
      else await p.keyboard.insertText(arg);
      return;
    }
    if (a.type === "locator") {
      const loc = locate(p, a.chain);
      const args = a.args.map(resolve);
      const fn = (loc as unknown as Record<string, (...x: unknown[]) => Promise<unknown>>)[a.method]!;
      await fn.apply(loc, args);
      return;
    }
    // expect
    const args = a.args.map(resolve);
    if (a.subject === "page") {
      const want = args[0];
      if (a.matcher === "toHaveURL") {
        await poll(`the address to be ${want}`, a.not, async () => {
          const url = p.url();
          const u = new URL(url);
          const pass = want instanceof RegExp ? want.test(url) : url === String(want) || url === absolute(String(want)) || u.pathname + u.search === String(want);
          return { pass, actual: url };
        });
      } else {
        await poll(`the title to be ${want}`, a.not, async () => {
          const title = await p.title();
          return { pass: want instanceof RegExp ? want.test(title) : title === String(want), actual: title };
        });
      }
      return;
    }
    const loc = locate(p, a.subject);
    const what = a.subject.map((c) => `${c.fn}(${c.args.map((x) => (x.kind === "string" ? `'${x.value}'` : x.kind === "secret" ? "secret" : "…")).join(", ")})`).join(".");
    const yes = (pass: boolean, actual: string) => ({ pass, actual });
    switch (a.matcher) {
      case "toBeVisible":
        return poll(`${what} to be visible`, a.not, async () => yes(await loc.isVisible(), (await loc.isVisible()) ? "visible" : "not visible"));
      case "toBeHidden":
        return poll(`${what} to be hidden`, a.not, async () => yes(await loc.isHidden(), (await loc.isHidden()) ? "hidden" : "visible"));
      case "toBeEnabled":
        return poll(`${what} to be enabled`, a.not, async () => yes(await loc.isEnabled({ timeout: 1000 }), "disabled"));
      case "toBeDisabled":
        return poll(`${what} to be disabled`, a.not, async () => yes(await loc.isDisabled({ timeout: 1000 }), "enabled"));
      case "toBeChecked":
        return poll(`${what} to be checked`, a.not, async () => yes(await loc.isChecked({ timeout: 1000 }), "not checked"));
      case "toBeFocused":
        return poll(`${what} to be focused`, a.not, async () => yes(await loc.evaluate((el) => el === document.activeElement, undefined, { timeout: 1000 }), "not focused"));
      case "toBeEmpty":
        return poll(`${what} to be empty`, a.not, async () => {
          const v = await loc.evaluate((el) => ("value" in el ? String((el as HTMLInputElement).value) : (el.textContent ?? "")), undefined, { timeout: 1000 });
          return yes(v.trim() === "", JSON.stringify(v.slice(0, 80)));
        });
      case "toHaveText":
      case "toContainText":
        return poll(`${what} ${a.matcher === "toHaveText" ? "to have text" : "to contain"} ${JSON.stringify(String(args[0]))}`, a.not, async () => {
          const t = await loc.innerText({ timeout: 1000 });
          return yes(textMatch(t, args[0], a.matcher === "toContainText"), JSON.stringify(t.slice(0, 120)));
        });
      case "toHaveValue":
        return poll(`${what} to have value ${JSON.stringify(String(args[0]))}`, a.not, async () => {
          const v = await loc.inputValue({ timeout: 1000 });
          return yes(args[0] instanceof RegExp ? args[0].test(v) : v === String(args[0]), JSON.stringify(v.slice(0, 120)));
        });
      case "toHaveCount":
        return poll(`${what} to match ${args[0]} elements`, a.not, async () => {
          const n = await loc.count();
          return yes(n === Number(args[0]), `${n}`);
        });
      case "toHaveAttribute":
        return poll(`${what} to have attribute ${String(args[0])}`, a.not, async () => {
          const v = await loc.getAttribute(String(args[0]), { timeout: 1000 });
          const pass = args.length === 1 ? v !== null : args[1] instanceof RegExp ? v !== null && args[1].test(v) : v === String(args[1]);
          return yes(pass, v === null ? "no attribute" : JSON.stringify(v));
        });
    }
    throw new Error(`Unknown check ${a.matcher}.`);
  };

  let timerHandle: ReturnType<typeof setTimeout> | undefined;
  const timer = new Promise<"timeout">((r) => (timerHandle = setTimeout(() => r("timeout"), runTimeout)));

  const body = async (): Promise<{ status: "passed" | "failed"; error: string | null }> => {
    browser = await pw.chromium.launch({ headless: true, executablePath: input.chromiumPath || undefined, args: ["--disable-dev-shm-usage"] });
    context = await browser.newContext({ viewport: VIEWPORT, recordVideo: { dir: videoDir, size: VIEWPORT }, acceptDownloads: false, serviceWorkers: "block" });
    context.setDefaultTimeout(actionTimeout);
    context.setDefaultNavigationTimeout(30_000);
    if (!input.allowPrivate) {
      await context.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if ((url.protocol === "http:" || url.protocol === "https:") && (await hostIsPrivate(url.hostname))) {
          blocked.add(url.hostname);
          return route.abort("blockedbyclient");
        }
        return route.continue();
      });
    }
    await context.tracing.start({ screenshots: true, snapshots: true });
    page = await context.newPage();
    pageStart = Date.now();
    page.on("console", (m) => consoleLines.push({ ms: Date.now() - pageStart, type: m.type(), text: mask(m.text()).slice(0, 2000) }));
    page.on("pageerror", (e) => consoleLines.push({ ms: Date.now() - pageStart, type: "pageerror", text: mask(e.message).slice(0, 2000) }));

    let failed: string | null = null;
    for (const position of input.positions) {
      if (failed) {
        await hooks.step({ position, status: "skipped" });
        continue;
      }
      const step = parsed.steps.find((s) => s.number === position);
      if (!step || !step.actions.length) {
        await hooks.step({ position, status: "skipped", error: "No code for this step yet." });
        continue;
      }
      const startedMs = Date.now() - pageStart;
      await hooks.step({ position, status: "running", startedMs });
      let error: string | null = null;
      let retried = false;
      for (let attempt = 0; attempt < 2; attempt++) {
        error = null;
        try {
          for (const a of step.actions) await perform(page, a);
          break;
        } catch (e) {
          error = blocked.size ? `Claritia blocked ${[...blocked].join(", ")} because it points to a private network address.` : shortError(e);
          // One retry for the whole step, so a slow page doesn't fail the run. A step that passes on retry is marked as retried.
          if (attempt === 0) {
            retried = true;
            await sleep(1000);
          }
        }
      }
      const shot = join(input.dir, `step-${position}.jpg`);
      await page.screenshot({ path: shot, type: "jpeg", quality: 70 }).catch(() => undefined);
      const durationMs = Date.now() - pageStart - startedMs;
      if (error) {
        failed = mask(error);
        await hooks.step({ position, status: "failed", retried, startedMs, durationMs, error: failed, screenshot: shot });
      } else {
        await hooks.step({ position, status: "passed", retried, startedMs, durationMs, error: null, screenshot: shot });
      }
    }
    return failed ? { status: "failed", error: failed } : { status: "passed", error: null };
  };

  let outcome: { status: "passed" | "failed" | "error"; error: string | null };
  try {
    const r = await Promise.race([body(), timer]);
    outcome = r === "timeout" ? { status: "error", error: `The run took longer than ${Math.round(runTimeout / 60000)} minutes and was stopped.` } : r;
  } catch (e) {
    outcome = { status: "error", error: shortError(e) };
  } finally {
    clearTimeout(timerHandle);
  }

  // Save what we have, even after an error.
  let video: string | null = null;
  try {
    const ctx = context as BrowserContext | null;
    if (ctx) {
      const tracePath = join(input.dir, "trace.zip");
      const saved = await ctx.tracing
        .stop({ path: tracePath })
        .then(() => true)
        .catch(() => false);
      if (saved) {
        await scrubTrace(tracePath, input.secrets);
        traces.push(tracePath);
      }
      const v = (page as Page | null)?.video();
      await ctx.close().catch(() => undefined);
      video = v ? await v.path().catch(() => null) : null;
    }
  } finally {
    await (browser as Browser | null)?.close().catch(() => undefined);
  }
  const consoleFile = join(input.dir, "console.json");
  await writeFile(consoleFile, JSON.stringify(consoleLines));
  return result(outcome.status, outcome.error, { video, traces, consoleFile });
}
