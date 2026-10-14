// PR-aware runs: from a pull request's changed files, pick the tests the change can affect. Fixed rules go first and
// need no AI: a change to docs alone runs nothing; a change to shared code (dependencies, config, global styles,
// layouts, sign-in) runs everything. The rest goes to Claude Haiku with the files, their diffs and the tests.
// When in doubt, everything runs: a missed failure costs more than a few extra runs.

import Anthropic from "@anthropic-ai/sdk";

export type ChangedFile = { filename: string; status: string; additions: number; deletions: number; patch?: string };
export type PickTest = { id: string; name: string; use_case: string; steps: string[] };
export type Picked = { tests: { id: string; why: string }[] };
export type Selection =
  | { mode: "all"; reason: string }
  | { mode: "none"; reason: string }
  | { mode: "picked"; reason: string; tests: { id: string; name: string; why: string }[] };
export type PickerReply = { runAll: boolean; reason: string; tests: { name: string; why: string }[]; newFlows: string[]; usage: { input: number; output: number } };
export type Picker = (files: ChangedFile[], tests: PickTest[], pages: { pattern: string; name: string | null }[]) => Promise<PickerReply>;

const DOCS = /(^|\/)(docs?|\.github|\.vscode|\.idea)\/|\.(md|mdx|txt|rst|adoc)$|(^|\/)(LICENSE|CHANGELOG|CODEOWNERS|\.gitignore|\.editorconfig|\.prettierrc[^/]*)$|(^|\/)(__tests__|tests?|spec|e2e|cypress|playwright)\/|\.(test|spec)\.[a-z]+$/i;
const SHARED =
  /(^|\/)(package(-lock)?\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Gemfile(\.lock)?|requirements[^/]*\.txt|poetry\.lock|go\.(mod|sum)|composer\.(json|lock)|Dockerfile|docker-compose[^/]*|\.env[^/]*|next\.config\.[a-z]+|vite\.config\.[a-z]+|webpack\.config\.[a-z]+|tsconfig[^/]*\.json|tailwind\.config\.[a-z]+|postcss\.config\.[a-z]+|middleware\.[a-z]+|proxy\.[a-z]+)$|(^|\/)(globals?|app|index|main|layout|_app|_document|root)\.(css|scss|tsx?|jsx?|vue|svelte)$|(^|\/)(auth|session|middleware|routes?|router)[^/]*\//i;

/** Rules that settle the pick with no AI call, or null. */
export function selectByRules(files: ChangedFile[]): Selection | null {
  if (!files.length) return { mode: "all", reason: "The pull request's files couldn't be read, so every test runs." };
  if (files.length >= 100) return { mode: "all", reason: `The pull request changes ${files.length} or more files, so every test runs.` };
  if (files.every((f) => DOCS.test(f.filename))) return { mode: "none", reason: "Only docs and test files changed, so no tests run." };
  const shared = files.find((f) => SHARED.test(f.filename));
  if (shared) return { mode: "all", reason: `${shared.filename} is shared by the whole app, so every test runs.` };
  return null;
}

const MAX_PATCH = 1500;
const MAX_DIFF = 40_000;

export function pickPrompt(files: ChangedFile[], tests: PickTest[], pages: { pattern: string; name: string | null }[]): string {
  let budget = MAX_DIFF;
  const fileText = files.map((f) => {
    const head = `## ${f.filename} (${f.status}, +${f.additions} -${f.deletions})`;
    const patch = (f.patch ?? "").slice(0, Math.min(MAX_PATCH, Math.max(0, budget)));
    budget -= patch.length;
    return patch ? `${head}\n${patch}` : head;
  });
  return [
    `# Changed files (${files.length})\n\n${fileText.join("\n\n")}`,
    `# Tests\n${tests.map((t) => `- ${t.name} [${t.use_case}]: ${t.steps.slice(0, 12).join(" → ")}`).join("\n")}`,
    pages.length ? `# Pages of the app\n${pages.slice(0, 150).map((p) => `- ${p.pattern}${p.name ? ` (${p.name})` : ""}`).join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

const SYSTEM = `You pick which end-to-end tests a pull request can affect, for Claritia. Each test drives a real browser through the app.

Pick a test when the change can alter what it does or sees: the pages, components, API routes, data or text its steps touch, including shared components those pages use. Say why in under 12 words.

Set run_all to true when the change can affect most of the app (shared layout, navigation, sign-in, API client, database schema, global state, styling used everywhere) or when you can't tell. Missing a broken test costs far more than running extra ones.

In new_flows, list user-facing flows this pull request adds that no test covers yet, as short phrases ("Export orders as CSV"). Leave it empty when there are none.`;

const SCHEMA = {
  type: "object",
  properties: {
    run_all: { type: "boolean" },
    reason: { type: "string" },
    tests: { type: "array", items: { type: "object", properties: { name: { type: "string" }, why: { type: "string" } }, required: ["name", "why"], additionalProperties: false } },
    new_flows: { type: "array", items: { type: "string" } },
  },
  required: ["run_all", "reason", "tests", "new_flows"],
  additionalProperties: false,
};

/** A picker backed by Claude Haiku. */
export function claudePicker(opts: { apiKey: string; model?: string }): Picker {
  const client = new Anthropic({ apiKey: opts.apiKey, maxRetries: 2, timeout: 60_000 });
  const model = opts.model || "claude-haiku-5-5";
  return async (files, tests, pages) => {
    const res = await client.beta.messages.create({
      model,
      max_tokens: 4000,
      thinking: { type: "adaptive" },
      output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
      system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: pickPrompt(files, tests, pages) }],
    });
    const u = res.usage;
    const usage = { input: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), output: u.output_tokens ?? 0 };
    if (res.stop_reason === "refusal" || res.stop_reason === "max_tokens") throw new Error("Claude didn't pick tests.");
    const out = JSON.parse(res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("")) as { run_all?: boolean; reason?: string; tests?: { name: string; why: string }[]; new_flows?: string[] };
    return { runAll: out.run_all !== false, reason: String(out.reason ?? ""), tests: out.tests ?? [], newFlows: (out.new_flows ?? []).map(String).filter(Boolean).slice(0, 5), usage };
  };
}

/** Turn the picker's answer into a selection. Unknown names are dropped; nothing picked means everything runs. */
export function selectionFrom(reply: Pick<PickerReply, "runAll" | "reason" | "tests">, tests: PickTest[]): Selection {
  if (reply.runAll) return { mode: "all", reason: reply.reason.trim() || "The change can affect most of the app, so every test runs." };
  const byName = new Map(tests.map((t) => [t.name.trim().toLowerCase(), t]));
  const picked: { id: string; name: string; why: string }[] = [];
  for (const p of reply.tests) {
    const t = byName.get(String(p.name).trim().toLowerCase());
    if (t && !picked.some((x) => x.id === t.id)) picked.push({ id: t.id, name: t.name, why: String(p.why ?? "").trim().slice(0, 120) });
  }
  if (!picked.length) return { mode: "all", reason: "No test was clearly affected, so every test runs to be safe." };
  return { mode: "picked", reason: reply.reason.trim(), tests: picked };
}
