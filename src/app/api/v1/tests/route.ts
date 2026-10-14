import { findProject, requireKey } from "@/lib/apiAuth";

/** A project's tests: GET /api/v1/tests?project=<id or name>. */
export async function GET(request: Request) {
  const caller = await requireKey(request);
  if ("denied" in caller) return caller.denied;
  const project = await findProject(caller, new URL(request.url).searchParams.get("project"));
  if ("denied" in project) return project.denied;
  const { data, error } = await caller.sb.from("tests").select("id, name, use_case, priority, steps, updated_at").eq("workspace_id", caller.workspaceId).eq("project_id", project.id).order("use_case").order("name");
  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({
    project,
    tests: (data ?? []).map((t) => ({ id: t.id, name: t.name, use_case: t.use_case, priority: t.priority, steps: Array.isArray(t.steps) ? t.steps.length : 0, updated_at: t.updated_at })),
  });
}
