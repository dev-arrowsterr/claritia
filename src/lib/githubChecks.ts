import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { checkSummary, conclusionOf, type EventPlan } from "./github.ts";
import { gh, installationToken } from "./githubApp.ts";
import { loadOutcomes } from "./runOutcomes.ts";
import { APP_URL } from "./site.ts";

type Link = { id: string; workspace_id: string; installation_id: number; repo_full_name: string; run_on: "pull_request" | "preview"; environments: { name: string; base_url: string } | null };
type Check = { id: string; workspace_id: string; link_id: string; installation_id: number; repo_full_name: string; head_sha: string; pr_number: number | null; base_url: string; run_ids: string[]; check_run_id: number | null; status: "pending" | "done"; conclusion: string | null; finished_count: number; error: string | null; created_at: string };

const LINK_FIELDS = "id, workspace_id, installation_id, repo_full_name, run_on, environments(name, base_url)";
/** A check that hasn't finished in 3 hours is closed as timed out. */
const CHECK_TIMEOUT_MS = 3 * 3_600_000;

const checkName = (link: Link) => `Claritia (${link.run_on === "preview" ? "preview" : (link.environments?.name ?? "tests")})`;
const where = (check: Check) => check.base_url.replace(/^https?:\/\//, "").replace(/\/$/, "");

/** Post a new check's check run on GitHub, and save its id. */
async function postCheck(sb: SupabaseClient, check: Check, link: Link) {
  const token = await installationToken(check.installation_id);
  const body: Record<string, unknown> = { name: checkName(link), head_sha: check.head_sha, external_id: check.id, details_url: `${APP_URL}/runs` };
  if (check.status === "done") {
    Object.assign(body, { status: "completed", conclusion: check.conclusion ?? "neutral", completed_at: new Date().toISOString(), output: { title: check.error ?? "Nothing to run", summary: check.error ?? "Nothing to run." } });
  } else {
    const n = check.run_ids.length;
    Object.assign(body, { status: "in_progress", started_at: new Date().toISOString(), output: { title: `Running ${n} ${n === 1 ? "test" : "tests"}`, summary: `Running on ${where(check)}.` } });
  }
  const run = await gh<{ id: number }>("POST", `/repos/${check.repo_full_name}/check-runs`, token, body);
  await sb.from("github_checks").update({ check_run_id: run.id }).eq("id", check.id);
  check.check_run_id = run.id;
}

async function startOne(sb: SupabaseClient, link: Link, sha: string, pr: number | null, url: string | null) {
  const { data, error } = await sb.rpc("github_start_check", { p_link: link.id, p_sha: sha, p_pr: pr, p_base_url: url });
  if (error) throw new Error(error.message);
  for (const check of (data ?? []) as Check[]) await postCheck(sb, check, link);
}

/** Act on a GitHub event. Errors for one link don't stop the others; they're returned. */
export async function handlePlan(sb: SupabaseClient, plan: EventPlan): Promise<string[]> {
  const errors: string[] = [];
  const each = async (links: Link[], fn: (l: Link) => Promise<void>) => {
    for (const l of links) await fn(l).catch((e) => errors.push(`${l.repo_full_name}: ${e instanceof Error ? e.message : e}`));
  };

  if (plan.kind === "pull_request" || plan.kind === "preview") {
    const { data, error } = await sb.from("github_links").select(LINK_FIELDS).eq("installation_id", plan.installationId).eq("repo_id", plan.repoId).eq("run_on", plan.kind).eq("enabled", true);
    if (error) return [error.message];
    await each((data ?? []) as unknown as Link[], (l) => startOne(sb, l, plan.sha, plan.kind === "pull_request" ? plan.pr : null, plan.kind === "preview" ? plan.url : null));
  } else if (plan.kind === "rerun") {
    const { data: old } = await sb.from("github_checks").select("link_id, head_sha, pr_number, base_url").eq("installation_id", plan.installationId).eq("check_run_id", plan.checkRunId).maybeSingle<Pick<Check, "link_id" | "head_sha" | "pr_number" | "base_url">>();
    if (!old) return [];
    const { data: link } = await sb.from("github_links").select(LINK_FIELDS).eq("id", old.link_id).maybeSingle<Link>();
    if (link) await each([link], (l) => startOne(sb, l, old.head_sha, old.pr_number, old.base_url));
  } else if (plan.kind === "uninstalled") {
    const { error } = await sb.from("github_installations").delete().eq("id", plan.installationId);
    if (error) errors.push(error.message);
  } else if (plan.kind === "repos_removed" && plan.repoIds.length) {
    const { error } = await sb.from("github_links").update({ enabled: false }).eq("installation_id", plan.installationId).in("repo_id", plan.repoIds);
    if (error) errors.push(error.message);
  }
  return errors;
}

/** Bring every open check up to date on GitHub: progress while its runs go, the result once they're done. */
export async function syncChecks(sb: SupabaseClient): Promise<{ synced: number; errors: string[] }> {
  const errors: string[] = [];
  const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
  const [open, unposted] = await Promise.all([
    sb.from("github_checks").select("*").eq("status", "pending").order("created_at").limit(50),
    sb.from("github_checks").select("*").eq("status", "done").is("check_run_id", null).gte("created_at", hourAgo).limit(20),
  ]);
  if (open.error || unposted.error) return { synced: 0, errors: [(open.error ?? unposted.error)!.message] };
  const checks = [...(open.data ?? []), ...(unposted.data ?? [])] as Check[];
  let synced = 0;
  for (const check of checks) {
    try {
      const { data: link } = await sb.from("github_links").select(LINK_FIELDS).eq("id", check.link_id).maybeSingle<Link>();
      if (!link) continue;
      if (!check.check_run_id) await postCheck(sb, check, link);
      if (check.status === "done") continue;

      const runs = await loadOutcomes(sb, check.workspace_id, check.run_ids);
      const finished = runs.filter((r) => r.done).length;
      const allDone = runs.length > 0 && finished === runs.length;
      const timedOut = !allDone && Date.now() - Date.parse(check.created_at) > CHECK_TIMEOUT_MS;
      const token = await installationToken(check.installation_id);
      const summary = checkSummary(runs, where(check));
      const now = new Date().toISOString();

      if (allDone || timedOut) {
        const { conclusion, title } = timedOut ? { conclusion: "timed_out" as const, title: `${finished} of ${runs.length} finished in 3 hours` } : conclusionOf(runs);
        await gh("PATCH", `/repos/${check.repo_full_name}/check-runs/${check.check_run_id}`, token, { status: "completed", conclusion, completed_at: now, output: { title, summary } });
        await sb.from("github_checks").update({ status: "done", conclusion, finished_count: finished, synced_at: now }).eq("id", check.id);
      } else {
        if (finished !== check.finished_count) {
          await gh("PATCH", `/repos/${check.repo_full_name}/check-runs/${check.check_run_id}`, token, { output: { title: `${finished} of ${runs.length} finished`, summary } });
        }
        await sb.from("github_checks").update({ finished_count: finished, synced_at: now }).eq("id", check.id);
      }
      synced++;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      errors.push(`${check.repo_full_name}@${check.head_sha.slice(0, 7)}: ${message}`);
      await sb.from("github_checks").update({ error: message.slice(0, 500), synced_at: new Date().toISOString() }).eq("id", check.id);
    }
  }
  return { synced, errors };
}
