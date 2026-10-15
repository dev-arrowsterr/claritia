import assert from "node:assert/strict";
import { test } from "node:test";
import { enqueueJob, JobError, jobLoop, runJob, type Job, type Rpc } from "../src/lib/jobs.ts";

const job = (over: Partial<Job> = {}): Job => ({ id: "j1", workspace_id: "w", kind: "stitch", key: "dev-1", payload: {}, attempts: 1, max_attempts: 5, ...over });

function fakeRpc(answers: Record<string, unknown> = {}) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const rpc: Rpc = async (fn, args) => {
    calls.push({ fn, args });
    const a = answers[fn];
    return { data: typeof a === "function" ? (a as () => unknown)() : (a ?? true), error: null };
  };
  return { rpc, calls };
}

test("a job that works is finished as done", async () => {
  const { rpc, calls } = fakeRpc();
  assert.equal(await runJob(rpc, "w1", job(), async () => {}), "done");
  assert.deepEqual(calls.at(-1), { fn: "finish_job", args: { p_id: "j1", p_worker: "w1", p_ok: true, p_error: null, p_retry_s: null } });
});

test("a job that throws is finished as failed, retried by the database's schedule", async () => {
  const { rpc, calls } = fakeRpc();
  assert.equal(await runJob(rpc, "w1", job(), async () => { throw new Error("IPinfo said 503"); }), "failed");
  assert.equal(calls.at(-1)!.args.p_error, "IPinfo said 503");
  assert.equal(calls.at(-1)!.args.p_retry_s, null);
});

test("JobError can stop retries or set the wait", async () => {
  const { rpc, calls } = fakeRpc();
  await runJob(rpc, "w1", job(), async () => { throw new JobError("bad input", { retry: false }); });
  assert.equal(calls.at(-1)!.args.p_retry_s, -1);
  await runJob(rpc, "w1", job(), async () => { throw new JobError("rate limited", { retryAfterS: 30 }); });
  assert.equal(calls.at(-1)!.args.p_retry_s, 30);
});

test("a lost lease is reported, and aborts the handler", async () => {
  const { rpc } = fakeRpc({ extend_job: false, finish_job: false });
  let aborted = false;
  const result = await runJob(rpc, "w1", job(), async (_j, signal) => {
    await new Promise((r) => setTimeout(r, 5_200));
    aborted = signal.aborted;
  }, 10);
  assert.equal(result, "lost");
  assert.ok(aborted, "the handler wasn't told the lease was lost");
});

test("enqueueJob passes defaults", async () => {
  const { rpc, calls } = fakeRpc({ enqueue_job: "new-id" });
  assert.equal(await enqueueJob(rpc, { workspaceId: "w", kind: "score", key: "acct-1" }), "new-id");
  assert.deepEqual(calls[0], { fn: "enqueue_job", args: { p_workspace: "w", p_kind: "score", p_key: "acct-1", p_payload: {}, p_delay_s: 0, p_max_attempts: 5 } });
});

test("the loop claims only the kinds it handles and runs each job", async () => {
  const ac = new AbortController();
  let claims = 0;
  const { rpc, calls } = fakeRpc({ claim_job: () => (++claims === 1 ? [job({ kind: "score" })] : []) });
  const ran: string[] = [];
  const loop = jobLoop({ rpc, worker: "w1", handlers: { score: async (j) => void ran.push(j.kind) }, idleMs: 10, signal: ac.signal });
  await new Promise((r) => setTimeout(r, 60));
  ac.abort();
  await loop;
  assert.deepEqual(ran, ["score"]);
  assert.deepEqual(calls.find((c) => c.fn === "claim_job")!.args.p_kinds, ["score"]);
});
