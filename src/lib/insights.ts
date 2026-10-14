// Numbers for the Insights page, worked out from a project's runs.

export type RunStatus = "queued" | "running" | "passed" | "failed" | "error" | "canceled";
export type InsightRow = { test_id: string | null; test_name: string; status: RunStatus; verdict: "app_bug" | "flaky" | "setup" | null; retry_of: string | null; ai_calls: number; duration_ms: number | null; created_at: string };
type Row = InsightRow;

export const FINISHED = new Set<RunStatus>(["passed", "failed", "error"]);

/** Share of finished runs that passed. A test with no finished runs sorts after every other. */
const rate = (s: { passed: number; finished: number }) => (s.finished ? s.passed / s.finished : 2);

export type TestStats = { id: string; name: string; runs: number; passed: number; finished: number; flaky: number; appBugs: number; last: Row };

/** Per test: runs, pass rate, flaky count (Judge said flaky, or a re-run passed) and app bugs. Worst first. */
export function statsByTest(rows: Row[]): TestStats[] {
  const byTest = new Map<string, TestStats>();
  for (const r of rows) {
    if (!r.test_id) continue;
    const s = byTest.get(r.test_id) ?? { id: r.test_id, name: r.test_name, runs: 0, passed: 0, finished: 0, flaky: 0, appBugs: 0, last: r };
    s.runs++;
    if (FINISHED.has(r.status)) s.finished++;
    if (r.status === "passed") s.passed++;
    if (r.verdict === "flaky") s.flaky++;
    if (r.verdict === "app_bug") s.appBugs++;
    if (r.created_at > s.last.created_at) s.last = r;
    byTest.set(r.test_id, s);
  }
  return [...byTest.values()].sort((a, b) => b.appBugs - a.appBugs || b.flaky - a.flaky || rate(a) - rate(b) || a.name.localeCompare(b.name));
}
