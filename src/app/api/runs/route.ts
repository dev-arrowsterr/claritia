import { firstError, parseLock } from "@/lib/lock";
import { requireUser } from "@/lib/serverAuth";

/**
 * Start a run of a test. Steps with no code are written by the runner during the run.
 * Checks the saved code and the secrets it needs first, so problems show up here with a plain message, not as a failed run.
 */
export async function POST(request: Request) {
  const auth = await requireUser(request);
  if ("denied" in auth) return auth.denied;
  const { sb } = auth;
  const body = (await request.json().catch(() => ({}))) as { testId?: unknown; environmentId?: unknown };
  if (typeof body.testId !== "string") return Response.json({ error: "Missing test." }, { status: 400 });

  const { data: test, error } = await sb.from("tests").select("id, project_id, steps, lock").eq("id", body.testId).maybeSingle();
  if (error) return Response.json({ error: error.message }, { status: 500 });
  if (!test) return Response.json({ error: "Test not found." }, { status: 404 });

  const envQuery = sb.from("environments").select("id, name").eq("project_id", test.project_id).order("created_at").limit(1);
  const { data: envs, error: envError } = typeof body.environmentId === "string" ? await sb.from("environments").select("id, name").eq("id", body.environmentId).eq("project_id", test.project_id) : await envQuery;
  if (envError) return Response.json({ error: envError.message }, { status: 500 });
  const env = envs?.[0];
  if (!env) return Response.json({ error: "Add an environment to this project in Environments first." }, { status: 400 });

  if (!Array.isArray(test.steps) || !test.steps.length) return Response.json({ error: "Add a step first." }, { status: 400 });
  const parsed = parseLock(test.lock?.trim() ? test.lock : "test('x', async ({ page }) => {});");
  if (!parsed.ok) return Response.json({ error: `Fix the code first. ${firstError(parsed)}` }, { status: 400 });

  if (parsed.secrets.length) {
    const { data: have } = await sb.from("env_secrets").select("name").eq("environment_id", env.id).in("name", parsed.secrets);
    const names = new Set((have ?? []).map((r) => r.name as string));
    const missing = parsed.secrets.filter((s) => !names.has(s));
    if (missing.length) return Response.json({ error: `Add ${missing.join(", ")} to ${env.name} in Environments.` }, { status: 400 });
  }

  const { data: runId, error: runError } = await sb.rpc("start_run", { p_test: test.id, p_env: env.id });
  if (runError) return Response.json({ error: runError.message }, { status: /five runs/i.test(runError.message) ? 429 : 400 });
  return Response.json({ id: runId });
}
