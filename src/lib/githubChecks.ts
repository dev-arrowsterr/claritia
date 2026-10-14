import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { checkSummary, conclusionOf, type EventPlan } from "./github.ts";
import { gh, installationToken } from "./githubApp.ts";
import { claudePlanner, cleanProposals, type Planner, type PlanPage } from "./planner.ts";
import { claudePicker, selectByRules, selectionFrom, type ChangedFile, type Picker, type Selection } from "./prSelect.ts";
import { loadOutcomes } from "./runOutcomes.ts";
import { APP_URL } from "./site.ts";

type Link = { id: string; workspace_id: string; project_id: string; installation_id: number; repo_full_name: string; run_on: "pull_request" | "preview"; scope: "all" | "use_case"; use_case: string | null; pick_tests: boolean; environments: { name: string; base_url: string } | null };
type Check = { id: string; workspace_id: string; link_id: string; installation_id: number; repo_full_name: string; head_sha: string; pr_number: number | null; base_url: string; run_ids: string[]; check_run_id: number | null; status: "pending" | "done"; conclusion: string | null; finished_count: number; error: string | null; created_at: string; selection: Selection | null };

const LINK_FIELDS = "id, workspace_id, project_id, installation_id, repo_full_name, run_on, scope, use_case, pick_tests, environments(name, base_url)";

/** The AI the GitHub flow uses: Haiku picks the affected tests, Sonnet proposes tests for new flows. Both need ANTHROPIC_API_KEY on the web app. */
export type Deps = { picker?: Picker; planner?: Planner };
export function defaultDeps(): Deps {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) return {};
  return { picker: claudePicker({ apiKey }), planner: claudePlanner({ apiKey, model: "claude-sonnet-5-5" }) };
}

/** Why these tests ran, for the top of the check. */
export function selectionText(s: Selection | null): string {
  if (!s) return "";
  if (s.mode !== "picked") return s.reason;
  return [`Ran ${s.tests.length} ${s.tests.length === 1 ? "test" : "tests"} this change can affect.${s.reason ? ` ${s.reason}` : ""}`, ...s.tests.map((t) => `- **${t.name}**${t.why ? `: ${t.why}` : ""}`)].join("\n");
}
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
    const why = selectionText(check.selection);
    Object.assign(body, { status: "in_progress", started_at: new Date().toISOString(), output: { title: `Running ${n} ${n === 1 ? "test" : "tests"}`, summary: `${why ? `${why}\n\n` : ""}Running on ${where(check)}.` } });
  }
  const run = await gh<{ id: number }>("POST", `/repos/${check.repo_full_name}/check-runs`, token, body);
  await sb.from("github_checks").update({ check_run_id: run.id }).eq("id", check.id);
  check.check_run_id = run.id;
}

type Pick = { selection: Selection | null; testIds: string[] | null; aiCalls: number; newFlows: string[]; files: ChangedFile[] };
const ALL: Pick = { selection: null, testIds: null, aiCalls: 0, newFlows: [], files: [] };

