// AI-written nurture steps (docs/marketing-platform.md M4 and Part 2). Claude writes from the nurture's brief only;
// whatever it says a person should check comes back as review notes, and nothing goes out until a person approves
// the step. Answers are cached by their inputs (ai_cache), so the same request never calls the model twice.

import { createHash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import type { Rpc } from "../jobs.ts";

export { readStep, stepEmail } from "./email.ts";

export const DRAFT_MODEL = "claude-opus-5-5";

export type DraftInput = {
  workspace: string;
  brief: string;
  /** Domains the call to action may point at (the workspace's sites, and any in the brief). */
  domains: string[];
  /** Steps already there, in order, so new ones follow on. */
  existing: { subject: string; text: string }[];
  /** How many to write, and where: append (null) or rewrite the step at this position. */
  count: number;
  replace: number | null;
};
export type DraftStep = { subject: string; preheader: string; paragraphs: string[]; cta_label: string; cta_url: string; wait_days: number; review_notes: string[] };
export type Drafter = (input: DraftInput) => Promise<{ steps: DraftStep[]; model: string; input_tokens: number; output_tokens: number }>;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["steps"],
  properties: {
    steps: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["subject", "preheader", "paragraphs", "cta_label", "cta_url", "wait_days", "review_notes"],
        properties: {
          subject: { type: "string" },
          preheader: { type: "string" },
          paragraphs: { type: "array", items: { type: "string" } },
          cta_label: { type: "string" },
          cta_url: { type: "string" },
          wait_days: { type: "integer" },
          review_notes: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
} as const;

const SYSTEM = `You write B2B nurture emails for the company described in the brief.

Rules:
- Use only facts found in the brief. Don't invent numbers, customers, quotes, awards, prices or features.
- If a sentence needs a fact the brief doesn't give, leave it out. If you make a claim a person should confirm, add it to review_notes.
- Write like a person at the company writing to one reader: short, plain words, one idea per email, 60 to 150 words.
- Subject: under 60 characters, no clickbait, no all caps, no emoji. Preheader: under 100 characters and adds to the subject.
- One call to action per email at most. cta_url must be a full https link on one of the allowed domains, or empty.
- No placeholders like {{first_name}}, no greeting with a name, no sign-off with a made-up person's name.
- Don't mention tracking, opens or clicks. The footer and unsubscribe link are added for you.
- wait_days is the wait before this email: 0 for the first email, then 2 to 7 days.
- Each email follows on from the ones before it and doesn't repeat them.`;

function prompt(i: DraftInput): string {
  const before = i.existing.map((s, n) => `Email ${n + 1}: ${s.subject}\n${s.text.slice(0, 1200)}`).join("\n\n");
  const ask =
    i.replace != null
      ? `Rewrite email ${i.replace + 1} so it fits between the others. Return exactly 1 email.`
      : `Write the next ${i.count} email${i.count === 1 ? "" : "s"} in this sequence. Return exactly ${i.count}.`;
  return `Company: ${i.workspace}
Allowed link domains: ${i.domains.join(", ") || "none"}

<brief>
${i.brief.slice(0, 8000)}
</brief>

${before ? `<emails_so_far>\n${before}\n</emails_so_far>\n\n` : ""}${ask}`;
}

/** Claude, with the brief as the only source. Needs ANTHROPIC_API_KEY. */
export function claudeDrafter(apiKey: string): Drafter {
  const client = new Anthropic({ apiKey });
  return async (input) => {
    const res = await client.beta.messages.create({
      model: DRAFT_MODEL,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "medium", format: { type: "json_schema", schema: SCHEMA as unknown as Record<string, unknown> } },
      system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: prompt(input) }],
    });
    if (res.stop_reason === "refusal") throw new Error("The AI declined to write this. Change the brief and try again.");
    if (res.stop_reason === "max_tokens") throw new Error("The draft ran too long. Ask for fewer emails.");
    const text = res.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    let out: { steps?: DraftStep[] };
    try {
      out = JSON.parse(text);
    } catch {
      throw new Error("The AI's answer couldn't be read. Try again.");
    }
    const u = res.usage;
    return {
      steps: out.steps ?? [],
      model: res.model,
      input_tokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
      output_tokens: u.output_tokens ?? 0,
    };
  };
}

const hostOf = (u: string) => {
  try {
    return new URL(u).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
};

/** Domains named in the brief as links, added to the allowed list. */
export function briefDomains(brief: string): string[] {
  return [...new Set([...brief.matchAll(/https:\/\/[^\s)<>"']+/g)].map((m) => hostOf(m[0])).filter(Boolean))];
}

/** Keep what's usable: trimmed text, a link only on an allowed domain, waits in range, no placeholders. */
export function cleanSteps(steps: DraftStep[], domains: string[], want: number): DraftStep[] {
  const ok = new Set(domains.map((d) => d.toLowerCase().replace(/^www\./, "")));
  const allowed = (u: string) => {
    const h = hostOf(u);
    return u.startsWith("https://") && !!h && [...ok].some((d) => h === d || h.endsWith(`.${d}`));
  };
  const noTokens = (s: string) => s.replace(/\{\{[^}]*\}\}/g, "").replace(/[ \t]+([,.!?;:])/g, "$1").replace(/[ \t]{2,}/g, " ").trim();
  return steps.slice(0, want).map((s) => {
    const url = String(s.cta_url ?? "").trim();
    const linkOk = allowed(url);
    const notes = (s.review_notes ?? []).map((n) => String(n).slice(0, 300)).filter(Boolean).slice(0, 10);
    if (url && !linkOk) notes.push(`The AI suggested a link that isn't on your domains: ${url.slice(0, 200)}`);
    return {
      subject: noTokens(String(s.subject ?? "")).slice(0, 150) || "Untitled",
      preheader: noTokens(String(s.preheader ?? "")).slice(0, 200),
      paragraphs: (s.paragraphs ?? []).map((p) => noTokens(String(p))).filter(Boolean).slice(0, 8),
      cta_label: linkOk ? noTokens(String(s.cta_label ?? "")).slice(0, 60) : "",
      cta_url: linkOk ? url : "",
      wait_days: Math.max(0, Math.min(90, Math.round(Number(s.wait_days) || 0))),
      review_notes: notes,
    };
  });
}

/** The cache key: every input that changes the answer, and the model. */
export const draftKey = (i: DraftInput) => createHash("sha256").update(JSON.stringify({ v: 1, model: DRAFT_MODEL, ...i, domains: [...i.domains].sort() })).digest("hex");

/** Draft steps, from the cache when the same request was made before. */
export async function draftSteps(rpc: Rpc, drafter: Drafter, ws: string, input: DraftInput): Promise<{ steps: DraftStep[]; cached: boolean }> {
  const key = draftKey(input);
  const hit = await rpc("ai_cache_get", { p_ws: ws, p_kind: "nurture_draft", p_key: key });
  if (!hit.error && hit.data) return { steps: cleanSteps((hit.data as { steps: DraftStep[] }).steps, input.domains, input.count), cached: true };
  const out = await drafter(input);
  const steps = cleanSteps(out.steps, input.domains, input.count);
  if (!steps.length) throw new Error("The AI didn't write any emails. Add more to the brief and try again.");
  await rpc("ai_cache_put", { p_ws: ws, p_kind: "nurture_draft", p_key: key, p_output: { steps: out.steps }, p_model: out.model, p_in: out.input_tokens, p_out: out.output_tokens });
  return { steps, cached: false };
}
