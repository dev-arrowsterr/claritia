import { findProject, isUuid, requireKey } from "@/lib/apiAuth";
import { firstError, parseLock } from "@/lib/lock";
import { loadOutcomes } from "@/lib/runOutcomes";

const MAX_RUNS = 50;

type TestRow = { id: string; name: string; use_case: string; steps: unknown; lock: string | null };

/**
 * Start runs: POST /api/v1/runs { project, environment?, tests?: [id or name], use_case? }.
 * With no tests and no use case, runs every test in the project that has steps.
 * Checks each test's code and the secrets it needs first, so problems come back here with a plain message.
 */
export async function POST(request: Request) {
  const caller = await requireKey(request);
  if ("denied" in caller) return caller.denied;
  const { sb, workspaceId, keyId } = caller;
  const body = (await request.json().catch(() => ({}))) as { project?: unknown; environment?: unknown; tests?: unknown; use_case?: unknown };
  const bad = (error: string, status = 400) => Response.json({ error }, { status });

  const project = await findProject(caller, body.project);
  if ("denied" in project) return project.denied;

  const { data: envRows, error: envErr } = await sb.from("environments").select("id, name").eq("workspace_id", workspaceId).eq("project_id", project.id).order("created_at");
  if (envErr) return bad(envErr.message, 500);
  const envs = (envRows ?? []) as { id: string; name: string }[];
  if (!envs.length) return bad(`Add an environment to ${project.name} in Environments first.`);
  let env = envs[0]!;
  if (body.environment !== undefined && body.environment !== null && body.environment !== "") {
    if (typeof body.environment !== "string") return bad("The environment must be an id or a name.");
    const want = body.environment.trim().toLowerCase();
    const found = envs.find((e) => e.id === body.environment) ?? envs.find((e) => e.name.toLowerCase() === want);
    if (!found) return bad(`Environment ${body.environment} not found. ${project.name} has: ${envs.map((e) => e.name).join(", ")}.`, 404);
    env = found;
  }

  const { data: testRows, error: testErr } = await sb.from("tests").select("id, name, use_case, steps, lock").eq("workspace_id", workspaceId).eq("project_id", project.id).order("use_case").order("name");
  if (testErr) return bad(testErr.message, 500);
  const all = (testRows ?? []) as TestRow[];
  const hasSteps = (t: TestRow) => Array.isArray(t.steps) && t.steps.length > 0;

  let picked: TestRow[];
  if (body.tests !== undefined) {
    if (!Array.isArray(body.tests) || !body.tests.length || body.tests.some((x) => typeof x !== "string" || !x.trim())) return bad("tests must be a list of test ids or names.");
    picked = [];
    for (const ref of body.tests as string[]) {
      const want = ref.trim().toLowerCase();
      const t = all.find((x) => x.id === ref.trim()) ?? all.find((x) => x.name.toLowerCase() === want);
      if (!t) return bad(`Test ${ref} not found in ${project.name}.`, 404);
      if (!hasSteps(t)) return bad(`${t.name} has no steps yet.`);
      if (!picked.includes(t)) picked.push(t);
    }
  } else if (body.use_case !== undefined) {
    if (typeof body.use_case !== "string" || !body.use_case.trim()) return bad("use_case must be a name.");
    const want = body.use_case.trim().toLowerCase();
    picked = all.filter((t) => t.use_case.toLowerCase() === want && hasSteps(t));
    if (!picked.length) return bad(`No tests with steps in the use case ${body.use_case}.`, 404);
  } else {
    picked = all.filter(hasSteps);
    if (!picked.length) return bad(`${project.name} has no tests with steps yet.`, 404);
  }
  if (picked.length > MAX_RUNS) return bad(`That's ${picked.length} tests. Run up to ${MAX_RUNS} at once: pick a use case or tests.`);

  // Code and secrets, checked before anything is queued.
  const secretsNeeded = new Map<string, string[]>();
  for (const t of picked) {
    const parsed = parseLock(t.lock?.trim() ? t.lock : "test('x', async ({ page }) => {});");
    if (!parsed.ok) return bad(`Fix the code of ${t.name} first. ${firstError(parsed)}`);
    if (parsed.secrets.length) secretsNeeded.set(t.name, parsed.secrets);
  }
  if (secretsNeeded.size) {
    const names = [...new Set([...secretsNeeded.values()].flat())];
    const { data: have, error } = await sb.from("env_secrets").select("name").eq("environment_id", env.id).in("name", names);
    if (error) return bad(error.message, 500);
    const got = new Set((have ?? []).map((r) => r.name as string));
    for (const [test, needs] of secretsNeeded) {
      const missing = needs.filter((s) => !got.has(s));
      if (missing.length) return bad(`${test} needs ${missing.join(", ")}. Add it to ${env.name} in Environments.`);
    }
  }

  const { data, error } = await sb.rpc("api_start_runs", { p_key: keyId, p_project: project.id, p_env: env.id, p_tests: picked.map((t) => t.id) });
  if (error) return bad(error.message, /already waiting|used up/i.test(error.message) ? 429 : 400);
  const runs = ((data ?? []) as { run_id: string; test_id: string; test_name: string }[]).map((r) => ({ id: r.run_id, test_id: r.test_id, test: r.test_name }));
  return Response.json({ project, environment: env, runs }, { status: 201 });
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
