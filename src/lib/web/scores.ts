// Account scores (docs/account-intelligence.md 8.1–8.3, M1 subset): fit v0 from ICP rules, intent from decayed
// signals with a per-person cap and a breadth bonus, stage, temperature, priority and a plain why-now line.
// Fixed math, versioned, no AI.

export const SCORE_VERSION = 1;
const DAY = 86400_000;

export type ScoredSignal = { kind: string; weight: number; half_life_days: number; at: number; person_id: string | null };
export type Firmo = { industry?: string | null; size?: string | null; country?: string | null; employees?: number | null } | null;
export type IcpRule = { values: string[]; weight: number; required?: boolean };
export type Icp = { industries?: IcpRule; sizes?: IcpRule; countries?: IcpRule };

/** Fit v0: matched weights over all weights. A missed required field caps it at 30. Null without rules or data. */
export function fitV0(firmo: Firmo, icp: Icp | null): number | null {
  if (!icp || !firmo) return null;
  const fields: [IcpRule | undefined, string | null | undefined][] = [
    [icp.industries, firmo.industry],
    [icp.sizes, firmo.size],
    [icp.countries, firmo.country],
  ];
  let total = 0;
  let hit = 0;
  let missedRequired = false;
  for (const [rule, value] of fields) {
    if (!rule || !rule.values.length || rule.weight <= 0) continue;
    total += rule.weight;
    const ok = !!value && rule.values.some((v) => v.toLowerCase() === value.toLowerCase());
    if (ok) hit += rule.weight;
    else if (rule.required) missedRequired = true;
  }
  if (!total) return null;
  const fit = Math.round((hit / total) * 100);
  return missedRequired ? Math.min(fit, 30) : fit;
}

/** Decayed points of each signal at `now`. */
export const decayed = (s: ScoredSignal, now: number) => s.weight * 0.5 ** (Math.max(0, now - s.at) / DAY / s.half_life_days);

/** Raw intent: decayed sum (90 days), one person at most 40% of it, times the breadth bonus (up to 1.6×). */
export function rawIntent(signals: ScoredSignal[], now: number, sinceDays = 90): number {
  const live = signals.filter((s) => now - s.at <= sinceDays * DAY && now >= s.at);
  const positive = live.filter((s) => s.weight > 0);
  const byPerson = new Map<string, number>();
  let account = 0;
  for (const s of positive) {
    const p = decayed(s, now);
    if (s.person_id) byPerson.set(s.person_id, (byPerson.get(s.person_id) ?? 0) + p);
    else account += p;
  }
  const total = account + [...byPerson.values()].reduce((a, b) => a + b, 0);
  const cap = 0.4 * total;
  // With one known person the cap doesn't apply: there's no one else to weigh them against.
  const capped = byPerson.size > 1 ? [...byPerson.values()].reduce((a, v) => a + Math.min(v, cap), 0) : [...byPerson.values()].reduce((a, b) => a + b, 0);
  const breadth = Math.min(1.6, 1 + 0.15 * Math.max(0, byPerson.size - 1));
  const negative = live.filter((s) => s.weight < 0).reduce((a, s) => a + decayed(s, now), 0);
  return Math.max(0, (account + capped) * breadth + negative);
}

export const intentOf = (raw: number, k: number) => Math.round(100 * (1 - Math.exp(-raw / Math.max(1, k))));

export type Stage = "unknown" | "engaged" | "researching" | "evaluating";
const ORDER: Stage[] = ["unknown", "engaged", "researching", "evaluating"];
const RESEARCH = new Set(["page_pricing", "page_compare", "page_security", "page_integrations", "docs_depth", "case_study", "review_site_ref"]);

/**
 * Stage moves forward on its own and back only after quiet spells: 45 days to Engaged, 90 to Unknown.
 */
