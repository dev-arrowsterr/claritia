import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanSteps, fromYaml, lockOutline, lockPath, slug, testPath, TestFileError, toYaml, type Step, type TestDoc } from "../src/lib/testfile.ts";

const BLOCKS = [{ id: "11111111-1111-1111-1111-111111111111", name: "Sign in" }];
const DOC: TestDoc = {
  name: "Checkout with a coupon",
  use_case: "Checkout",
  priority: "high",
  steps: [
    { id: "a", kind: "use", block: BLOCKS[0]!.id },
    { id: "b", kind: "do", text: "Add the blue hoodie to the cart" },
    { id: "c", kind: "check", text: "The total drops 10%" },
  ],
};

test("a test becomes readable YAML", () => {
  assert.equal(
    toYaml(DOC, BLOCKS),
    ["name: Checkout with a coupon", "use_case: Checkout", "priority: high", "steps:", "  - use: sign-in", "  - Add the blue hoodie to the cart", "  - check: The total drops 10%", ""].join("\n"),
  );
});

test("YAML reads back to the same test, keeping step ids", () => {
  assert.deepEqual(fromYaml(toYaml(DOC, BLOCKS), BLOCKS, DOC.steps), DOC);
});

test("edited YAML keeps ids for steps that didn't change and makes new ones for new steps", () => {
  const yaml = toYaml(DOC, BLOCKS).replace("  - check: The total drops 10%", "  - Apply the coupon SAVE10\n  - check: The total drops 10%");
  const out = fromYaml(yaml, BLOCKS, DOC.steps);
  assert.deepEqual(
    out.steps.map((s) => s.id),
    ["a", "b", out.steps[2]!.id, "c"],
  );
  assert.ok(!["a", "b", "c"].includes(out.steps[2]!.id));
});

test("missing fields get defaults", () => {
  const out = fromYaml("name: Smoke\nsteps:\n  - Open the home page\n", []);
  assert.equal(out.use_case, "General");
  assert.equal(out.priority, "medium");
  assert.equal(out.steps.length, 1);
});

test("a do: key works like plain text, and numbers are allowed", () => {
  const out = fromYaml("name: T\nsteps:\n  - do: Click Pay\n  - check: 42\n", []);
  assert.deepEqual(
    out.steps.map((s) => (s.kind === "use" ? s.block : `${s.kind}:${s.text}`)),
    ["do:Click Pay", "check:42"],
  );
});

test("mistakes come back as plain messages", () => {
  const bad: [string, RegExp][] = [
    ["name: [", /can't be read/],
    ["- just a list", /top level/],
    ["steps: []", /Add a name/],
    ["name: T\npriority: urgent", /low, medium or high/],
    ["name: T\nsteps: Click Pay", /should be a list/],
    ["name: T\nsteps:\n  - use: log-out", /no block called "log-out"/],
    ["name: T\nsteps:\n  - click: Pay", /Step 1: use plain text/],
    ["name: T\nsteps:\n  - ''", /Step 1 is empty/],
    ["name: T\nsteps:\n  - {check: a, do: b}", /Step 1: use plain text/],
    [`name: T\nsteps:\n  - ${"x".repeat(501)}`, /longer than 500/],
    [`name: ${"x".repeat(121)}`, /name is longer/],
  ];
  for (const [yaml, message] of bad) assert.throws(() => fromYaml(yaml, BLOCKS), (e: unknown) => e instanceof TestFileError && message.test(e.message), yaml);
});

test("too many steps are refused", () => {
  const yaml = "name: T\nsteps:\n" + Array.from({ length: 201 }, (_, i) => `  - Step ${i}`).join("\n");
  assert.throws(() => fromYaml(yaml, []), /up to 200 steps/);
});

test("slugs and file paths", () => {
  assert.equal(slug("Sign in with Google!"), "sign-in-with-google");
  assert.equal(slug("Café checkout"), "cafe-checkout");
  assert.equal(slug("***"), "untitled");
  assert.equal(testPath("Checkout with a coupon"), ".claritia/tests/checkout-with-a-coupon.yaml");
  assert.equal(lockPath("Checkout with a coupon"), ".claritia/lock/checkout-with-a-coupon.spec.ts");
});

test("empty steps are dropped and text is trimmed before saving", () => {
  const steps: Step[] = [
    { id: "a", kind: "do", text: "  Click Pay  " },
    { id: "b", kind: "check", text: "   " },
    { id: "c", kind: "use", block: "x" },
  ];
  assert.deepEqual(cleanSteps(steps), [
    { id: "a", kind: "do", text: "Click Pay" },
    { id: "c", kind: "use", block: "x" },
  ]);
});

test("the lock outline lists every step and can't be broken by a step's text", () => {
  const out = lockOutline({ ...DOC, steps: [...DOC.steps, { id: "d", kind: "do", text: "Close */ the menu" }] }, BLOCKS);
  assert.match(out, /test\("Checkout with a coupon"/);
  assert.match(out, /\/\/ step 1: use: Sign in/);
  assert.match(out, /\/\/ step 3: check: The total drops 10%/);
  assert.doesNotMatch(out, /Close \*\//);
});
