import assert from "node:assert/strict";
import { test } from "node:test";
import { shouldSleep } from "../worker/idle.ts";

test("the runner sleeps only when idle long enough with nothing running", () => {
  const base = { idleExitMs: 300_000, lastWorkAt: 0 };
  assert.equal(shouldSleep({ ...base, now: 299_999, running: 0 }), false);
  assert.equal(shouldSleep({ ...base, now: 300_000, running: 0 }), true);
  assert.equal(shouldSleep({ ...base, now: 900_000, running: 1 }), false, "never while a run is going");
  assert.equal(shouldSleep({ idleExitMs: 0, lastWorkAt: 0, now: 9e9, running: 0 }), false, "off unless IDLE_EXIT_MS is set");
});
