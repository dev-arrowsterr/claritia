import { requireUser } from "@/lib/serverAuth";
import { slug } from "@/lib/testfile";
import { exportFiles, zipFiles, type ExportTest } from "@/lib/transfer";

/** A project's tests as a zip of YAML files, Playwright specs, a config and a README: GET /api/export?projectId=... */
export async function GET(request: Request) {
  const auth = await requireUser(request);
  if ("denied" in auth) return auth.denied;
  const projectId = new URL(request.url).searchParams.get("projectId");
  if (!projectId) return Response.json({ error: "Missing project." }, { status: 400 });
  // Row level security: only the caller's own projects come back.
  const [project, tests, blocks, envs] = await Promise.all([
    auth.sb.from("projects").select("name").eq("id", projectId).maybeSingle<{ name: string }>(),
    auth.sb.from("tests").select("name, use_case, priority, steps, lock").eq("project_id", projectId).order("use_case").order("name"),
    auth.sb.from("blocks").select("id, name").eq("project_id", projectId),
    auth.sb.from("environments").select("base_url").eq("project_id", projectId).order("created_at").limit(1),
  ]);
  const error = project.error ?? tests.error ?? blocks.error ?? envs.error;
  if (error) return Response.json({ error: error.message }, { status: 500 });
  if (!project.data) return Response.json({ error: "Project not found." }, { status: 404 });
  const files = exportFiles(project.data.name, (envs.data?.[0] as { base_url: string } | undefined)?.base_url ?? "http://localhost:3000", (tests.data ?? []) as ExportTest[], (blocks.data ?? []) as { id: string; name: string }[]);
  return new Response(Buffer.from(zipFiles(files)), {
    headers: { "content-type": "application/zip", "content-disposition": `attachment; filename="${slug(project.data.name)}-claritia-tests.zip"` },
  });
}
