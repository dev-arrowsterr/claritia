// Running a source: load it with its unsealed credentials and mapping, then pull, push or apply hooks. Shared by
// the claritia-intel jobs and the tests. Errors land on the source; five in a row turn its card to Error.

import type { Ctx as CleanCtx } from "../contacts/import.ts";
import type { Rpc } from "../jobs.ts";
import { seal, unseal } from "../seal.ts";
import { makeCtx } from "./ctx.ts";
import type { SavedMapping } from "./map.ts";
import { connectorFor } from "./registry.ts";
import { applyHooks, call, pull, push, pushActivity, type Counts, type Deps } from "./sync.ts";
import { AuthError, type Creds, type HookEvent, type SourceRow } from "./types.ts";

export type RunOpts = {
  rpc: Rpc;
  clean: (ws: string) => Promise<CleanCtx>;
  fetcher?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
  budgetMs?: number;
  now?: () => number;
  /** Tests only: reach local databases without TLS. */
  local?: boolean;
  /** Refresh override, for tests. */
  refresh?: (refresh: string) => Promise<{ access: string; refresh: string | null; expiresAt: number }>;
};

type Loaded = { source: SourceRow; sealed: string | null; hook_sealed: string | null; mappings: SavedMapping[] };

export async function deps(o: RunOpts, sourceId: string): Promise<Deps | null> {
  const l = await call<Loaded | null>(o.rpc, "source_load", { p_id: sourceId });
  if (!l || !l.sealed || l.source.status === "disconnected") return null;
  const connector = connectorFor(l.source.kind);
  if (!connector) throw new Error(`No connector for ${l.source.kind}`);
  const creds = JSON.parse(unseal(l.sealed)) as Creds;
  const ctx = makeCtx({
    source: l.source,
    creds,
    fetcher: o.fetcher,
    sleep: o.sleep,
    signal: o.signal,
    gapMs: o.sleep ? 0 : connector.gapMs,
    refresh: o.refresh,
    local: o.local,
    saveCreds: async (c) => void (await call(o.rpc, "source_secret_save", { p_id: sourceId, p_sealed: seal(JSON.stringify(c)) })),
  });
  return { rpc: o.rpc, connector, ctx, clean: await o.clean(l.source.workspace_id), saved: l.mappings, now: o.now };
}

async function finish(o: RunOpts, d: Deps, object: string, direction: "in" | "out", started: Date, counts: Partial<Counts>, error: string | null) {
  await call(o.rpc, "source_run_log", { p_id: d.ctx.source.id, p_object: object, p_direction: direction, p_started: started.toISOString(), p_counts: counts, p_error: error });
}

/** A scheduled pull, then a push for two-way sources. Returns whether there's more to read. */
export async function runPull(o: RunOpts, sourceId: string, retryIds?: string[]): Promise<{ more: boolean } | null> {
  const d = await deps(o, sourceId);
  if (!d) return null;
  if (d.ctx.source.status === "paused") return { more: false };
  const started = new Date();
  try {
    if (retryIds?.length) {
      const c = await push(d, { ids: retryIds });
      await finish(o, d, "contacts", "out", started, c, null);
      return { more: false };
    }
    const r = await pull(d, o.budgetMs);
    for (const [object, c] of Object.entries(r.counts)) if (c.pulled || c.written || c.errors) await finish(o, d, object, "in", started, c, null);
    const p = await push(d, { budgetMs: o.budgetMs });
    if (p.written || p.errors) await finish(o, d, "contacts", "out", started, p, null);
    if (!r.more && !p.more) await call(o.rpc, "source_ran", { p_id: sourceId, p_error: null });
    return { more: r.more || p.more };
  } catch (e) {
    const msg = String((e as Error).message ?? e).slice(0, 1000);
    if (msg !== "Stopped") {
      await finish(o, d, "contacts", "in", started, {}, msg);
      await call(o.rpc, "source_ran", { p_id: sourceId, p_error: e instanceof AuthError ? `Reconnect: ${msg}` : msg });
    }
    throw e;
  }
}

/** Contacts changed here, out to a two-way source. */
export async function runPush(o: RunOpts, sourceId: string): Promise<{ more: boolean } | null> {
  const d = await deps(o, sourceId);
  if (!d || d.ctx.source.status !== "active") return null;
  const started = new Date();
  const p = await push(d, { budgetMs: o.budgetMs });
  if (p.written || p.errors) await finish(o, d, "contacts", "out", started, p, null);
  return { more: p.more };
}

/** Email and form activity out to a two-way CRM. */
export async function runActivity(o: RunOpts, sourceId: string): Promise<{ more: boolean } | null> {
  const d = await deps(o, sourceId);
  if (!d || d.ctx.source.status !== "active") return null;
  const started = new Date();
  const a = await pushActivity(d, { budgetMs: o.budgetMs });
  if (a.written || a.errors) await finish(o, d, "activity", "out", started, a, null);
  return { more: a.more };
}

/** Staged webhook events, applied in order. */
export async function runHooks(o: RunOpts, sourceId: string): Promise<number> {
  const d = await deps(o, sourceId);
  if (!d || d.ctx.source.status === "paused") return 0;
  let n = 0;
  for (;;) {
    const batch = await call<{ id: number; body: HookEvent }[]>(o.rpc, "hook_events_take", { p_source: sourceId, p_limit: 500 });
    if (!batch.length) break;
    await applyHooks(d, batch.map((b) => b.body));
    await call(o.rpc, "hook_events_done", { p_ids: batch.map((b) => b.id) });
    n += batch.length;
    if (o.signal?.aborted) throw new Error("Stopped");
  }
  // Changes that came in may need to go back out (a merge, a value a person holds here).
  if (n) await push(d, { budgetMs: o.budgetMs });
  return n;
}