/** Pick the tests a pull request can affect. Anything unclear runs every test. */
async function pickTests(sb: SupabaseClient, link: Link, sha: string, pr: number | null, deps: Deps): Promise<Pick> {
  if (!link.pick_tests || !deps.picker) return ALL;
  const all = (reason: string): Pick => ({ ...ALL, selection: { mode: "all", reason } });
  const token = await installationToken(link.installation_id);
  let number = pr;
  if (!number) {
    const pulls = await gh<{ number: number; state: string }[]>("GET", `/repos/${link.repo_full_name}/commits/${sha}/pulls`, token).catch(() => []);
    number = pulls.find((p) => p.state === "open")?.number ?? null;
    if (!number) return all("No open pull request has this commit, so every test runs.");
  }
  let files: ChangedFile[];
  try {
    files = await gh<ChangedFile[]>("GET", `/repos/${link.repo_full_name}/pulls/${number}/files?per_page=100`, token);
  } catch {
    return all("The pull request's files couldn't be read, so every test runs.");
  }
  const byRule = selectByRules(files);
  if (byRule) return { ...ALL, files, selection: byRule, testIds: byRule.mode === "none" ? [] : null };

  let q = sb.from("tests").select("id, name, use_case, steps").eq("project_id", link.project_id);
  if (link.scope === "use_case" && link.use_case) q = q.eq("use_case", link.use_case);
  const [{ data: testRows }, { data: pageRows }] = await Promise.all([q, sb.from("app_pages").select("pattern, name").eq("project_id", link.project_id).limit(200)]);
  const tests = ((testRows ?? []) as { id: string; name: string; use_case: string; steps: { kind: string; text?: string }[] }[])
    .filter((t) => Array.isArray(t.steps) && t.steps.length)
    .map((t) => ({ id: t.id, name: t.name, use_case: t.use_case, steps: t.steps.map((x) => (x.kind === "check" ? `check: ${x.text}` : x.kind === "use" ? "use a block" : String(x.text))) }));
  if (!tests.length) return { ...ALL, files };
  try {
    const reply = await deps.picker(files, tests, (pageRows ?? []) as { pattern: string; name: string | null }[]);
    const selection = selectionFrom(reply, tests);
    return { selection, testIds: selection.mode === "picked" ? selection.tests.map((t) => t.id) : null, aiCalls: 1, newFlows: reply.newFlows, files };
  } catch {
    return { ...all("The test picker couldn't decide, so every test runs."), files };
  }
}

/** Proposed tests for the new flows a pull request adds, on the Tests page with the pull request named. */
async function proposeForPr(sb: SupabaseClient, link: Link, pr: number, title: string, newFlows: string[], files: ChangedFile[], planner: Planner) {
  const [pages, tests, pending, blocks, links] = await Promise.all([
    sb.from("app_pages").select("id, pattern, name, purpose, title, elements").eq("project_id", link.project_id).limit(200),
    sb.from("tests").select("name, use_case").eq("project_id", link.project_id),
    sb.from("test_proposals").select("name, use_case").eq("project_id", link.project_id).eq("status", "pending"),
    sb.from("blocks").select("id, name").eq("project_id", link.project_id),
    sb.from("app_links").select("from_page, to_page").eq("project_id", link.project_id).limit(3000),
  ]);
  const pageRows = (pages.data ?? []) as { id: string; pattern: string; name: string | null; purpose: string | null; title: string | null; elements: { forms?: PlanPage["forms"]; buttons?: string[] } }[];
  const patterns = new Map(pageRows.map((p) => [p.id, p.pattern]));
  const linksFrom = new Map<string, string[]>();
  for (const l of (links.data ?? []) as { from_page: string; to_page: string }[]) if (patterns.has(l.to_page)) linksFrom.set(l.from_page, [...(linksFrom.get(l.from_page) ?? []), patterns.get(l.to_page)!]);
  const blockRows = (blocks.data ?? []) as { id: string; name: string }[];
  const existing = [...((tests.data ?? []) as { name: string; use_case: string }[]), ...((pending.data ?? []) as { name: string; use_case: string }[])];
  const change = [`Pull request #${pr}: ${title}`, `New flows: ${newFlows.join("; ")}`, "Changed files:", ...files.slice(0, 60).map((f) => `- ${f.filename} (${f.status}, +${f.additions} -${f.deletions})`)].join("\n");
  const r = await planner({
    site: link.environments?.base_url ?? "",
    pages: pageRows.map((p) => ({ pattern: p.pattern, name: p.name, purpose: p.purpose, title: p.title, forms: p.elements.forms ?? [], buttons: p.elements.buttons ?? [], links: linksFrom.get(p.id) ?? [] })),
    tests: existing,
    blocks: blockRows.map((b) => b.name),
    notes: "",
    change,
  });
  const proposals = cleanProposals(r.proposals, { site: "", pages: [], tests: existing, blocks: blockRows.map((b) => b.name), notes: "" }).slice(0, 5);
  const ids = new Map(blockRows.map((b) => [b.name, b.id]));
  const { data: plan } = await sb.from("plans").insert({ workspace_id: link.workspace_id, project_id: link.project_id, notes: `PR #${pr} in ${link.repo_full_name}`, status: "done", proposals: proposals.length, ai_calls: 5, ai_input_tokens: r.usage.input, ai_output_tokens: r.usage.output, finished_at: new Date().toISOString() }).select("id").single<{ id: string }>();
  if (!proposals.length) return;
  await sb.from("test_proposals").insert(
    proposals.map((p) => ({
      workspace_id: link.workspace_id,
      project_id: link.project_id,
      plan_id: plan?.id ?? null,
      name: p.name,
      use_case: p.use_case,
      priority: p.priority,
      reason: p.reason || null,
      pages: p.pages,
      source: `PR #${pr} in ${link.repo_full_name}`,
      steps: p.steps.map((s) => (s.kind === "use" ? { kind: "use", block: ids.get(s.block) } : s)).filter((s) => s.kind !== "use" || s.block),
    })),
  );
}

