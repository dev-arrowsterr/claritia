// What a run came to, for the API and the CLI. A run the Judge calls flaky is run once more, so its outcome is the
// re-run's. A flaky failure counts as done only once its re-run is queued, or after a short wait if none comes.

import { APP_URL } from "./site.ts";

export type OutcomeRun = {
  id: string;
  test_id: string | null;
  test_name: string;
  environment_name: string;
  status: "queued" | "running" | "passed" | "failed" | "error" | "canceled";
  verdict: "app_bug" | "flaky" | "setup" | null;
  verdict_reason: string | null;
  error: string | null;
  duration_ms: number | null;
  finished_at: string | null;
  retry_of: string | null;
  retried_as: string | null;
};

export type FailedStep = { run_id: string; position: number; label: string; error: string | null };

export type Outcome = {
  /** The run that was started. */
  id: string;
  /** The run that decides the outcome: the re-run when there was one. */
  final_id: string;
  test_id: string | null;
  test: string;
  environment: string;
  status: OutcomeRun["status"];
  done: boolean;
  passed: boolean;
  /** It failed once, was re-run, and the re-run passed. */
  passed_on_retry: boolean;
  verdict: OutcomeRun["verdict"];
  reason: string | null;
  error: string | null;
  failed_step: { position: number; label: string; error: string | null } | null;
  duration_ms: number | null;
  url: string;
};

/** How long a flaky failure waits for its re-run to show up before it counts as the outcome. */
export const RETRY_GRACE_MS = 2 * 60_000;

const FINISHED = new Set(["passed", "failed", "error", "canceled"]);

export function outcomeOf(start: OutcomeRun, byId: Map<string, OutcomeRun>, failedSteps: FailedStep[], now = Date.now()): Outcome {
  const retry = start.retried_as ? byId.get(start.retried_as) : undefined;
  const r = retry ?? start;
  const awaitingRetry =
    r.status === "failed" && r.verdict === "flaky" && !r.retry_of && !r.retried_as && !!r.finished_at && now - Date.parse(r.finished_at) < RETRY_GRACE_MS;
  // A re-run was queued but isn't loaded: not done yet.
  const missingRetry = !!start.retried_as && !retry;
  const step = failedSteps.filter((s) => s.run_id === r.id).sort((a, b) => a.position - b.position)[0];
  return {
    id: start.id,
    final_id: r.id,
    test_id: start.test_id,
    test: start.test_name,
    environment: start.environment_name,
    status: r.status,
    done: FINISHED.has(r.status) && !awaitingRetry && !missingRetry,
    passed: r.status === "passed",
    passed_on_retry: !!retry && r.status === "passed",
    verdict: r.verdict,
    reason: r.verdict_reason,
    error: r.error,
    failed_step: step ? { position: step.position, label: step.label, error: step.error } : null,
    duration_ms: r.duration_ms,
    url: `${APP_URL}/runs/${r.id}`,
  };
}
