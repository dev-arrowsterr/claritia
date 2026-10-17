import assert from "node:assert/strict";
import { test } from "node:test";
import { SETTINGS_GROUPS, settingsTab } from "../src/lib/settingsTabs.ts";

test("settings lead with the CRM connection, sending domains and the team", () => {
  assert.deepEqual(
    SETTINGS_GROUPS.slice(0, 3).map((g) => [g.label, g.tabs[0].id]),
    [
      ["CRM", "sources"],
      ["Email", "domains"],
      ["Team", "team"],
    ],
  );
  const ids = SETTINGS_GROUPS.flatMap((g) => g.tabs.map((t) => t.id));
  assert.equal(new Set(ids).size, ids.length, "each page once");
  for (const gone of ["project", "github", "test_alerts", "plan"]) assert.ok(!(ids as string[]).includes(gone), `${gone} is gone`);
});

test("old and unknown settings addresses land on a real page", () => {
  assert.equal(settingsTab("team"), "team");
  assert.equal(settingsTab("suite"), "sources");
  assert.equal(settingsTab("github"), "sources");
  assert.equal(settingsTab(""), "sources");
});
