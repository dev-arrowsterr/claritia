import assert from "node:assert/strict";
import { test } from "node:test";
import { statsByTest, type InsightRow } from "../src/lib/insights.ts";
import { describeSchedule } from "../src/lib/schedules.ts";

test("schedules read in plain words", () => {
  assert.equal(describeSchedule({ every: "hour", at_hour: 0, at_minute: 15, weekday: 0, timezone: "UTC" }), "Every hour at :15");
  assert.equal(describeSchedule({ every: "day", at_hour: 9, at_minute: 0, weekday: 0, timezone: "Asia/Tokyo" }), "Every day at 09:00 (Asia/Tokyo)");
  assert.equal(describeSchedule({ every: "weekday", at_hour: 7, at_minute: 30, weekday: 0, timezone: "UTC" }), "Weekdays at 07:30 (UTC)");
  assert.equal(describeSchedule({ every: "week", at_hour: 18, at_minute: 45, weekday: 3, timezone: "UTC" }), "Every Wednesday at 18:45 (UTC)");
});

test("tests are ranked worst first, with flaky and app bug counts", () => {
  const r = (test_id: string, status: InsightRow["status"], verdict: InsightRow["verdict"] = null, created_at = "2026-10-14T00:00:00Z"): InsightRow => ({ test_id, test_name: test_id, status, verdict, retry_of: null, ai_calls: 0, duration_ms: 1000, created_at });
  const stats = statsByTest([r("good", "passed"), r("good", "passed"), r("shaky", "failed", "flaky"), r("shaky", "passed"), r("broken", "failed", "app_bug"), r("broken", "failed", "app_bug", "2026-10-14T05:00:00Z"), r("waiting", "queued")]);
  assert.deepEqual(stats.map((s) => s.id), ["broken", "shaky", "good", "waiting"]);
  const broken = stats[0]!;
  assert.equal(broken.appBugs, 2);
  assert.equal(broken.last.created_at, "2026-10-14T05:00:00Z");
  assert.equal(stats[1]!.flaky, 1);
  assert.equal(stats[1]!.passed, 1);
  assert.equal(stats.find((s) => s.id === "waiting")!.finished, 0);
});
