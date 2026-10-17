// Account alert rules: when an account turns hot, reaches Evaluating, or its intent crosses a number, for accounts
// at or above a fit. Pure matching and the Slack message; claritia-intel checks rules after each score.

import { APP_URL } from "../site.ts";

export type AlertRule = { when: "hot" | "evaluating" | "intent"; intent?: number; fit_min?: number };
export type Snapshot = { temperature: string | null; stage: string | null; intent: number | null; fit: number | null };

export function parseRule(raw: unknown): AlertRule | null {
  const r = raw as Partial<AlertRule> | null;
  if (!r || !["hot", "evaluating", "intent"].includes(r.when as string)) return null;
  const intent = r.when === "intent" ? Number(r.intent) : undefined;
  if (r.when === "intent" && !(Number.isInteger(intent) && intent! >= 1 && intent! <= 100)) return null;
  const fit = r.fit_min === undefined || r.fit_min === null ? undefined : Number(r.fit_min);
  if (fit !== undefined && !(Number.isInteger(fit) && fit >= 0 && fit <= 100)) return null;
  return { when: r.when as AlertRule["when"], ...(intent !== undefined ? { intent } : {}), ...(fit !== undefined ? { fit_min: fit } : {}) };
}

/** True when this score change is the moment the rule describes. An unknown fit counts as 50. */
export function ruleFires(rule: AlertRule, before: Snapshot, after: Snapshot): boolean {
  if ((after.fit ?? 50) < (rule.fit_min ?? 0)) return false;
  if (rule.when === "hot") return after.temperature === "hot" && before.temperature !== "hot";
  if (rule.when === "evaluating") return after.stage === "evaluating" && before.stage !== "evaluating";
  const n = rule.intent ?? 70;
  return (after.intent ?? 0) >= n && (before.intent ?? 0) < n;
}

export function ruleText(r: AlertRule): string {
  const what = r.when === "hot" ? "turns hot" : r.when === "evaluating" ? "reaches Evaluating" : `passes intent ${r.intent}`;
  return `When an account ${what}${r.fit_min ? ` with fit ${r.fit_min}+` : ""}`;
}

export function slackAccountMessage(a: { id: string; name: string | null; domain: string; fit: number | null; intent: number | null; stage: string | null; why_now: string | null }, rule: AlertRule) {
  const title = `${a.name ?? a.domain} ${rule.when === "hot" ? "is hot" : rule.when === "evaluating" ? "is evaluating" : `passed intent ${rule.intent}`}`;
  const url = `${APP_URL}/companies/account/${a.id}`;
  const facts = `Fit ${a.fit ?? "—"} · Intent ${a.intent ?? "—"} · ${a.stage ?? "unknown"}`;
  return {
    text: `${title}. ${a.why_now ?? ""} ${url}`.trim(),
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: `*<${url}|${title}>*\n${facts}${a.why_now ? `\n${a.why_now}` : ""}` } },
      { type: "context", elements: [{ type: "mrkdwn", text: a.domain }] },
    ],
  };
}
