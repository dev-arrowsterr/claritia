import "server-only";
import { isUuid, resolveProject, type ApiCaller } from "./apiAuth.ts";
import { startRuns } from "./apiRuns.ts";
import { mcpServer, ToolError, type Tool } from "./mcpProtocol.ts";
import { resultsText } from "./mcpText.ts";
import { loadOutcomes } from "./runOutcomes.ts";
import { APP_URL } from "./site.ts";
import { fromYaml, TestFileError, toYaml, type BlockRef, type Step } from "./testfile.ts";

type Ctx = ApiCaller & { pollMs?: number };

const MAX_WAIT = 45;
const str = { type: "string" } as const;
const projectArg = { ...str, description: "Project name or id. Needed when the workspace has more than one project." };

async function project(ctx: Ctx, ref: unknown) {
  const p = await resolveProject(ctx, ref);
  if ("error" in p) throw new ToolError(p.error);
  return p;
}

async function blocksOf(ctx: Ctx, projectId: string): Promise<BlockRef[]> {
  const { data, error } = await ctx.sb.from("blocks").select("id, name").eq("workspace_id", ctx.workspaceId).eq("project_id", projectId);
  if (error) throw new Error(error.message);
  return (data ?? []) as BlockRef[];
}

type TestRow = { id: string; project_id: string; name: string; use_case: string; priority: "low" | "medium" | "high"; steps: Step[]; lock: string | null; version: number };
const TEST_FIELDS = "id, project_id, name, use_case, priority, steps, lock, version";

async function findTest(ctx: Ctx, ref: unknown, projectRef: unknown): Promise<TestRow> {
  if (typeof ref !== "string" || !ref.trim()) throw new ToolError("Pass test: the test's name or id.");
  let q = ctx.sb.from("tests").select(TEST_FIELDS).eq("workspace_id", ctx.workspaceId);
  if (projectRef) q = q.eq("project_id", (await project(ctx, projectRef)).id);
  const { data, error } = isUuid(ref.trim()) ? await q.eq("id", ref.trim()) : await q.ilike("name", ref.trim().replace(/[%_\\]/g, "\\$&"));
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as TestRow[];
  if (!rows.length) throw new ToolError(`Test ${ref} not found. Call list_tests to see the tests.`);
  if (rows.length > 1) throw new ToolError(`More than one test is called ${ref}. Pass project, or the test's id.`);
  return rows[0]!;
}

/** Wait for runs to finish, up to `seconds`, checking every few seconds. */
async function waitFor(ctx: Ctx, ids: string[], seconds: number) {
  const until = Date.now() + Math.min(Math.max(seconds, 0), MAX_WAIT) * 1000;
  for (;;) {
    const runs = await loadOutcomes(ctx.sb, ctx.workspaceId, ids);
    if (runs.every((r) => r.done) || Date.now() >= until) return runs;
    await new Promise((r) => setTimeout(r, ctx.pollMs ?? 3000));
  }
}

