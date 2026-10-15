import assert from "node:assert/strict";
import { test } from "node:test";
import { decayed, fitV0, intentOf, priorityOf, rawIntent, stageOf, temperatureOf, whyNow, type ScoredSignal } from "../src/lib/web/scores.ts";
import { accountSignals, groupOf, visitSignals } from "../src/lib/web/signals.ts";

const DAY = 86400_000;
const NOW = Date.UTC(2026, 9, 15, 12);
const sig = (kind: string, weight: number, daysAgo: number, person: string | null = null, half = 7): ScoredSignal => ({ kind, weight, half_life_days: half, at: NOW - daysAgo * DAY, person_id: person });
const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);

test("decay halves every half-life", () => {
  near(decayed(sig("page_pricing", 10, 0), NOW), 10);
  near(decayed(sig("page_pricing", 10, 7), NOW), 5);
  near(decayed(sig("page_pricing", 10, 14), NOW), 2.5);
});

test("intent by hand: decay, cap per person, breadth bonus, k", () => {
  // One person, 10 today + 10 a week ago = 15. No cap with one person; no breadth bonus.
  near(rawIntent([sig("page_pricing", 10, 0, "a"), sig("page_pricing", 10, 7, "a")], NOW), 15);
  // Two people: a has 30, b has 10. Total 40, cap 16: a → 16, b → 10. Breadth 1.15. Raw = 26 × 1.15 = 29.9.
  near(rawIntent([sig("x", 30, 0, "a"), sig("x", 10, 0, "b")], NOW), 29.9);
  // Account-level signals aren't capped; three people give breadth 1.3.
  near(rawIntent([sig("x", 10, 0), sig("x", 10, 0, "a"), sig("x", 10, 0, "b"), sig("x", 10, 0, "c")], NOW), 40 * 1.3);
  // Over 90 days old: gone. Negative signals subtract after, floored at 0.
  near(rawIntent([sig("x", 10, 91, "a")], NOW), 0);
  near(rawIntent([sig("x", 10, 0, "a"), sig("deal_stalled", -30, 0)], NOW), 0);
  // intent = 100 × (1 − e^(−raw/k)): raw = k gives 63.
  assert.equal(intentOf(60, 60), 63);
  assert.equal(intentOf(0, 60), 0);
  assert.equal(intentOf(1000, 60), 100);
});

test("fit v0", () => {
  const icp = { industries: { values: ["Software"], weight: 50 }, sizes: { values: ["51-200", "201-500"], weight: 30 }, countries: { values: ["US"], weight: 20, required: true } };
  assert.equal(fitV0({ industry: "software", size: "51-200", country: "US" }, icp), 100);
  assert.equal(fitV0({ industry: "Software", size: "11-50", country: "US" }, icp), 70);
  assert.equal(fitV0({ industry: "Software", size: "51-200", country: "DE" }, icp), 30, "a missed required field caps fit at 30");
  assert.equal(fitV0(null, icp), null);
  assert.equal(fitV0({ industry: "Software" }, null), null);
});

test("stage moves forward, and back only after quiet spells", () => {
  assert.equal(stageOf([], NOW, null), "unknown");
  assert.equal(stageOf([sig("engaged_session", 4, 3, "a")], NOW, null), "engaged");
  assert.equal(stageOf([sig("page_pricing", 10, 3, "a")], NOW, null), "researching");
  assert.equal(stageOf([sig("demo_request", 25, 3, "a")], NOW, null), "evaluating");
  assert.equal(stageOf([sig("page_pricing", 10, 2, "a"), sig("page_security", 9, 1, "b")], NOW, null), "evaluating", "pricing and security by 2 people");
  assert.equal(stageOf([sig("engaged_session", 4, 3, "a")], NOW, "evaluating"), "evaluating", "never back on its own while active");
  assert.equal(stageOf([sig("page_pricing", 10, 50, "a")], NOW, "evaluating"), "engaged", "45 quiet days");
  assert.equal(stageOf([sig("page_pricing", 10, 95, "a")], NOW, "evaluating"), "unknown", "90 quiet days");
});

test("temperature and priority", () => {
  const busyWeek = [sig("x", 30, 1, "a"), sig("x", 30, 2, "b"), sig("x", 5, 20, "a")];
  assert.equal(temperatureOf(busyWeek, NOW, 60), "hot");
  assert.equal(temperatureOf(busyWeek, NOW, 20), "steady", "hot needs intent 40+");
  // Week 0.91 vs weekly pace (13.8 + 0.91) / 4 = 3.68: ratio 0.25.
  assert.equal(temperatureOf([sig("x", 100, 20, "a"), sig("x", 1, 1, "a")], NOW, 30), "cooling");
  assert.equal(temperatureOf([], NOW, 0), "cold");
  // 80 × (0.4 + 0.6 × 0.5) × 1.3 × 1.2 = 87.36
  assert.equal(priorityOf(80, 50, "evaluating", false), 87.4);
  assert.equal(priorityOf(80, null, "evaluating", true), 72.8, "unknown fit counts as 50");
});

