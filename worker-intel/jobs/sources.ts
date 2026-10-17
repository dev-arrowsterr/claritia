// Sources on claritia-intel (docs/conversion-weeks.md weeks 3 to 7): scheduled pulls with a push after, pushes
// when contacts change here, and staged webhooks. A long pull stops after 4 minutes and queues the rest.

import type pg from "pg";
import { enqueueJob, JobError, type Handler, type Job, type Rpc } from "../../src/lib/jobs.ts";
import { runActivity, runHooks, runPull, runPush, type RunOpts } from "../../src/lib/sources/run.ts";
import { AuthError, RateLimited } from "../../src/lib/sources/types.ts";
import { ctxFor } from "./imports.ts";

const idOf = (job: Job) => {
  const id = String(job.payload.source_id ?? "");
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new JobError(`${job.kind} needs a source`, { retry: false });
  return id;
};

const opts = (pool: pg.Pool, rpc: Rpc, signal: AbortSignal, extra: Partial<RunOpts> = {}): RunOpts => ({ rpc, clean: (ws) => ctxFor(pool, ws), signal, budgetMs: 240_000, ...extra });

async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof AuthError) throw new JobError(e.message, { retry: false });
    if (e instanceof RateLimited) throw new JobError(e.message, { retryAfterS: e.retryAfterS });
    throw e;
  }
}

export const sourcePull =
  (pool: pg.Pool, rpc: Rpc, extra: Partial<RunOpts> = {}): Handler =>
  async (job, signal) => {
    const id = idOf(job);
    const retry = Array.isArray(job.payload.retry) ? (job.payload.retry as unknown[]).filter((x): x is string => typeof x === "string") : undefined;
    const r = await guarded(() => runPull(opts(pool, rpc, signal, extra), id, retry));
    if (r?.more) await enqueueJob(rpc, { workspaceId: job.workspace_id, kind: "source_pull", key: id, payload: { source_id: id } });
  };

export const crmPush =
  (pool: pg.Pool, rpc: Rpc, extra: Partial<RunOpts> = {}): Handler =>
  async (job, signal) => {
    const id = idOf(job);
    const r = await guarded(() => runPush(opts(pool, rpc, signal, extra), id));
    if (r?.more) await enqueueJob(rpc, { workspaceId: job.workspace_id, kind: "crm_push", key: id, payload: { source_id: id } });
  };

export const crmActivity =
  (pool: pg.Pool, rpc: Rpc, extra: Partial<RunOpts> = {}): Handler =>
  async (job, signal) => {
    const id = idOf(job);
    const r = await guarded(() => runActivity(opts(pool, rpc, signal, extra), id));
    if (r?.more) await enqueueJob(rpc, { workspaceId: job.workspace_id, kind: "crm_activity", key: id, payload: { source_id: id } });
  };

export const sourceHook =
  (pool: pg.Pool, rpc: Rpc, extra: Partial<RunOpts> = {}): Handler =>
  async (job, signal) => {
    await guarded(() => runHooks(opts(pool, rpc, signal, extra), idOf(job)));
  };
