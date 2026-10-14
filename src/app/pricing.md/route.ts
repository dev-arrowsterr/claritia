import { amount, PLANS } from "@/lib/plans";
import { APP_URL, CONTACT_EMAIL } from "@/lib/site";

export const dynamic = "force-static";

/** Pricing as plain Markdown, for AI agents and people comparing tools. Built from the same plan list as the homepage. */
export function GET() {
  const rows = PLANS.map((p) => `| ${p.name} | ${p.price === null ? "Custom" : `$${p.price}/month`} | ${p.projects === null ? "Unlimited" : p.projects} | ${amount(p.minutes)} | ${amount(p.credits)} | ${p.features.join(", ")} |`);
  const text = `# Claritia pricing

Claritia turns plain-English user flows into Playwright tests, runs them in the cloud, and saves video, traces, network logs and screenshots for every run.

| Plan | Price | Projects | Cloud minutes a month | AI credits a month | Also includes |
|---|---|---|---|---|---|
${rows.join("\n")}

- Unlimited users on every plan.
- A cloud minute is one minute of browser time in a cloud run.
- An AI credit is one call to Claude to write a step. Claude writes each step once, then every run replays the saved Playwright code and uses no credits.
- Plans renew monthly. Cancel any time from Settings.
- Business is billed yearly. Write to ${CONTACT_EMAIL}.

Start free: ${APP_URL}
`;
  return new Response(text, { headers: { "content-type": "text/markdown; charset=utf-8" } });
}
