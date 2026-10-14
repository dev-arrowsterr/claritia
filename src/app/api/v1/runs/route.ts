import { isUuid, requireKey } from "@/lib/apiAuth";
import { startRuns, type StartInput } from "@/lib/apiRuns";
import { loadOutcomes } from "@/lib/runOutcomes";

/**
 * Start runs: POST /api/v1/runs { project, environment?, tests?: [id or name], use_case?, base_url? }.
 * With no tests and no use case, runs every test in the project that has steps. base_url runs them on another
 * address, such as a preview deploy, with the environment's secrets.
 */
export async function POST(request: Request) {
  const caller = await requireKey(request);
  if ("denied" in caller) return caller.denied;
  const body = (await request.json().catch(() => ({}))) as StartInput;
  const result = await startRuns(caller, body, "api");
  if ("error" in result) return Response.json({ error: result.error }, { status: result.status });
  return Response.json(result, { status: 201 });
}

/** Where runs stand: GET /api/v1/runs?ids=<id>,<id>. A flaky failure's outcome is its re-run's. */
export async function GET(request: Request) {
  const caller = await requireKey(request);
  if ("denied" in caller) return caller.denied;
  const ids = [...new Set((new URL(request.url).searchParams.get("ids") ?? "").split(",").map((s) => s.trim()).filter(Boolean))];
  if (!ids.length) return Response.json({ error: "Pass the run ids: ?ids=<id>,<id>." }, { status: 400 });
  if (ids.length > 100 || !ids.every(isUuid)) return Response.json({ error: "Pass up to 100 run ids." }, { status: 400 });
  let runs;
  try {
    runs = await loadOutcomes(caller.sb, caller.workspaceId, ids);
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
  const missing = ids.find((id) => !runs.some((r) => r.id === id));
  if (missing) return Response.json({ error: `Run ${missing} not found.` }, { status: 404 });
  return Response.json({ done: runs.every((r) => r.done), runs });
}
