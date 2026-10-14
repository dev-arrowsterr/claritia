import assert from "node:assert/strict";
import { test } from "node:test";
import { hashKey, KEY_PATTERN, keyFromHeader, makeKey } from "../src/lib/apiKeys.ts";
import { outcomeOf, RETRY_GRACE_MS, type OutcomeRun } from "../src/lib/outcome.ts";

test("a new key has the clr_ shape, a 64-character hash and an 8-character prefix", () => {
  const { key, hash, prefix } = makeKey();
  assert.match(key, KEY_PATTERN);
  assert.equal(hash, hashKey(key));
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(prefix, key.slice(0, 8));
  assert.notEqual(makeKey().key, key);
});

test("the key is read from a Bearer header, and anything else is refused", () => {
  const { key } = makeKey();
  assert.equal(keyFromHeader(`Bearer ${key}`), key);
  assert.equal(keyFromHeader(`bearer  ${key} `), key);
  assert.equal(keyFromHeader(null), null);
  assert.equal(keyFromHeader("Bearer eyJhbGciOi.a-supabase-token"), null);
  assert.equal(keyFromHeader(`Bearer ${key}x`), null);
});

const NOW = Date.parse("2026-10-14T12:00:00Z");
const run = (over: Partial<OutcomeRun>): OutcomeRun => ({
  id: "r1",
  test_id: "t1",
  test_name: "Checkout",
  environment_name: "staging",
  status: "passed",
  verdict: null,
  verdict_reason: null,
  error: null,
  duration_ms: 1000,
  finished_at: "2026-10-14T11:59:00Z",
  retry_of: null,
  retried_as: null,
  ...over,
});
const of = (start: OutcomeRun, ...more: OutcomeRun[]) => outcomeOf(start, new Map([start, ...more].map((r) => [r.id, r])), [], NOW);

test("a passing run is done and passed", () => {
  const o = of(run({}));
  assert.equal(o.done, true);
  assert.equal(o.passed, true);
  assert.equal(o.passed_on_retry, false);
  assert.match(o.url, /\/runs\/r1$/);
});

test("waiting and running runs aren't done", () => {
  assert.equal(of(run({ status: "queued", finished_at: null })).done, false);
  assert.equal(of(run({ status: "running", finished_at: null })).done, false);
});

test("an app bug is done and failed", () => {
  const o = of(run({ status: "failed", verdict: "app_bug", verdict_reason: "Save answers 500." }));
  assert.equal(o.done, true);
  assert.equal(o.passed, false);
  assert.equal(o.reason, "Save answers 500.");
});

test("a flaky failure that passes on its re-run counts as passed", () => {
  const o = of(run({ status: "failed", verdict: "flaky", retried_as: "r2" }), run({ id: "r2", retry_of: "r1", status: "passed" }));
  assert.equal(o.done, true);
  assert.equal(o.passed, true);
  assert.equal(o.passed_on_retry, true);
  assert.equal(o.final_id, "r2");
  assert.match(o.url, /\/runs\/r2$/);
});

test("a flaky failure isn't done while its re-run runs, or before the re-run is queued", () => {
  assert.equal(of(run({ status: "failed", verdict: "flaky", retried_as: "r2" }), run({ id: "r2", retry_of: "r1", status: "queued", finished_at: null })).done, false);
  // The verdict is saved a moment before the re-run is queued.
  assert.equal(of(run({ status: "failed", verdict: "flaky", finished_at: new Date(NOW - 5_000).toISOString() })).done, false);
  // A re-run that isn't loaded yet.
  assert.equal(of(run({ status: "failed", verdict: "flaky", retried_as: "r2" })).done, false);
});

test("a flaky failure with no re-run counts as failed after the wait", () => {
  const o = of(run({ status: "failed", verdict: "flaky", finished_at: new Date(NOW - RETRY_GRACE_MS - 1).toISOString() }));
  assert.equal(o.done, true);
  assert.equal(o.passed, false);
});

test("a re-run that fails again is the outcome", () => {
  const o = of(run({ status: "failed", verdict: "flaky", retried_as: "r2" }), run({ id: "r2", retry_of: "r1", status: "failed", verdict: "flaky", finished_at: new Date(NOW - 1000).toISOString() }));
  assert.equal(o.done, true);
  assert.equal(o.passed, false);
  assert.equal(o.verdict, "flaky");
});

test("the first failed step of the deciding run is named", () => {
  const start = run({ status: "failed", verdict: "app_bug" });
  const o = outcomeOf(start, new Map([[start.id, start]]), [
    { run_id: "r1", position: 3, label: "Check: It says saved", error: "not visible" },
    { run_id: "r1", position: 2, label: "Save", error: "timeout" },
    { run_id: "other", position: 1, label: "x", error: null },
  ], NOW);
  assert.deepEqual(o.failed_step, { position: 2, label: "Save", error: "timeout" });
});
