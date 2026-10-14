import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { outcomeOf, type FailedStep, type Outcome, type OutcomeRun } from "./outcome.ts";

const RUN_FIELDS = "id, test_id, test_name, environment_name, status, verdict, verdict_reason, error, duration_ms, finished_at, retry_of, retried_as";

/** Where a workspace's runs stand, each followed to its re-run. Runs that aren't found are left out. */
export async function loadOutcomes(sb: SupabaseClient, workspaceId: string, ids: string[]): Promise<Outcome[]> {
  if (!ids.length) return [];
  const { data, error } = await sb.from("runs").select(RUN_FIELDS).eq("workspace_id", workspaceId).in("id", ids);
  if (error) throw new Error(error.message);
  const started = (data ?? []) as OutcomeRun[];
  const byId = new Map(started.map((r) => [r.id, r]));
  const retryIds = started.map((r) => r.retried_as).filter((x): x is string => !!x && !byId.has(x));
  if (retryIds.length) {
    const { data: retries, error: retryErr } = await sb.from("runs").select(RUN_FIELDS).eq("workspace_id", workspaceId).in("id", retryIds);
    if (retryErr) throw new Error(retryErr.message);
    for (const r of (retries ?? []) as OutcomeRun[]) byId.set(r.id, r);
  }
  const failedIds = [...byId.values()].filter((r) => r.status === "failed").map((r) => r.id);
  let failedSteps: FailedStep[] = [];
  if (failedIds.length) {
    const { data: steps, error: stepErr } = await sb.from("run_steps").select("run_id, position, label, error").eq("workspace_id", workspaceId).in("run_id", failedIds).eq("status", "failed");
    if (stepErr) throw new Error(stepErr.message);
    failedSteps = (steps ?? []) as FailedStep[];
  }
  return ids.filter((id) => byId.has(id)).map((id) => outcomeOf(byId.get(id)!, byId, failedSteps));
}
