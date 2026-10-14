// What the runner does with one claimed exploration: sign in first with a test when one is set, crawl the site,
// save each page to the app map as it's found (with its screenshot), link the pages, then name them with Claude.

import { mkdtempSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { parseLock } from "../src/lib/lock.ts";
import { creditsLeft, secretsFor } from "./handle.ts";
import { explore, type FoundPage } from "./explorer.ts";
import type { Namer } from "./namer.ts";
import { executeRun } from "./runner.ts";
import { tunnelFor } from "./tunnel.ts";

export type Exploration = { id: string; workspace_id: string; project_id: string; environment_id: string | null; base_url: string; sign_in_test_id: string | null; max_pages: number; attempts: number };
type Options = {
  workerId: string;
  chromiumPath?: string;
  allowPrivate?: boolean;
  log?: (...a: unknown[]) => void;
  heartbeatMs?: number;
  namer?: Namer;
  concurrency?: number;
  pageTimeoutMs?: number;
  relay?: { url: string; secret: string };
};

const NAME_BATCH = 10;

export async function handleExploration(sb: SupabaseClient, x: Exploration, opts: Options) {
  const log = opts.log ?? (() => undefined);
  const started = Date.now();
  log(`Exploration ${x.id}: started (try ${x.attempts}).`);
  const heartbeat = setInterval(() => void sb.from("explorations").update({ locked_at: new Date().toISOString() }).eq("id", x.id).eq("locked_by", opts.workerId).then(() => undefined), opts.heartbeatMs ?? 30_000);
  const dir = mkdtempSync(join(tmpdir(), `explore-${x.id.slice(0, 8)}-`));
  const ai = { calls: 0, input: 0, output: 0 };
  let pagesFound = 0;

  // Finish only while it's still ours and running: a Stop pressed meanwhile stays.
  const finish = (fields: Record<string, unknown>) =>
    sb
      .from("explorations")
      .update({ ...fields, finished_at: new Date().toISOString(), duration_ms: Date.now() - started, locked_at: null, pages_found: pagesFound, ai_calls: ai.calls, ai_input_tokens: ai.input, ai_output_tokens: ai.output })
      .eq("id", x.id)
      .eq("locked_by", opts.workerId)
      .eq("status", "running");

  const tunnel = opts.allowPrivate ? {} : await tunnelFor(sb, x.workspace_id, x.base_url, opts.relay);
  try {
    if (tunnel.error) {
      await finish({ status: "error", error: tunnel.error });
      return;
    }
    // 1. Sign in with the chosen test's saved code, and keep its cookies for the crawl.
    let statePath: string | null = null;
    if (x.sign_in_test_id) {
      const { data: t, error } = await sb.from("tests").select("name, steps, lock").eq("id", x.sign_in_test_id).maybeSingle<{ name: string; steps: unknown[]; lock: string | null }>();
      if (error) throw new Error(error.message);
      if (!t?.lock) {
        await finish({ status: "error", error: "The sign-in test has no saved code. Run it once first." });
        return;
      }
      const parsed = parseLock(t.lock);
      const secrets = await secretsFor(sb, x.environment_id, parsed.ok ? parsed.secrets : []);
      const positions = Array.from({ length: Array.isArray(t.steps) ? t.steps.length : 0 }, (_, i) => i + 1);
      const signIn = await executeRun(
        { baseUrl: x.base_url, lock: t.lock, positions, secrets, dir: join(dir, "sign-in"), chromiumPath: opts.chromiumPath, allowPrivate: opts.allowPrivate, heal: false, saveStateTo: join(dir, "state.json"), tunnel: tunnel.client },
        { step: async () => undefined },
      );
      if (signIn.status !== "passed" || !signIn.state) {
        await finish({ status: "error", error: `The sign-in test ${t.name} didn't pass: ${signIn.error ?? "no reason given"}` });
        return;
      }
      statePath = signIn.state;
    }

    // 2. Crawl, saving each page as it's found.
    const ids = new Map<string, string>();
    const found: FoundPage[] = [];
    let lastStopCheck = 0;
    const result = await explore(
      {
        baseUrl: x.base_url,
        maxPages: x.max_pages,
        dir: join(dir, "pages"),
        concurrency: opts.concurrency,
        chromiumPath: opts.chromiumPath,
        allowPrivate: opts.allowPrivate,
        statePath,
        tunnel: tunnel.client,
        pageTimeoutMs: opts.pageTimeoutMs,
        shouldStop: async () => {
          if (Date.now() - lastStopCheck < 3000) return false;
          lastStopCheck = Date.now();
          const { data } = await sb.from("explorations").select("status").eq("id", x.id).maybeSingle<{ status: string }>();
          return data?.status === "canceled";
        },
      },
      async (p) => {
        found.push(p);
        let screenshot_path: string | null = null;
        if (p.screenshot) {
          const path = `${x.workspace_id}/explore/${x.id}/${found.length}.jpg`;
          const { error } = await sb.storage.from("runs").upload(path, await readFile(p.screenshot), { contentType: "image/jpeg", upsert: true });
          if (!error) screenshot_path = path;
        }
        const now = new Date().toISOString();
        const { data, error } = await sb
          .from("app_pages")
          .upsert(
            { workspace_id: x.workspace_id, project_id: x.project_id, exploration_id: x.id, pattern: p.pattern, sample_url: p.url, title: p.title || null, status_code: p.status, elements: p.elements, screenshot_path, depth: p.depth, last_seen: now },
            { onConflict: "project_id,pattern" },
          )
          .select("id")
          .single<{ id: string }>();
        if (error) throw new Error(`Saving ${p.pattern}: ${error.message}`);
        ids.set(p.pattern, data.id);
        pagesFound = found.length;
        await sb.from("explorations").update({ pages_found: pagesFound }).eq("id", x.id);
      },
    );

    // 3. Link the pages: each page to the pages it links to.
    const links = found.flatMap((p) => p.links.filter((to) => ids.has(to)).map((to) => ({ project_id: x.project_id, workspace_id: x.workspace_id, from_page: ids.get(p.pattern)!, to_page: ids.get(to)! })));
    for (let i = 0; i < links.length; i += 500) await sb.from("app_links").upsert(links.slice(i, i + 500), { onConflict: "from_page,to_page", ignoreDuplicates: true });

    // 4. Name the pages, within the plan's AI credits. Naming that fails leaves the page unnamed, nothing more.
    if (opts.namer && found.length) {
      let left = await creditsLeft(sb, x.workspace_id);
      for (let i = 0; i < found.length; i += NAME_BATCH) {
        if (left !== null && left <= 0) break;
        const batch = found.slice(i, i + NAME_BATCH);
        try {
          const r = await opts.namer(x.base_url, batch.map((p) => ({ pattern: p.pattern, title: p.title, elements: p.elements })));
          ai.calls++;
          ai.input += r.usage.input;
          ai.output += r.usage.output;
          if (left !== null) left--;
          for (const n of r.names) if (ids.has(n.pattern)) await sb.from("app_pages").update({ name: n.name, purpose: n.purpose }).eq("id", ids.get(n.pattern)!);
        } catch (e) {
          log(`Exploration ${x.id}: naming failed: ${e instanceof Error ? e.message : e}`);
        }
      }
    }

    await finish({ status: result.status, error: result.error });
    log(`Exploration ${x.id}: ${result.status}, ${pagesFound} pages${ai.calls ? `, ${ai.calls} AI calls` : ""}.`);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    log(`Exploration ${x.id}: error: ${message}`);
    await finish({ status: "error", error: `The runner hit a problem: ${message}` });
  } finally {
    tunnel.client?.close();
    clearInterval(heartbeat);
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
