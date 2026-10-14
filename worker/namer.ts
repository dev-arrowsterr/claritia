// Names the pages the Explorer finds: a short name and one line on what people do there, for the app map and the
// Planner. Pages go to Claude Haiku in batches of up to 10, as text (address, title, headings, forms, buttons).

import Anthropic from "@anthropic-ai/sdk";
import type { PageElements } from "./explorer.ts";

export type PageToName = { pattern: string; title: string; elements: PageElements };
export type PageName = { pattern: string; name: string; purpose: string };
export type Namer = (site: string, pages: PageToName[]) => Promise<{ names: PageName[]; usage: { input: number; output: number } }>;

const SYSTEM = `You name the pages of a web app for a testing tool's app map. For each page you get its address pattern, title, headings, forms and buttons.

Give each page:
- name: 1 to 4 words a user would call it, like "Order details", "Sign in", "Team settings". No app name.
- purpose: one plain sentence, under 15 words, on what a person does there, like "Shows one order's items, total and delivery status."

Answer for every pattern you were given, using the pattern exactly as written.`;

const SCHEMA = {
  type: "object",
  properties: {
    pages: {
      type: "array",
      items: {
        type: "object",
        properties: { pattern: { type: "string" }, name: { type: "string" }, purpose: { type: "string" } },
        required: ["pattern", "name", "purpose"],
        additionalProperties: false,
      },
    },
  },
  required: ["pages"],
  additionalProperties: false,
};

export function describePages(site: string, pages: PageToName[]): string {
  return [
    `Site: ${site}`,
    ...pages.map((p) =>
      [
        `## ${p.pattern}`,
        `Title: ${p.title || "(none)"}`,
        p.elements.headings.length ? `Headings: ${p.elements.headings.join(" | ")}` : "",
        ...p.elements.forms.map((f, i) => `Form ${i + 1}: ${f.fields.map((x) => `${x.label || "?"} (${x.type})`).join(", ") || "no fields"}${f.submit ? ` → ${f.submit}` : ""}`),
        p.elements.buttons.length ? `Buttons: ${p.elements.buttons.join(" | ")}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    ),
  ].join("\n\n");
}

/** A namer backed by Claude Haiku. Needs ANTHROPIC_API_KEY. */
export function claudeNamer(opts: { apiKey: string; model?: string }): Namer {
  const client = new Anthropic({ apiKey: opts.apiKey, maxRetries: 3, timeout: 60_000 });
  const model = opts.model || "claude-haiku-5-5";
  return async (site, pages) => {
    const res = await client.beta.messages.create({
      model,
      max_tokens: 4000,
      thinking: { type: "adaptive" },
      output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
      system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: describePages(site, pages) }],
    });
    const u = res.usage;
    const usage = { input: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), output: u.output_tokens ?? 0 };
    if (res.stop_reason === "refusal" || res.stop_reason === "max_tokens") throw new Error("Claude gave no page names.");
    const out = JSON.parse(res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("")) as { pages?: PageName[] };
    const wanted = new Set(pages.map((p) => p.pattern));
    const names = (out.pages ?? [])
      .filter((p) => wanted.has(p.pattern) && typeof p.name === "string" && typeof p.purpose === "string")
      .map((p) => ({ pattern: p.pattern, name: p.name.trim().slice(0, 60), purpose: p.purpose.trim().slice(0, 200) }));
    return { names, usage };
  };
}
