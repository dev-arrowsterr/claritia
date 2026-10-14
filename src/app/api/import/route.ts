import { requireUser } from "@/lib/serverAuth";
import { importFiles } from "@/lib/transfer";

const MAX_FILES = 200;
const MAX_BYTES = 2_000_000;

/**
 * Import tests: POST { projectId, files: [{ name, text }] }. Claritia YAML files and Playwright specs. A name already
 * in the project gets " (imported)" added, so nothing is overwritten.
 */
export async function POST(request: Request) {
  const auth = await requireUser(request);
  if ("denied" in auth) return auth.denied;
  const body = (await request.json().catch(() => ({}))) as { projectId?: unknown; files?: unknown };
  if (typeof body.projectId !== "string") return Response.json({ error: "Missing project." }, { status: 400 });
  if (!Array.isArray(body.files) || !body.files.length) return Response.json({ error: "Pick .yaml test files or Playwright specs." }, { status: 400 });
  if (body.files.length > MAX_FILES) return Response.json({ error: `Up to ${MAX_FILES} files at once.` }, { status: 400 });
  const files = body.files.map((f) => ({ name: String((f as { name?: unknown }).name ?? ""), text: String((f as { text?: unknown }).text ?? "") }));
  if (files.reduce((n, f) => n + f.text.length, 0) > MAX_BYTES) return Response.json({ error: "The files are over 2 MB together." }, { status: 400 });

  const [{ data: project }, { data: blocks }, { data: existing }] = await Promise.all([
    auth.sb.from("projects").select("id").eq("id", body.projectId).maybeSingle(),
    auth.sb.from("blocks").select("id, name").eq("project_id", body.projectId),
    auth.sb.from("tests").select("name").eq("project_id", body.projectId),
  ]);
  if (!project) return Response.json({ error: "Project not found." }, { status: 404 });
  const result = importFiles(files, (blocks ?? []) as { id: string; name: string }[]);

  const taken = new Set(((existing ?? []) as { name: string }[]).map((t) => t.name.toLowerCase()));
  const rows = result.tests.map((t) => {
    let name = t.name;
    for (let n = 1; taken.has(name.toLowerCase()); n++) name = `${t.name.slice(0, 100)} (imported${n > 1 ? ` ${n}` : ""})`;
    taken.add(name.toLowerCase());
    return { project_id: body.projectId, name, use_case: t.use_case, priority: t.priority, steps: t.steps, lock: t.lock };
  });
  if (rows.length) {
    const { error } = await auth.sb.from("tests").insert(rows);
    if (error) return Response.json({ error: error.message }, { status: 400 });
  }
  return Response.json({ imported: rows.map((r) => r.name), skipped: result.skipped });
}
