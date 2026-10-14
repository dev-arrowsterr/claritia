import assert from "node:assert/strict";
import { test } from "node:test";
import { unzipSync, strFromU8 } from "fflate";
import { parseLock } from "../src/lib/lock.ts";
import { describeAction, exportFiles, importFiles, zipFiles } from "../src/lib/transfer.ts";

const blocks = [{ id: "b0000000-0000-0000-0000-000000000001", name: "Sign in" }];
const lock = `import { test, expect } from '@playwright/test';

test("Checkout", async ({ page }) => {
  // step 1: use: Sign in
  await page.goto('/login');
  await page.getByLabel('Password').fill(process.env.LOGIN_PASSWORD);
  // step 2: Add the hoodie
  await page.getByRole('button', { name: 'Add to cart' }).click();
  // step 3: check: The cart shows 1 item
  await expect(page.getByText('1 item')).toBeVisible();
});
`;
const checkout = { name: "Checkout", use_case: "Shop", priority: "high" as const, steps: [{ id: "s1", kind: "use" as const, block: blocks[0]!.id }, { id: "s2", kind: "do" as const, text: "Add the hoodie" }, { id: "s3", kind: "check" as const, text: "The cart shows 1 item" }], lock };

test("export: YAML and spec per test, a config, and a README naming secrets and unwritten tests", () => {
  const files = exportFiles("Shop", "https://staging.shop.com", [checkout, { name: "Checkout", use_case: "Shop", priority: "low", steps: [{ id: "x", kind: "do", text: "Open the shop" }], lock: null }], blocks);
  assert.deepEqual(Object.keys(files).sort(), [".claritia/README.md", ".claritia/lock/checkout-2.spec.ts", ".claritia/lock/checkout.spec.ts", ".claritia/tests/checkout-2.yaml", ".claritia/tests/checkout.yaml", "playwright.config.ts"]);
  assert.match(files[".claritia/tests/checkout.yaml"]!, /steps:\n {2}- use: sign-in\n {2}- Add the hoodie\n {2}- check: The cart shows 1 item/);
  assert.equal(files[".claritia/lock/checkout.spec.ts"], lock);
  assert.match(files[".claritia/lock/checkout-2.spec.ts"]!, /\/\/ step 1: Open the shop/);
  assert.match(files["playwright.config.ts"]!, /baseURL: process\.env\.BASE_URL \|\| "https:\/\/staging\.shop\.com"/);
  assert.match(files[".claritia/README.md"]!, /LOGIN_PASSWORD=\.\.\. npx playwright test/);
  assert.match(files[".claritia/README.md"]!, /no code yet.*: Checkout/);
  const zip = unzipSync(zipFiles(files));
  assert.equal(strFromU8(zip[".claritia/lock/checkout.spec.ts"]!), lock);
});

test("round trip: an exported pair imports back as the same test with its code", () => {
  const files = exportFiles("Shop", "https://x.com", [checkout], blocks);
  const r = importFiles(Object.entries(files).filter(([p]) => p.endsWith(".yaml") || p.endsWith(".spec.ts")).map(([name, text]) => ({ name, text })), blocks);
  assert.deepEqual(r.skipped, []);
  assert.equal(r.tests.length, 1);
  const t = r.tests[0]!;
  assert.equal(t.name, "Checkout");
  assert.equal(t.use_case, "Shop");
  assert.deepEqual(t.steps.map((s) => s.kind), ["use", "do", "check"]);
  assert.equal(t.lock, lock);
});

test("a plain Playwright spec gets one step per line, named from what it does", () => {
  const spec = `import { test, expect } from '@playwright/test';

test.describe('auth', () => {
  test('Login works', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Email').fill('qa@shop.test');
    await page.getByLabel('Password').fill(process.env.PASSWORD!);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
    await expect(page).toHaveURL(/dashboard/);
  });
  test('Uses raw code', async ({ page }) => {
    await page.evaluate(() => localStorage.clear());
  });
});
`;
  const r = importFiles([{ name: "auth.spec.ts", text: spec }], blocks);
  assert.equal(r.tests.length, 1);
  const t = r.tests[0]!;
  assert.deepEqual(
    t.steps.map((s) => (s.kind === "use" ? "use" : `${s.kind}: ${s.text}`)),
    [
      "do: Go to /login",
      'do: Type "qa@shop.test" into the "Email" field',
      'do: Type "process.env.PASSWORD" into the "Password" field',
      'do: Click the "Sign in" button',
      'check: The "Dashboard" heading shows',
      "check: The address is dashboard",
    ],
  );
  const p = parseLock(t.lock!);
  assert.ok(p.ok);
  assert.equal(p.ok && p.steps[4]!.label, 'check: The "Dashboard" heading shows');
  assert.deepEqual(p.ok && p.secrets, ["PASSWORD"]);
  assert.equal(r.skipped.length, 1);
  assert.match(r.skipped[0]!.reason, /evaluate/);
  assert.equal(r.skipped[0]!.test, "Uses raw code");
});

test("bad files are skipped with a reason", () => {
  const r = importFiles(
    [
      { name: "bad.yaml", text: "steps: [1" },
      { name: "notes.txt", text: "hello" },
      { name: "empty.spec.ts", text: "export const x = 1;" },
    ],
    blocks,
  );
  assert.equal(r.tests.length, 0);
  assert.deepEqual(r.skipped.map((s) => s.file), ["bad.yaml", "notes.txt", "empty.spec.ts"]);
});

test("each kind of action reads as a step", () => {
  const loc = (fn: string, ...args: unknown[]) => ({ fn, args: args.map((v) => (typeof v === "string" ? { kind: "string" as const, value: v } : (v as never))) });
  assert.equal(describeAction({ type: "locator", chain: [loc("getByText", "Remove")], method: "click", args: [], line: 1 }).text, 'Click "Remove"');
  assert.equal(describeAction({ type: "locator", chain: [loc("getByRole", "checkbox", { kind: "object", entries: { name: { kind: "string", value: "Remember me" } } })], method: "check", args: [], line: 1 }).text, 'Tick the "Remember me" checkbox');
  assert.equal(describeAction({ type: "locator", chain: [loc("getByLabel", "Country")], method: "selectOption", args: [{ kind: "string", value: "Japan" }], line: 1 }).text, 'Choose "Japan" in the "Country" field');
  assert.equal(describeAction({ type: "keyboard", method: "press", args: [{ kind: "string", value: "Enter" }], line: 1 }).text, "Press Enter");
  assert.equal(describeAction({ type: "expect", subject: [loc("getByText", "Error")], not: true, matcher: "toBeVisible", args: [], line: 1 }).text, 'Not: "Error" shows');
  assert.equal(describeAction({ type: "locator", chain: [loc("getByRole", "listitem"), { fn: "first", args: [] }], method: "click", args: [], line: 1 }).text, "Click the first of the listitem");
});
