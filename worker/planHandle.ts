// What the runner does with one claimed plan: gather the app map, the existing tests and blocks, ask the Planner,
// and save its proposals for people to accept or dismiss.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { PageElements } from "./explorer.ts";
import type { PlanPage, Planner } from "./planner.ts";

export type Plan = { id: string; workspace_id: string; project_id: string; notes: string; attempts: number };
/** A plan counts as this many AI credits: it's one large call. */
export const PLAN_CREDITS = 10;

export async function handlePlan(sb: SupabaseClient, plan: Plan, opts: { workerId: string; planner?: Planner; log?: (...a: unknown[]) => void }) {
  const log = opts.log ?? (() => undefined);
  const finish = (fields: Record<string, unknown>) =>
    sb
      .from("plans")
      .update({ ...fields, finished_at: new Date().toISOString(), locked_at: null })
      .eq("id", plan.id)
      .eq("locked_by", opts.workerId);
  try {
    if (!opts.planner) {
      await finish({ status: "error", error: "This runner has no ANTHROPIC_API_KEY, so it can't plan tests." });
      return;
    }
    const [pages, links, tests, blocks, envs] = await Promise.all([
      sb.from("app_pages").select("id, pattern, name, purpose, title, elements").eq("project_id", plan.project_id).order("depth").limit(400),
      sb.from("app_links").select("from_page, to_page").eq("project_id", plan.project_id).limit(5000),
      sb.from("tests").select("name, use_case").eq("project_id", plan.project_id),
      sb.from("blocks").select("id, name").eq("project_id", plan.project_id),
      sb.from("environments").select("base_url").eq("project_id", plan.project_id).order("created_at").limit(1),
    ]);
    const err = pages.error ?? links.error ?? tests.error ?? blocks.error ?? envs.error;
    if (err) throw new Error(err.message);
    const pageRows = (pages.data ?? []) as { id: string; pattern: string; name: string | null; purpose: string | null; title: string | null; elements: Partial<PageElements> }[];
    const patternOf = new Map(pageRows.map((p) => [p.id, p.pattern]));
    const linksFrom = new Map<string, string[]>();
    for (const l of (links.data ?? []) as { from_page: string; to_page: string }[]) {
      const to = patternOf.get(l.to_page);
      if (to) linksFrom.set(l.from_page, [...(linksFrom.get(l.from_page) ?? []), to]);
    }
    const blockRows = (blocks.data ?? []) as { id: string; name: string }[];
    const mapPages: PlanPage[] = pageRows.map((p) => ({ pattern: p.pattern, name: p.name, purpose: p.purpose, title: p.title, forms: p.elements.forms ?? [], buttons: p.elements.buttons ?? [], links: linksFrom.get(p.id) ?? [] }));

    const r = await opts.planner({
      site: ((envs.data ?? []) as { base_url: string }[])[0]?.base_url ?? "",
      pages: mapPages,
      tests: (tests.data ?? []) as { name: string; use_case: string }[],
      blocks: blockRows.map((b) => b.name),
      notes: plan.notes,
    });

    const blockId = new Map(blockRows.map((b) => [b.name, b.id]));
    const rows = r.proposals.map((p) => ({
      workspace_id: plan.workspace_id,
      project_id: plan.project_id,
      plan_id: plan.id,
      name: p.name,
      use_case: p.use_case,
      priority: p.priority,
      reason: p.reason || null,
      pages: p.pages,
      steps: p.steps.map((s) => (s.kind === "use" ? { kind: "use", block: blockId.get(s.block) } : s)).filter((s) => s.kind !== "use" || s.block),
    }));
    if (rows.length) {
      const { error } = await sb.from("test_proposals").insert(rows);
      if (error) throw new Error(error.message);
    }
    await finish({ status: "done", proposals: rows.length, ai_calls: PLAN_CREDITS, ai_input_tokens: r.usage.input, ai_output_tokens: r.usage.output });
    log(`Plan ${plan.id}: ${rows.length} proposals.`);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    log(`Plan ${plan.id}: error: ${message}`);
    await finish({ status: "error", error: message.slice(0, 500) });
  }
}
