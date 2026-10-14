import { findProject, requireKey } from "@/lib/apiAuth";
import { buildLock, firstError, parseLock } from "@/lib/lock";
import { APP_URL } from "@/lib/site";
import { stepId } from "@/lib/testfile";

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

type RecordedStep = { kind: "do" | "check"; text: string; code: string[] };

/**
 * Save a recorded test: POST /api/v1/tests { project, name, use_case?, steps: [{ kind, text, code: [lines] }] }.
 * The Chrome recorder sends this. Each step's code goes under its step comment; the whole test is checked against what
 * Claritia can run before it's saved. A name already taken gets " (recorded)".
 */
export async function POST(request: Request) {
  const caller = await requireKey(request);
  if ("denied" in caller) return caller.denied;
  const bad = (error: string, status = 400) => Response.json({ error }, { status });
  const body = (await request.json().catch(() => ({}))) as { project?: unknown; name?: unknown; use_case?: unknown; steps?: unknown };
  const project = await findProject(caller, body.project);
  if ("denied" in project) return project.denied;
  const name = typeof body.name === "string" ? body.name.trim().slice(0, 120) : "";
  if (!name) return bad("Name the test.");
  const useCase = typeof body.use_case === "string" && body.use_case.trim() ? body.use_case.trim().slice(0, 60) : "Recorded";
  if (!Array.isArray(body.steps) || !body.steps.length || body.steps.length > 200) return bad("Send 1 to 200 steps.");
  const steps: RecordedStep[] = [];
  for (const raw of body.steps as Record<string, unknown>[]) {
    const kind = raw?.kind === "check" ? "check" : raw?.kind === "do" ? "do" : null;
    const text = typeof raw?.text === "string" ? raw.text.trim().slice(0, 500) : "";
    const code = Array.isArray(raw?.code) ? (raw.code as unknown[]).map(String).slice(0, 20) : [];
    if (!kind || !text || !code.length || code.some((l) => l.length > 2000)) return bad("Each step needs a kind (do or check), text and code.");
    steps.push({ kind, text, code });
  }
  const lock = buildLock(name, steps.map((s) => ({ label: s.kind === "check" ? `check: ${s.text}` : s.text, lines: s.code })));
  const parsed = parseLock(lock);
  if (!parsed.ok) return bad(`The recorded code has a problem: ${firstError(parsed)}`);

  const { data: existing } = await caller.sb.from("tests").select("name").eq("project_id", project.id);
  const taken = new Set(((existing ?? []) as { name: string }[]).map((t) => t.name.toLowerCase()));
  let finalName = name;
  for (let n = 1; taken.has(finalName.toLowerCase()); n++) finalName = `${name.slice(0, 100)} (recorded${n > 1 ? ` ${n}` : ""})`;
  const { data, error } = await caller.sb
    .from("tests")
    .insert({ project_id: project.id, name: finalName, use_case: useCase, steps: steps.map((s) => ({ id: stepId(), kind: s.kind, text: s.text })), lock })
    .select("id, name, version")
    .single<{ id: string; name: string; version: number }>();
  if (error) return bad(error.message, 500);
  return Response.json({ ...data, project, url: `${APP_URL}/tests/${data.id}` }, { status: 201 });
}
