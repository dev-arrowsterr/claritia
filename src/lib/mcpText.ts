// How run results read to a coding agent: what passed, what failed and why, and what to do next.

import type { Outcome } from "./outcome.ts";

const VERDICT: Record<string, string> = {
  app_bug: "App bug (the app did something wrong: fix the code)",
  flaky: "Flaky (failed again on its re-run: likely timing, not your change)",
  setup: "Setup (the site or a secret wasn't reachable: check the address and Environments)",
};

const secs = (ms: number | null) => (ms == null ? "" : ` ${(ms / 1000).toFixed(1)}s`);
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function resultsText(runs: Outcome[], where: string): string {
  const done = runs.filter((r) => r.done);
  const passed = done.filter((r) => r.passed);
  const failed = done.filter((r) => !r.passed);
  const waiting = runs.filter((r) => !r.done);
  const head = [`${passed.length} passed`];
  if (failed.length) head.push(`${failed.length} failed`);
  if (waiting.length) head.push(`${waiting.length} still running`);
  const lines = [`${head.join(", ")} on ${where}.`];

  for (const r of failed) {
    lines.push("", `FAIL ${r.test}: ${r.verdict ? VERDICT[r.verdict] : r.status === "error" ? "Couldn't run" : "Failed"}`);
    if (r.reason) lines.push(`  Why: ${cut(r.reason, 400)}`);
    if (r.failed_step) {
      lines.push(`  Step ${r.failed_step.position}: ${r.failed_step.label}`);
      if (r.failed_step.error) lines.push(`  Error: ${cut(r.failed_step.error.replace(/\s+/g, " "), 500)}`);
    } else if (r.error) lines.push(`  Error: ${cut(r.error.replace(/\s+/g, " "), 500)}`);
    lines.push(`  Run: ${r.url}`);
  }
  for (const r of passed) lines.push(`PASS ${r.test}${r.passed_on_retry ? " (passed on re-run)" : ""}${secs(r.duration_ms)}`);
  if (waiting.length) {
    lines.push("", `Still running: ${waiting.map((r) => r.test).join(", ")}.`, `Call get_results with run_ids ${JSON.stringify(waiting.map((r) => r.id))} to wait for them.`);
  }
  return lines.join("\n");
}
