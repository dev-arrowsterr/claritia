import "server-only";
import { resolveProject, type ApiCaller, type ApiProject, type Problem } from "./apiAuth.ts";
import { firstError, parseLock } from "./lock.ts";

const MAX_RUNS = 50;

type TestRow = { id: string; name: string; use_case: string; steps: unknown; lock: string | null };
export type StartInput = { project?: unknown; environment?: unknown; tests?: unknown; use_case?: unknown; base_url?: unknown };
export type Started = { project: ApiProject; environment: { id: string; name: string }; base_url: string | null; runs: { id: string; test_id: string; test: string }[] };

/**
 * Start runs of a project's tests with an API key, for the REST API and the MCP server. With no tests and no use
 * case, runs every test that has steps. Checks each test's code and the secrets it needs first, so problems come
 * back as a plain message instead of a failed run.
 */
export async function startRuns(caller: ApiCaller, input: StartInput, trigger: "api" | "mcp"): Promise<Started | Problem> {
  const { sb, workspaceId, keyId } = caller;
  const bad = (error: string, status = 400): Problem => ({ error, status });

  const project = await resolveProject(caller, input.project);
  if ("error" in project) return project;

  let baseUrl: string | null = null;
  if (input.base_url !== undefined && input.base_url !== null && input.base_url !== "") {
    if (typeof input.base_url !== "string" || !/^https?:\/\/[^\s/]+/.test(input.base_url.trim())) return bad("base_url must be a web address, like https://pr-42.example.com.");
    baseUrl = input.base_url.trim();
  }

  const { data: envRows, error: envErr } = await sb.from("environments").select("id, name").eq("workspace_id", workspaceId).eq("project_id", project.id).order("created_at");
  if (envErr) return bad(envErr.message, 500);
  const envs = (envRows ?? []) as { id: string; name: string }[];
  if (!envs.length) return bad(`Add an environment to ${project.name} in Environments first.`);
  let env = envs[0]!;
  if (input.environment !== undefined && input.environment !== null && input.environment !== "") {
    if (typeof input.environment !== "string") return bad("The environment must be an id or a name.");
    const want = input.environment.trim().toLowerCase();
    const found = envs.find((e) => e.id === input.environment) ?? envs.find((e) => e.name.toLowerCase() === want);
    if (!found) return bad(`Environment ${input.environment} not found. ${project.name} has: ${envs.map((e) => e.name).join(", ")}.`, 404);
    env = found;
  }

  const { data: testRows, error: testErr } = await sb.from("tests").select("id, name, use_case, steps, lock").eq("workspace_id", workspaceId).eq("project_id", project.id).order("use_case").order("name");
  if (testErr) return bad(testErr.message, 500);
  const all = (testRows ?? []) as TestRow[];
  const hasSteps = (t: TestRow) => Array.isArray(t.steps) && t.steps.length > 0;

  let picked: TestRow[];
  if (input.tests !== undefined && input.tests !== null) {
    if (!Array.isArray(input.tests) || !input.tests.length || input.tests.some((x) => typeof x !== "string" || !x.trim())) return bad("tests must be a list of test ids or names.");
    picked = [];
    for (const ref of input.tests as string[]) {
      const want = ref.trim().toLowerCase();
      const t = all.find((x) => x.id === ref.trim()) ?? all.find((x) => x.name.toLowerCase() === want);
      if (!t) return bad(`Test ${ref} not found in ${project.name}.`, 404);
      if (!hasSteps(t)) return bad(`${t.name} has no steps yet.`);
      if (!picked.includes(t)) picked.push(t);
    }
  } else if (input.use_case !== undefined && input.use_case !== null && input.use_case !== "") {
    if (typeof input.use_case !== "string") return bad("use_case must be a name.");
    const want = input.use_case.trim().toLowerCase();
    picked = all.filter((t) => t.use_case.toLowerCase() === want && hasSteps(t));
    if (!picked.length) return bad(`No tests with steps in the use case ${input.use_case}.`, 404);
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

  const { data, error } = await sb.rpc("api_start_runs", { p_key: keyId, p_project: project.id, p_env: env.id, p_tests: picked.map((t) => t.id), p_trigger: trigger, p_base_url: baseUrl });
  if (error) return bad(error.message, /already waiting|used up/i.test(error.message) ? 429 : 400);
  const runs = ((data ?? []) as { run_id: string; test_id: string; test_name: string }[]).map((r) => ({ id: r.run_id, test_id: r.test_id, test: r.test_name }));
  return { project, environment: env, base_url: baseUrl, runs };
}
