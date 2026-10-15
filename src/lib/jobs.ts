// The jobs queue from the worker's side (supabase/migrations/020_foundation.sql). A worker claims jobs of the kinds
// it handles, keeps the lease while a job runs, and finishes it. A handler that throws is retried later by the
// database (1, 5, 30 minutes, then 2 and 6 hours); throw `new JobError(msg, { retry: false })` to stop retrying.

export type Job = {
  id: string;
  workspace_id: string | null;
  kind: string;
  key: string;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
};

/** The one call the queue needs: Supabase's `rpc`, or a fake in tests. */
export type Rpc = (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }>;

export class JobError extends Error {
  retry: boolean;
  retryAfterS?: number;
  constructor(message: string, opts: { retry?: boolean; retryAfterS?: number } = {}) {
    super(message);
    this.retry = opts.retry ?? true;
    this.retryAfterS = opts.retryAfterS;
  }
}

async function call<T>(rpc: Rpc, fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data as T;
}

/** Add a job. With a key, it joins the job already waiting for that key. */
export const enqueueJob = (rpc: Rpc, job: { workspaceId: string | null; kind: string; key?: string; payload?: object; delayS?: number; maxAttempts?: number }) =>
  call<string>(rpc, "enqueue_job", {
    p_workspace: job.workspaceId,
    p_kind: job.kind,
    p_key: job.key ?? "",
    p_payload: job.payload ?? {},
    p_delay_s: job.delayS ?? 0,
    p_max_attempts: job.maxAttempts ?? 5,
  });

export type Handler = (job: Job, signal: AbortSignal) => Promise<void>;

/**
 * Run one job: keep its lease while the handler works, then finish it. Returns what happened.
 * The signal aborts when the lease is lost, so the handler can stop early.
 */
export async function runJob(rpc: Rpc, worker: string, job: Job, handler: Handler, leaseS = 300): Promise<"done" | "failed" | "lost"> {
  const ac = new AbortController();
  const keep = setInterval(
    () => {
      void call<boolean>(rpc, "extend_job", { p_id: job.id, p_worker: worker, p_lease_s: leaseS })
        .then((ok) => {
          if (!ok) ac.abort();
        })
        .catch(() => undefined);
    },
    Math.max(5, leaseS / 3) * 1000,
  );
  try {
    await handler(job, ac.signal);
    const ok = await call<boolean>(rpc, "finish_job", { p_id: job.id, p_worker: worker, p_ok: true, p_error: null, p_retry_s: null });
    return ok ? "done" : "lost";
  } catch (e) {
    const err = e instanceof JobError ? e : null;
    const message = e instanceof Error ? e.message : String(e);
    const ok = await call<boolean>(rpc, "finish_job", {
      p_id: job.id,
      p_worker: worker,
      p_ok: false,
      p_error: message.slice(0, 2000),
      p_retry_s: err && !err.retry ? -1 : (err?.retryAfterS ?? null),
    });
    return ok ? "failed" : "lost";
  } finally {
    clearInterval(keep);
  }
}

/** Claim and run jobs until `signal` aborts. Waits `idleMs` when there's nothing to do. */
export async function jobLoop(o: {
  rpc: Rpc;
  worker: string;
  handlers: Record<string, Handler>;
  leaseS?: number;
  idleMs?: number;
  signal?: AbortSignal;
  log?: (msg: string) => void;
}) {
  const kinds = Object.keys(o.handlers);
  while (!o.signal?.aborted) {
    let jobs: Job[] = [];
    try {
      jobs = await call<Job[]>(o.rpc, "claim_job", { p_kinds: kinds, p_worker: o.worker, p_lease_s: o.leaseS ?? 300, p_limit: 1 });
    } catch (e) {
      o.log?.(`claim_job failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!jobs?.length) {
      await new Promise((r) => setTimeout(r, o.idleMs ?? 1000));
      continue;
    }
    for (const job of jobs) {
      const result = await runJob(o.rpc, o.worker, job, o.handlers[job.kind]!, o.leaseS ?? 300);
      if (result !== "done") o.log?.(`${job.kind} ${job.id}: ${result}`);
    }
  }
}
