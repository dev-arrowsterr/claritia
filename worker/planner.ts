// The Planner: from the app map (pages, what people do there, forms, buttons, links), the tests a project already
// has, its blocks, and notes or a PRD someone pasted, Claude proposes end-to-end tests grouped by use case.

import Anthropic from "@anthropic-ai/sdk";

export type PlanPage = { pattern: string; name: string | null; purpose: string | null; title: string | null; forms: { fields: { label: string; type: string }[]; submit: string }[]; buttons: string[]; links: string[] };
export type PlanRequest = { site: string; pages: PlanPage[]; tests: { name: string; use_case: string }[]; blocks: string[]; notes: string };
export type ProposedStep = { kind: "do" | "check"; text: string } | { kind: "use"; block: string };
export type Proposal = { name: string; use_case: string; priority: "low" | "medium" | "high"; reason: string; pages: string[]; steps: ProposedStep[] };
export type Planner = (r: PlanRequest) => Promise<{ proposals: Proposal[]; usage: { input: number; output: number } }>;

export const MAX_PROPOSALS = 15;
const MAX_PAGES = 150;

const SYSTEM = `You plan end-to-end tests for Claritia. Claritia runs each test in a real browser from plain-English steps and writes the code itself.

You get the app's map (each kind of page, what people do there, its forms, buttons and links), the tests that already exist, the reusable blocks, and sometimes notes or a PRD. Propose the tests that would catch the most important breakages, most important first.

Rules:
- Cover what real users do: sign-up and sign-in, the main create/edit flows, search and filters, checkout or payment, settings. Prefer flows that cross pages and end in a visible result.
- Don't repeat a test that already exists (same flow under another name counts).
- Each test: a short name (under 60 characters), a use case (1 to 3 words, like Checkout or Account), a priority (high for money, sign-in and core flows), one sentence on why it matters, the page patterns it covers, and 3 to 12 steps.
- Steps: one action each, in the words a person would use ("Click Add to cart", "Type Ada into the Name field"). "check" steps say what must be true on the page after ("The cart shows 1 item"). End with at least one check.
- Start with a "use" step naming a block (exactly as listed) when one does the setup, such as signing in. Otherwise write the steps.
- Passwords and keys: write them as process.env.NAME in the step ("Type process.env.LOGIN_PASSWORD into the Password field"). Never invent real credentials.
- Only use pages, fields and buttons that appear in the map or the notes. Don't guess at hidden features.
- Never propose deleting accounts, sending real payments or emailing real people.
- Up to ${MAX_PROPOSALS} tests.`;

const SCHEMA = {
  type: "object",
  properties: {
    tests: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          use_case: { type: "string" },
          priority: { type: "string", enum: ["low", "medium", "high"] },
          reason: { type: "string" },
          pages: { type: "array", items: { type: "string" } },
          steps: {
            type: "array",
            items: {
              type: "object",
              properties: { kind: { type: "string", enum: ["do", "check", "use"] }, text: { type: "string" } },
              required: ["kind", "text"],
              additionalProperties: false,
            },
          },
        },
        required: ["name", "use_case", "priority", "reason", "pages", "steps"],
        additionalProperties: false,
      },
    },
  },
  required: ["tests"],
  additionalProperties: false,
};

export function planPrompt(r: PlanRequest): string {
  const pages = r.pages.slice(0, MAX_PAGES).map((p) =>
    [
      `## ${p.pattern}${p.name ? ` (${p.name})` : ""}`,
      p.purpose ? p.purpose : p.title ? `Title: ${p.title}` : "",
      ...p.forms.map((f, i) => `Form ${i + 1}: ${f.fields.map((x) => `${x.label || "?"} (${x.type})`).join(", ") || "no fields"}${f.submit ? ` → ${f.submit}` : ""}`),
      p.buttons.length ? `Buttons: ${p.buttons.slice(0, 15).join(" | ")}` : "",
      p.links.length ? `Links to: ${p.links.slice(0, 15).join(", ")}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
  );
  return [
    `Site: ${r.site}`,
    r.pages.length ? `# App map (${r.pages.length} pages)\n\n${pages.join("\n\n")}` : "# App map\n(not explored yet)",
    `# Tests that already exist\n${r.tests.length ? r.tests.map((t) => `- ${t.use_case} / ${t.name}`).join("\n") : "(none)"}`,
    `# Blocks\n${r.blocks.length ? r.blocks.map((b) => `- ${b}`).join("\n") : "(none)"}`,
    r.notes.trim() ? `# Notes from the team\n${r.notes.trim()}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Clean what Claude proposed: limits, known blocks only, no duplicates of existing tests or of each other. */
export function cleanProposals(raw: unknown[], r: PlanRequest): Proposal[] {
  const blocks = new Map(r.blocks.map((b) => [b.toLowerCase(), b]));
  const taken = new Set(r.tests.map((t) => t.name.trim().toLowerCase()));
  const out: Proposal[] = [];
  for (const item of raw) {
    const t = item as Record<string, unknown>;
    const name = String(t.name ?? "").trim().slice(0, 120);
    if (!name || taken.has(name.toLowerCase())) continue;
    const steps: ProposedStep[] = [];
    for (const s of Array.isArray(t.steps) ? (t.steps as { kind?: string; text?: string }[]) : []) {
      const text = String(s.text ?? "").trim();
      if (!text) continue;
      if (s.kind === "use") {
        const b = blocks.get(text.toLowerCase());
        if (b) steps.push({ kind: "use", block: b });
      } else if (s.kind === "do" || s.kind === "check") steps.push({ kind: s.kind, text: text.slice(0, 500) });
    }
    if (!steps.some((s) => s.kind !== "use")) continue;
    taken.add(name.toLowerCase());
    out.push({
      name,
      use_case: String(t.use_case ?? "").trim().slice(0, 60) || "General",
      priority: t.priority === "high" || t.priority === "low" ? t.priority : "medium",
      reason: String(t.reason ?? "").trim().slice(0, 300),
      pages: (Array.isArray(t.pages) ? t.pages : []).map(String).filter((p) => p.startsWith("/")).slice(0, 20),
      steps: steps.slice(0, 30),
    });
    if (out.length >= MAX_PROPOSALS) break;
  }
  return out;
}

/** A planner backed by Claude. Needs ANTHROPIC_API_KEY. */
export function claudePlanner(opts: { apiKey: string; model?: string; effort?: "low" | "medium" | "high" }): Planner {
  const client = new Anthropic({ apiKey: opts.apiKey, maxRetries: 3, timeout: 300_000 });
  const model = opts.model || "claude-opus-5-5";
  return async (r) => {
    const stream = client.beta.messages.stream({
      model,
      max_tokens: 32000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      thinking: { type: "adaptive" },
      output_config: { effort: opts.effort ?? "medium", format: { type: "json_schema", schema: SCHEMA } },
      system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: planPrompt(r) }],
    });
    const res = await stream.finalMessage();
    const u = res.usage;
    const usage = { input: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), output: u.output_tokens ?? 0 };
    if (res.stop_reason === "refusal") throw new Error("Claude declined to plan these tests.");
    if (res.stop_reason === "max_tokens") throw new Error("The plan was too long to finish. Try again with shorter notes.");
    const out = JSON.parse(res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("")) as { tests?: unknown[] };
    return { proposals: cleanProposals(out.tests ?? [], r), usage };
  };
}