const tools: Tool<Ctx>[] = [
  {
    name: "list_projects",
    title: "List projects",
    description: "The workspace's projects, each with its environments (name and address). Start here.",
    inputSchema: { type: "object", properties: {} },
    readOnly: true,
    async run(ctx) {
      const [projects, envs] = await Promise.all([
        ctx.sb.from("projects").select("id, name").eq("workspace_id", ctx.workspaceId).order("created_at"),
        ctx.sb.from("environments").select("project_id, name, base_url").eq("workspace_id", ctx.workspaceId).order("created_at"),
      ]);
      if (projects.error || envs.error) throw new Error((projects.error ?? envs.error)!.message);
      const data = (projects.data ?? []).map((p) => ({ id: p.id, name: p.name, environments: (envs.data ?? []).filter((e) => e.project_id === p.id).map((e) => ({ name: e.name, base_url: e.base_url })) }));
      const text = data.length ? data.map((p) => `${p.name}\n${p.environments.map((e) => `  ${e.name}: ${e.base_url}`).join("\n") || "  (no environments)"}`).join("\n") : "No projects yet. Make one at " + APP_URL;
      return { text, data: { projects: data } };
    },
  },
  {
    name: "list_tests",
    title: "List tests",
    description: "A project's tests, grouped by use case, with each test's last result.",
    inputSchema: { type: "object", properties: { project: projectArg } },
    readOnly: true,
    async run(ctx, args) {
      const p = await project(ctx, args.project);
      const [tests, runs] = await Promise.all([
        ctx.sb.from("tests").select("id, name, use_case, priority, steps").eq("workspace_id", ctx.workspaceId).eq("project_id", p.id).order("use_case").order("name"),
        ctx.sb.from("runs").select("test_id, status, verdict, created_at").eq("workspace_id", ctx.workspaceId).eq("project_id", p.id).order("created_at", { ascending: false }).limit(500),
      ]);
      if (tests.error || runs.error) throw new Error((tests.error ?? runs.error)!.message);
      const last = new Map<string, { status: string; verdict: string | null }>();
      for (const r of runs.data ?? []) if (r.test_id && !last.has(r.test_id)) last.set(r.test_id, r);
      const data = (tests.data ?? []).map((t) => ({ id: t.id, name: t.name, use_case: t.use_case, priority: t.priority, steps: Array.isArray(t.steps) ? t.steps.length : 0, last_result: last.get(t.id)?.status ?? null }));
      const text = data.length ? data.map((t) => `${t.use_case} / ${t.name}  (${t.steps} steps, ${t.last_result ?? "never run"})`).join("\n") : `${p.name} has no tests yet. Write one with save_test.`;
      return { text, data: { project: p, tests: data } };
    },
  },
  {
    name: "get_test",
    title: "Get a test",
    description: "One test as YAML (its plain-English steps), its Playwright code once written, and its last 5 results.",
    inputSchema: { type: "object", properties: { test: { ...str, description: "Test name or id." }, project: projectArg }, required: ["test"] },
    readOnly: true,
    async run(ctx, args) {
      const t = await findTest(ctx, args.test, args.project);
      const [blocks, runs] = await Promise.all([
        blocksOf(ctx, t.project_id),
        ctx.sb.from("runs").select("id, status, verdict, verdict_reason, created_at").eq("workspace_id", ctx.workspaceId).eq("test_id", t.id).order("created_at", { ascending: false }).limit(5),
      ]);
      if (runs.error) throw new Error(runs.error.message);
      const yaml = toYaml(t, blocks);
      const recent = (runs.data ?? []).map((r) => ({ status: r.status, verdict: r.verdict, reason: r.verdict_reason, url: `${APP_URL}/runs/${r.id}` }));
      const text = [
        `# ${t.name} (version ${t.version})`,
        "```yaml",
        yaml.trimEnd(),
        "```",
        t.lock ? `Playwright code:\n\`\`\`ts\n${t.lock.trimEnd()}\n\`\`\`` : "No code yet: Claritia writes it on the first run.",
        recent.length ? `Recent results: ${recent.map((r) => r.status + (r.verdict ? ` (${r.verdict})` : "")).join(", ")}` : "Never run.",
      ].join("\n");
      return { text, data: { id: t.id, name: t.name, version: t.version, yaml, code: t.lock, recent } };
    },
  },
  {
    name: "save_test",
    title: "Save a test",
    description:
      "Create or update a test from YAML. Steps are plain English; Claritia writes the Playwright code on the first run.\n" +
      "Format:\n  name: Checkout with a coupon\n  use_case: Checkout\n  priority: high\n  steps:\n    - Add the blue hoodie to the cart\n    - check: The total drops 10%\n    - use: sign-in   # a block (reusable steps) by name\n" +
      "Secrets go in steps by name (\"Type process.env.LOGIN_PASSWORD into the password field\") and live in the environment. " +
      "A test with the same name in the project is updated; steps whose words didn't change keep their code.",
    inputSchema: { type: "object", properties: { yaml: { ...str, description: "The test file." }, project: projectArg, test: { ...str, description: "The name or id of a test to update, when renaming it." } }, required: ["yaml"] },
    async run(ctx, args) {
      if (typeof args.yaml !== "string" || !args.yaml.trim()) throw new ToolError("Pass yaml: the test file.");
      const p = await project(ctx, args.project);
      const blocks = await blocksOf(ctx, p.id);
      let existing: TestRow | null = null;
      if (args.test) existing = await findTest(ctx, args.test, p.id);
      let doc;
      try {
        doc = fromYaml(args.yaml, blocks, existing?.steps ?? []);
        if (!existing) {
          const { data } = await ctx.sb.from("tests").select(TEST_FIELDS).eq("workspace_id", ctx.workspaceId).eq("project_id", p.id).eq("name", doc.name).limit(1);
          existing = ((data ?? []) as TestRow[])[0] ?? null;
          if (existing) doc = fromYaml(args.yaml, blocks, existing.steps);
        }
      } catch (e) {
        if (e instanceof TestFileError) throw new ToolError(e.message);
        throw e;
      }
      if (!doc.steps.length) throw new ToolError("Add at least one step.");
      const fields = { name: doc.name, use_case: doc.use_case, priority: doc.priority, steps: doc.steps };
      const res = existing
        ? await ctx.sb.from("tests").update(fields).eq("id", existing.id).eq("version", existing.version).select("id, name, version").maybeSingle()
        : await ctx.sb.from("tests").insert({ ...fields, project_id: p.id }).select("id, name, version").single();
      if (res.error) throw new ToolError(res.error.message);
      if (!res.data) throw new ToolError("Someone saved this test at the same moment. Call get_test and try again.");
      const saved = res.data as { id: string; name: string; version: number };
      return { text: `${existing ? "Updated" : "Created"} ${saved.name} (version ${saved.version}) in ${p.name}. Run it with verify_change.\n${APP_URL}/tests/${saved.id}`, data: { ...saved, project: p, url: `${APP_URL}/tests/${saved.id}`, created: !existing } };
    },
  },
  {
    name: "verify_change",
    title: "Verify a change",
    description:
      "Run tests in the cloud and wait for the results: every test in the project, one use case, or picked tests. " +
      "Use it after changing the app, pointed at where the change is live: an environment, or base_url for a preview deploy. " +
      "Each failure comes back sorted: app bug (fix the code), flaky (re-run, likely not your change) or setup (address or secret). " +
      "localhost works while `npx claritia tunnel <port>` runs on the developer's machine; other private addresses can't be reached. Waits up to 45 seconds; tests still running come back with run ids for get_results.",
    inputSchema: {
      type: "object",
      properties: {
        project: projectArg,
        environment: { ...str, description: "Environment name. Default: the project's first." },
        base_url: { ...str, description: "Run on this address instead, with the environment's secrets. For example a preview deploy: https://pr-42.example.com" },
        tests: { type: "array", items: str, description: "Test names or ids. Default: every test." },
        use_case: { ...str, description: "Run every test in one use case." },
        wait_seconds: { type: "number", description: "How long to wait for results, up to 45. Default 45." },
      },
    },
    async run(ctx, args) {
      const started = await startRuns(ctx, args, "mcp");
      if ("error" in started) throw new ToolError(started.error);
      const runs = await waitFor(ctx, started.runs.map((r) => r.id), typeof args.wait_seconds === "number" ? args.wait_seconds : MAX_WAIT);
      const where = started.base_url ?? started.environment.name;
      return { text: resultsText(runs, where), data: { project: started.project, environment: started.environment.name, base_url: started.base_url, done: runs.every((r) => r.done), runs } };
    },
  },
  {
    name: "get_results",
    title: "Get results",
    description: "Where runs stand, waiting up to 45 seconds for them to finish. A flaky failure's result is its re-run's.",
    inputSchema: { type: "object", properties: { run_ids: { type: "array", items: str, description: "Run ids from verify_change." }, wait_seconds: { type: "number", description: "Up to 45. Default 45." } }, required: ["run_ids"] },
    readOnly: true,
    async run(ctx, args) {
      const ids = Array.isArray(args.run_ids) ? [...new Set(args.run_ids.map(String))] : [];
      if (!ids.length || ids.length > 100 || !ids.every(isUuid)) throw new ToolError("Pass run_ids: up to 100 run ids from verify_change.");
      const runs = await waitFor(ctx, ids, typeof args.wait_seconds === "number" ? args.wait_seconds : MAX_WAIT);
      if (runs.length < ids.length) throw new ToolError("Some of those runs weren't found in this workspace.");
      return { text: resultsText(runs, runs[0]?.environment ?? "the environment"), data: { done: runs.every((r) => r.done), runs } };
    },
  },
  {
    name: "list_fixes",
    title: "List fixes waiting",
    description: "Fixes the Healer made for steps that broke because the app changed, waiting for a person to approve them in Claritia.",
    inputSchema: { type: "object", properties: { project: projectArg } },
    readOnly: true,
    async run(ctx, args) {
      const p = await project(ctx, args.project);
      const { data, error } = await ctx.sb.from("heals").select("id, position, step_label, old_code, new_code, error, created_at, tests(name)").eq("workspace_id", ctx.workspaceId).eq("project_id", p.id).eq("status", "pending").order("created_at", { ascending: false }).limit(20);
      if (error) throw new Error(error.message);
      const fixes = ((data ?? []) as unknown as { id: string; position: number; step_label: string; old_code: string; new_code: string; error: string; tests: { name: string } | null }[]).map((h) => ({ test: h.tests?.name ?? "Test", step: h.position, label: h.step_label, old_code: h.old_code, new_code: h.new_code, error: h.error, review: `${APP_URL}/approvals/${h.id}` }));
      const text = fixes.length ? fixes.map((f) => `${f.test}, step ${f.step} (${f.label})\n- ${f.old_code.replace(/\n/g, "\n- ")}\n+ ${f.new_code.replace(/\n/g, "\n+ ")}\nReview: ${f.review}`).join("\n\n") : "No fixes waiting.";
      return { text, data: { fixes } };
    },
  },
];

export const mcp = mcpServer<Ctx>({
  name: "claritia",
  title: "Claritia",
  version: "0.1.0",
  instructions:
    "Claritia runs end-to-end tests written in plain English, in a cloud browser. list_projects first. To check a change: " +
    "verify_change on the environment or preview address where it's live, then fix app bugs it reports. Write or edit tests with save_test (YAML).",
  tools,
});