test("why-now names the two biggest things this week", () => {
  const w = whyNow([sig("page_pricing", 10, 1, "a"), sig("page_pricing", 10, 1, "b"), sig("page_security", 9, 0, "a"), sig("engaged_session", 4, 0, "a"), sig("demo_request", 25, 10, "a")], NOW);
  assert.deepEqual(w.top.map((t) => t.kind), ["page_pricing", "page_security"]);
  assert.equal(w.text, "This week: 2 people read pricing, and checked security.");
  assert.equal(whyNow([], NOW).text, "");
});

test("page groups: the team's first, then common paths", () => {
  assert.equal(groupOf("/pricing", [])?.grp, "pricing");
  assert.equal(groupOf("/plans/enterprise?x=1", [])?.grp, "pricing");
  assert.deepEqual(groupOf("/vs/warmly", []), { grp: "compare", competitor: "warmly" });
  assert.deepEqual(groupOf("/hubspot-alternatives", []), { grp: "compare", competitor: "hubspot" });
  assert.equal(groupOf("/trust", [])?.grp, "security");
  assert.equal(groupOf("/blog/how-we-price", []), null);
  assert.equal(groupOf("/how-it-costs", [{ pattern: "/how-it-costs", grp: "pricing" }])?.grp, "pricing");
  assert.equal(groupOf("/pricing", [{ pattern: "/pricing", grp: "other" }])?.grp, "other", "the team's group wins");
});

test("a visit's signals, with dedupe keys", () => {
  const v = {
    id: "s1", startedAt: NOW, personId: "p1", personLevel: "asserted", refClass: "review_site", referrerHost: "g2.com",
    events: [
      { kind: "view", path: "/pricing", at: NOW, data: null },
      { kind: "view", path: "/pricing?plan=pro", at: NOW + 1000, data: null },
      { kind: "view", path: "/vs/acme", at: NOW + 2000, data: null },
      ...["/docs/a", "/docs/b", "/docs/c", "/docs/d", "/docs/e"].map((p, i) => ({ kind: "view", path: p, at: NOW + 3000 + i, data: null })),
      { kind: "engage", path: "/pricing", at: NOW + 9000, data: { active_s: 200 } },
      { kind: "form", path: "/demo", at: NOW + 10_000, data: { form: "demo-form" } },
    ],
  };
  const s = visitSignals("acc", v, []);
  assert.deepEqual(s.map((x) => x.kind).sort(), ["demo_request", "docs_depth", "engaged_session", "page_compare", "page_pricing", "review_site_ref"]);
  assert.ok(s.every((x) => x.dedupe_key.startsWith(`${x.kind}:acc:`)));
  assert.deepEqual(visitSignals("acc", v, []).map((x) => x.dedupe_key), s.map((x) => x.dedupe_key), "same visit, same keys");
  // Probable people give signals to the account only.
  assert.ok(visitSignals("acc", { ...v, personLevel: "probable" }, []).every((x) => x.person_id === null));
  // Only careers pages: a job seeker, nothing.
  assert.deepEqual(visitSignals("acc", { ...v, refClass: null, events: [{ kind: "view", path: "/careers", at: NOW, data: null }] }, []), []);
});

test("account signals: return visit, several people, new person", () => {
  const s = accountSignals("acc", { visitAt: NOW, lastBefore: NOW - 20 * DAY, peopleThisWeek: 3, personId: "p", firstSeenPerson: true });
  assert.deepEqual(s.map((x) => x.kind), ["return_visit", "multi_person", "new_person"]);
  assert.deepEqual(accountSignals("acc", { visitAt: NOW, lastBefore: NOW - 3 * DAY, peopleThisWeek: 1, personId: null, firstSeenPerson: false }), []);
});

test("account alert rules fire on the change, not after it", async () => {
  const { parseRule, ruleFires, ruleText } = await import("../src/lib/web/accountAlerts.ts");
  const snap = (temperature: string | null, stage: string | null, intent: number | null, fit: number | null) => ({ temperature, stage, intent, fit });
  const hot = parseRule({ when: "hot", fit_min: 60 })!;
  assert.ok(ruleFires(hot, snap("steady", "researching", 40, 80), snap("hot", "researching", 55, 80)));
  assert.ok(!ruleFires(hot, snap("hot", "researching", 40, 80), snap("hot", "researching", 60, 80)), "already hot");
  assert.ok(!ruleFires(hot, snap("steady", null, 40, 40), snap("hot", null, 60, 40)), "below the fit");
  assert.ok(ruleFires(hot, snap("steady", null, 40, null), snap("hot", null, 60, null)) === false, "unknown fit counts as 50, below 60");
  const intent = parseRule({ when: "intent", intent: 70 })!;
  assert.ok(ruleFires(intent, snap(null, null, 69, null), snap(null, null, 70, null)));
  assert.ok(!ruleFires(intent, snap(null, null, 70, null), snap(null, null, 80, null)));
  assert.ok(ruleFires(parseRule({ when: "evaluating" })!, snap(null, "researching", 1, 1), snap(null, "evaluating", 1, 1)));
  assert.equal(parseRule({ when: "intent", intent: 0 }), null);
  assert.equal(parseRule({ when: "nope" }), null);
  assert.equal(ruleText(hot), "When an account turns hot with fit 60+");
});
