import assert from "node:assert/strict";
import { test } from "node:test";
import { settingsGroups } from "../src/lib/settingsTabs.ts";

const ids = (f: string[], p = true) => settingsGroups(f, p).flatMap((g) => g.tabs.map((t) => t.id));

test("marketing workspaces see website and scoring pages and no testing pages", () => {
  assert.deepEqual(ids(["marketing"]), ["fields", "objects", "sources", "imports", "sync_log", "sites", "identity", "icp", "account_alerts", "workspace", "keys", "profile"]);
});

test("testing workspaces see the testing pages and plan", () => {
  assert.deepEqual(ids(["testing"]), ["project", "github", "test_alerts", "workspace", "keys", "plan", "profile"]);
  assert.ok(!ids(["testing"], false).includes("project"), "no project, no project pages");
});
