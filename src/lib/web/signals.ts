// Website signals (docs/account-intelligence.md 7.1, 7.2, 7.6). Pure rules over one visit and a little account
// history; the signal job loads the data and saves what these return. Dedupe keys make re-running a visit safe.

import { pathMatches } from "../../../collect/scrub.ts";

export type Group = "pricing" | "demo" | "compare" | "security" | "integrations" | "docs" | "case_study" | "product" | "blog" | "careers" | "legal" | "login" | "private" | "other";
export type PageGroup = { pattern: string; grp: Group; competitor?: string | null };

export type SignalType = { weight: number; half_life_days: number };
export const DEFAULT_SIGNALS: Record<string, SignalType> = {
  page_pricing: { weight: 10, half_life_days: 7 },
  page_demo: { weight: 8, half_life_days: 7 },
  page_compare: { weight: 12, half_life_days: 10 },
  page_security: { weight: 9, half_life_days: 14 },
  page_integrations: { weight: 6, half_life_days: 14 },
  docs_depth: { weight: 9, half_life_days: 14 },
  case_study: { weight: 5, half_life_days: 14 },
  return_visit: { weight: 8, half_life_days: 7 },
  multi_person: { weight: 12, half_life_days: 7 },
  review_site_ref: { weight: 10, half_life_days: 10 },
  ai_assistant_ref: { weight: 6, half_life_days: 10 },
  engaged_session: { weight: 4, half_life_days: 7 },
  form_submit: { weight: 15, half_life_days: 14 },
  demo_request: { weight: 25, half_life_days: 21 },
  new_person: { weight: 6, half_life_days: 14 },
};

// Until the team confirms page groups, common paths say what a page is.
const GUESSES: [Group, RegExp][] = [
  ["pricing", /^\/(pricing|plans|price|buy)(\/|$)/i],
  ["demo", /^\/(demo|book-a-demo|request-demo|get-a-demo|contact-sales|talk-to-sales)(\/|$)/i],
  ["compare", /(^\/(vs|compare|alternatives?)(\/|$))|(-vs-)|(\/[^/]*-alternatives?(\/|$))/i],
  ["security", /^\/(security|trust|compliance|soc-?2|gdpr|privacy-center)(\/|$)/i],
  ["integrations", /^\/(integrations?|apps|marketplace)(\/|$)/i],
  ["docs", /^\/(docs|documentation|guides|api|developers?)(\/|$)/i],
  ["case_study", /^\/(customers|case-stud(y|ies)|stories)(\/|$)/i],
  ["careers", /^\/(careers|jobs)(\/|$)/i],
];

/** A page's group: the team's groups first (most specific pattern wins), then the common-path guesses. */
export function groupOf(path: string, groups: PageGroup[]): { grp: Group; competitor: string | null } | null {
  const clean = path.split("?")[0] || "/";
  const hits = groups.filter((g) => pathMatches(clean, [g.pattern])).sort((a, b) => b.pattern.length - a.pattern.length);
  if (hits[0]) return { grp: hits[0].grp, competitor: hits[0].competitor ?? null };
  const guess = GUESSES.find(([, re]) => re.test(clean));
  if (!guess) return null;
  const competitor = guess[0] === "compare" ? (clean.match(/\/vs\/([^/]+)|\/([^/]+)-alternatives?|-vs-([^/]+)/i)?.slice(1).find(Boolean) ?? null) : null;
  return { grp: guess[0], competitor };
}

export type Visit = {
  id: string;
  startedAt: number;
  personId: string | null;
  /** Probable links give signals to the account only (7.6). */
  personLevel: string | null;
  refClass: string | null;
  referrerHost: string | null;
  events: { kind: string; path: string | null; at: number; data: Record<string, unknown> | null }[];
};

export type Signal = { kind: string; person_id: string | null; at: number; dedupe_key: string; evidence: Record<string, unknown> };

const day = (t: number) => new Date(t).toISOString().slice(0, 10);
const week = (t: number) => {
  const d = new Date(t);
  const start = Date.UTC(d.getUTCFullYear(), 0, 1);
  return `${d.getUTCFullYear()}w${Math.floor((t - start) / (7 * 86400_000))}`;
};

