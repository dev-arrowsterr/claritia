import { requireKey } from "@/lib/apiAuth";

/** The workspace's projects and their environments. */
export async function GET(request: Request) {
  const caller = await requireKey(request);
  if ("denied" in caller) return caller.denied;
  const { sb, workspaceId } = caller;
  const [projects, envs] = await Promise.all([
    sb.from("projects").select("id, name, created_at").eq("workspace_id", workspaceId).order("created_at"),
    sb.from("environments").select("id, project_id, name, base_url").eq("workspace_id", workspaceId).order("created_at"),
  ]);
  const error = projects.error ?? envs.error;
  if (error) return Response.json({ error: error.message }, { status: 500 });
  const rows = (envs.data ?? []) as { id: string; project_id: string; name: string; base_url: string }[];
  return Response.json({
    projects: (projects.data ?? []).map((p) => ({
      id: p.id,
      name: p.name,
      environments: rows.filter((e) => e.project_id === p.id).map(({ id, name, base_url }) => ({ id, name, base_url })),
    })),
  });
}
