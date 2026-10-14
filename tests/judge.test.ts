import assert from "node:assert/strict";
import { test } from "node:test";
import { judgeByRules } from "../worker/judge.ts";

test("clear setup problems are sorted with no AI call", () => {
  assert.equal(judgeByRules("page.goto: net::ERR_NAME_NOT_RESOLVED at https://nope.invalid/")?.verdict, "setup");
  assert.equal(judgeByRules("page.goto: net::ERR_CONNECTION_REFUSED")?.verdict, "setup");
  assert.equal(judgeByRules("Claritia blocked 10.0.0.5 because it points to a private network address.")?.verdict, "setup");
  assert.equal(judgeByRules("Add LOGIN_PASSWORD to this environment in Environments.")?.verdict, "setup");
  assert.equal(judgeByRules("This month's AI credits are used up. Upgrade in Settings to write more steps.")?.verdict, "setup");
  assert.equal(judgeByRules("net::ERR_CERT_DATE_INVALID")?.verdict, "setup");
});

test("everything else goes to the Judge", () => {
  assert.equal(judgeByRules("Expected getByText('Saved') to be visible. Got: not visible"), null);
  assert.equal(judgeByRules("locator.click: Timeout 10000ms exceeded."), null);
  assert.equal(judgeByRules("No email reached a1b2c3d4-signup-abc123@inbox.tryclaritia.com within 60 seconds."), null);
});