/** The signals one visit makes. `account` is the account id; keys are unique per workspace. */
export function visitSignals(account: string, v: Visit, groups: PageGroup[]): Signal[] {
  const person = v.personId && v.personLevel !== "probable" ? v.personId : null;
  const who = person ?? `s:${v.id}`;
  const out = new Map<string, Signal>();
  const add = (kind: string, key: string, at: number, evidence: Record<string, unknown>) => {
    const k = `${kind}:${account}:${key}`;
    if (!out.has(k)) out.set(k, { kind, person_id: person, at, dedupe_key: k, evidence: { session_id: v.id, ...evidence } });
  };
  const views = v.events.filter((e) => e.kind === "view" && e.path);
  const forms = v.events.filter((e) => e.kind === "form");
  const docs = new Set<string>();
  let careers = 0;
  let other = 0;
  for (const e of views) {
    const g = groupOf(e.path!, groups);
    const d = day(e.at);
    if (!g) {
      other++;
      continue;
    }
    if (g.grp === "careers") careers++;
    else other++;
    if (g.grp === "pricing") add("page_pricing", `${who}:${d}`, e.at, { path: e.path });
    if (g.grp === "demo" && !forms.length) add("page_demo", `${who}:${d}`, e.at, { path: e.path });
    if (g.grp === "compare") add("page_compare", `${who}:${g.competitor ?? "-"}:${d}`, e.at, { path: e.path, competitor: g.competitor });
    if (g.grp === "security") add("page_security", d, e.at, { path: e.path });
    if (g.grp === "integrations") add("page_integrations", `${who}:${e.path!.split("?")[0]}:${week(e.at)}`, e.at, { path: e.path });
    if (g.grp === "case_study") add("case_study", `${who}:${e.path!.split("?")[0]}`, e.at, { path: e.path });
    if (g.grp === "docs") docs.add(e.path!.split("?")[0]);
  }
  // A visit that only looked at careers pages is a likely job seeker: no signals at all (7.1 careers_only).
  if (careers > 0 && other === 0) return [];
  if (docs.size >= 5) add("docs_depth", `${who}:${day(v.startedAt)}`, v.startedAt, { pages: docs.size });
  const active = v.events.filter((e) => e.kind === "engage").reduce((s, e) => s + (Number(e.data?.active_s) || 0), 0);
  if (active >= 180) add("engaged_session", `${who}:${day(v.startedAt)}`, v.startedAt, { active_s: active });
  if (v.refClass === "review_site") add("review_site_ref", day(v.startedAt), v.startedAt, { referrer: v.referrerHost });
  if (v.refClass === "ai_assistant") add("ai_assistant_ref", day(v.startedAt), v.startedAt, { referrer: v.referrerHost });
  for (const f of forms) {
    const name = String(f.data?.form ?? "");
    const g = f.path ? groupOf(f.path, groups) : null;
    const demo = /demo|sales|contact/i.test(name) || g?.grp === "demo";
    add(demo ? "demo_request" : "form_submit", `${who}:${f.path ?? ""}:${name}:${day(f.at)}`, f.at, { path: f.path, form: name });
  }
  return [...out.values()];
}

/** Account-level signals from the visit history: back after a quiet spell, and several people this week. */
export function accountSignals(account: string, h: { visitAt: number; lastBefore: number | null; peopleThisWeek: number; personId: string | null; firstSeenPerson: boolean }): Signal[] {
  const out: Signal[] = [];
  if (h.lastBefore !== null && h.visitAt - h.lastBefore >= 14 * 86400_000) {
    out.push({ kind: "return_visit", person_id: null, at: h.visitAt, dedupe_key: `return_visit:${account}:${day(h.lastBefore)}`, evidence: { quiet_days: Math.floor((h.visitAt - h.lastBefore) / 86400_000) } });
  }
  if (h.peopleThisWeek >= 3) {
    out.push({ kind: "multi_person", person_id: null, at: h.visitAt, dedupe_key: `multi_person:${account}:${week(h.visitAt)}`, evidence: { people: h.peopleThisWeek } });
  }
  if (h.personId && h.firstSeenPerson) {
    out.push({ kind: "new_person", person_id: h.personId, at: h.visitAt, dedupe_key: `new_person:${account}:${h.personId}`, evidence: {} });
  }
  return out;
}