async function startOne(sb: SupabaseClient, link: Link, sha: string, pr: number | null, url: string | null, deps: Deps, opened?: { title: string }) {
  const pick = await pickTests(sb, link, sha, pr, deps);
  const { data, error } = await sb.rpc("github_start_check", { p_link: link.id, p_sha: sha, p_pr: pr, p_base_url: url, p_test_ids: pick.testIds, p_selection: pick.selection, p_ai_calls: pick.aiCalls });
  if (error) throw new Error(error.message);
  for (const check of (data ?? []) as Check[]) await postCheck(sb, check, link);
  // A new pull request that adds flows no test covers gets proposed tests for them. Never blocks the check.
  if (opened && pr && pick.newFlows.length && deps.planner) await proposeForPr(sb, link, pr, opened.title, pick.newFlows, pick.files, deps.planner).catch(() => undefined);
}

/** Act on a GitHub event. Errors for one link don't stop the others; they're returned. */
export async function handlePlan(sb: SupabaseClient, plan: EventPlan, deps: Deps = defaultDeps()): Promise<string[]> {
  const errors: string[] = [];
  const each = async (links: Link[], fn: (l: Link) => Promise<void>) => {
    for (const l of links) await fn(l).catch((e) => errors.push(`${l.repo_full_name}: ${e instanceof Error ? e.message : e}`));
  };

  if (plan.kind === "pull_request" || plan.kind === "preview") {
    const { data, error } = await sb.from("github_links").select(LINK_FIELDS).eq("installation_id", plan.installationId).eq("repo_id", plan.repoId).eq("run_on", plan.kind).eq("enabled", true);
    if (error) return [error.message];
    await each((data ?? []) as unknown as Link[], (l) =>
      plan.kind === "pull_request" ? startOne(sb, l, plan.sha, plan.pr, null, deps, plan.opened ? { title: plan.title } : undefined) : startOne(sb, l, plan.sha, null, plan.url, deps),
    );
  } else if (plan.kind === "rerun") {
    const { data: old } = await sb.from("github_checks").select("link_id, head_sha, pr_number, base_url").eq("installation_id", plan.installationId).eq("check_run_id", plan.checkRunId).maybeSingle<Pick2>();
    if (!old) return [];
    const { data: link } = await sb.from("github_links").select(LINK_FIELDS).eq("id", old.link_id).maybeSingle<Link>();
    if (link) await each([link], (l) => startOne(sb, l, old.head_sha, old.pr_number, l.run_on === "preview" ? old.base_url : null, deps));
  } else if (plan.kind === "uninstalled") {
    const { error } = await sb.from("github_installations").delete().eq("id", plan.installationId);
    if (error) errors.push(error.message);
  } else if (plan.kind === "repos_removed" && plan.repoIds.length) {
    const { error } = await sb.from("github_links").update({ enabled: false }).eq("installation_id", plan.installationId).in("repo_id", plan.repoIds);
    if (error) errors.push(error.message);
  }
  return errors;
}
type Pick2 = { link_id: string; head_sha: string; pr_number: number | null; base_url: string };

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
      const why = selectionText(check.selection);
      const summary = `${why ? `${why}\n\n` : ""}${checkSummary(runs, where(check))}`;
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