export function stageOf(signals: ScoredSignal[], now: number, previous: Stage | null): Stage {
  const recent = (days: number) => signals.filter((s) => s.weight > 0 && now - s.at <= days * DAY);
  const last = Math.max(-Infinity, ...signals.filter((s) => s.weight > 0).map((s) => s.at));
  let earned: Stage = "unknown";
  const r30 = recent(30);
  const people = new Set(r30.filter((s) => s.person_id).map((s) => s.person_id)).size;
  if (r30.some((s) => s.kind === "demo_request") || (r30.some((s) => s.kind === "page_pricing") && r30.some((s) => s.kind === "page_compare" || s.kind === "page_security") && people >= 2)) earned = "evaluating";
  else if (r30.some((s) => RESEARCH.has(s.kind)) || people >= 2) earned = "researching";
  else if (recent(45).length) earned = "engaged";
  let stage = previous && ORDER.indexOf(previous) > ORDER.indexOf(earned) ? previous : earned;
  const quiet = now - last;
  if (quiet > 90 * DAY) stage = "unknown";
  else if (quiet > 45 * DAY && ORDER.indexOf(stage) > ORDER.indexOf("engaged")) stage = "engaged";
  return stage;
}

/** Hot when the last week runs well above the 4-week pace (and intent is 40+), cooling when well below. */
export function temperatureOf(signals: ScoredSignal[], now: number, intent: number): "cold" | "cooling" | "steady" | "hot" {
  if (intent === 0) return "cold";
  const week = rawIntent(signals, now, 7);
  const month = rawIntent(signals, now, 28) / 4;
  if (month <= 0) return week > 0 && intent >= 40 ? "hot" : "steady";
  const ratio = week / month;
  if (ratio > 1.5 && intent >= 40) return "hot";
  if (ratio < 0.5) return "cooling";
  return "steady";
}

const STAGE_FACTOR: Record<Stage, number> = { unknown: 0.5, engaged: 0.8, researching: 1.0, evaluating: 1.3 };

export function priorityOf(intent: number, fit: number | null, stage: Stage, hasOwner: boolean): number {
  const f = fit ?? 50;
  return Math.round(intent * (0.4 + (0.6 * f) / 100) * STAGE_FACTOR[stage] * (hasOwner ? 1 : 1.2) * 10) / 10;
}

const LABEL: Record<string, string> = {
  page_pricing: "read pricing",
  page_demo: "looked at the demo page",
  page_compare: "compared you with others",
  page_security: "checked security",
  page_integrations: "looked at integrations",
  docs_depth: "went deep in the docs",
  case_study: "read case studies",
  return_visit: "came back after a quiet spell",
  multi_person: "several people visited",
  review_site_ref: "came from a review site",
  ai_assistant_ref: "came from an AI assistant",
  engaged_session: "spent real time on the site",
  form_submit: "filled a form",
  demo_request: "asked for a demo",
  new_person: "a new person showed up",
};

/** The two biggest signal kinds of the last 7 days, as one plain line. */
export function whyNow(signals: ScoredSignal[], now: number): { text: string; top: { kind: string; points: number; people: number }[] } {
  const byKind = new Map<string, { points: number; people: Set<string> }>();
  for (const s of signals) {
    if (s.weight <= 0 || now - s.at > 7 * DAY || now < s.at) continue;
    const k = byKind.get(s.kind) ?? { points: 0, people: new Set<string>() };
    k.points += decayed(s, now);
    if (s.person_id) k.people.add(s.person_id);
    byKind.set(s.kind, k);
  }
  const top = [...byKind.entries()]
    .sort((a, b) => b[1].points - a[1].points)
    .slice(0, 2)
    .map(([kind, v]) => ({ kind, points: Math.round(v.points * 10) / 10, people: v.people.size }));
  const part = (t: { kind: string; people: number }) => (t.people > 1 ? `${t.people} people ${LABEL[t.kind] ?? t.kind}` : (LABEL[t.kind] ?? t.kind));
  const text = top.length ? `This week: ${top.map(part).join(", and ")}.` : "";
  return { text: text.replace(/^This week: ([a-z])/, (_, c) => `This week: ${c}`), top };
}
