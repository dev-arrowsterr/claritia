import assert from "node:assert/strict";
import { test } from "node:test";
import { allowedRoute, defaultRoute, navFor, showsProjectPicker } from "../src/lib/nav.ts";

const routes = (f: string[]) => navFor(f).map((n) => n.route);

test("a testing-only workspace sees the app exactly as before", () => {
  assert.deepEqual(routes(["testing"]), ["tests", "blocks", "map", "runs", "environments", "schedules", "approvals", "insights", "settings"]);
  assert.equal(defaultRoute(["testing"]), "tests");
  assert.equal(allowedRoute(["testing"], "visitors"), "tests");
  assert.ok(showsProjectPicker(["testing"], "tests"));
});

test("a marketing-only workspace sees no testing screens and no project picker", () => {
  assert.deepEqual(routes(["marketing"]), ["visitors", "accounts", "journeys", "pages", "reports", "settings"]);
  assert.equal(defaultRoute(["marketing"]), "visitors");
  assert.equal(allowedRoute(["marketing"], "runs"), "visitors");
  assert.ok(!showsProjectPicker(["marketing"], "settings"));
});

test("with both, testing sits under one Testing group after the marketing screens", () => {
  const nav = navFor(["testing", "marketing"]);
  assert.deepEqual(nav.map((n) => n.route).slice(0, 6), ["visitors", "accounts", "journeys", "pages", "reports", "tests"]);
  assert.equal(nav.find((n) => n.route === "tests")!.group, "Testing");
  assert.equal(nav.find((n) => n.route === "runs")!.group, undefined);
  assert.equal(allowedRoute(["testing", "marketing"], "runs"), "runs");
  assert.ok(showsProjectPicker(["testing", "marketing"], "runs"));
  assert.ok(!showsProjectPicker(["testing", "marketing"], "visitors"));
});

test("no features falls back to the testing product", () => {
  assert.equal(defaultRoute([]), "tests");
  assert.ok(routes([]).includes("tests"));
});

test("the person page opens from marketing screens only", () => {
  assert.equal(allowedRoute(["marketing"], "people"), "people");
  assert.equal(allowedRoute(["testing"], "people"), "tests");
  assert.ok(!routes(["marketing"]).includes("people"), "it isn't in the sidebar");
});
