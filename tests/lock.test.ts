import assert from "node:assert/strict";
import { test } from "node:test";
import { firstError, parseLock } from "../src/lib/lock.ts";
import { lockOutline } from "../src/lib/testfile.ts";

const wrap = (body: string) => `import { test, expect } from '@playwright/test';\n\ntest('Checkout', async ({ page }) => {\n${body}\n});\n`;
const errorsOf = (code: string) => {
  const p = parseLock(code);
  return p.ok ? [] : p.errors.map((e) => e.message);
};

test("a normal lock reads into steps and actions", () => {
  const p = parseLock(
    wrap(`  // step 1: Sign in
  await page.goto('/login');
  await page.getByLabel('Email').fill(process.env.LOGIN_EMAIL);
  await page.getByLabel('Password').fill(process.env.LOGIN_PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  // step 2: check: The cart shows 1 item
  await expect(page.getByTestId('cart-count')).toHaveText('1');
  await expect(page).toHaveURL(/\\/cart$/);
  await expect(page.getByText('Error')).not.toBeVisible();
  // step 3: Press Escape
  await page.keyboard.press('Escape');
  await page.locator('.item').nth(2).hover();`),
  );
  assert.ok(p.ok, firstError(p));
  assert.equal(p.name, "Checkout");
  assert.deepEqual(
    p.steps.map((s) => [s.number, s.label, s.actions.length]),
    [
      [1, "Sign in", 4],
      [2, "check: The cart shows 1 item", 3],
      [3, "Press Escape", 2],
    ],
  );
  assert.deepEqual(p.secrets, ["LOGIN_EMAIL", "LOGIN_PASSWORD"]);
  assert.equal(p.actionCount, 9);
  const click = p.steps[0]!.actions[3]!;
  assert.equal(click.type, "locator");
  assert.deepEqual(click.type === "locator" && click.chain, [{ fn: "getByRole", args: [{ kind: "string", value: "button" }, { kind: "object", entries: { name: { kind: "string", value: "Sign in" }, exact: { kind: "boolean", value: true } } }] }]);
  const notVisible = p.steps[1]!.actions[2]!;
  assert.ok(notVisible.type === "expect" && notVisible.not && notVisible.matcher === "toBeVisible");
  const url = p.steps[1]!.actions[1]!;
  assert.deepEqual(url.type === "expect" && url.args, [{ kind: "regex", source: "\\/cart$", flags: "" }]);
});

test("the outline from the editor is a valid lock with empty steps", () => {
  const out = lockOutline({ name: "Sign up", use_case: "General", priority: "medium", steps: [{ id: "a", kind: "do", text: "Open the site" }, { id: "b", kind: "check", text: "It loads" }] }, []);
  const p = parseLock(out);
  assert.ok(p.ok, firstError(p));
  assert.deepEqual(
    p.steps.map((s) => s.actions.length),
    [0, 0],
  );
});

test("code that could reach the server is refused", () => {
  const cases: [string, RegExp][] = [
    [wrap(`  // step 1: x\n  await page.evaluate(() => fetch('http://169.254.169.254'));`), /evaluate isn't a page action/],
    [wrap(`  // step 1: x\n  const fs = require('fs');`), /should start with await/],
    [wrap(`  // step 1: x\n  await page.goto(process.env.HOME + '/x');`), /Use plain text in quotes/],
    [wrap(`  // step 1: x\n  await page.goto('file:///etc/passwd');`), /goto takes a path/],
    [wrap(`  // step 1: x\n  await page.goto(\`/\${secret}\`);`), /Use plain text in quotes/],
    [wrap(`  // step 1: x\n  await page.context().newPage();`), /context isn't a way to find an element/],
    [wrap(`  // step 1: x\n  await page.getByRole('button').click({ force: true });`), /click takes 0 arguments/],
    [wrap(`  // step 1: x\n  await page.getByRole('button', { onClick: 1 }).click();`), /onClick isn't a setting/],
    [wrap(`  // step 1: x\n  await window.alert(1);`), /Elements should be found from page/],
    [wrap(`  // step 1: x\n  await page.waitForTimeout(60000);`), /up to 10000/],
    ["import fs from 'fs';\ntest('x', async ({ page }) => {});", /Only imports from @playwright\/test/],
    ["console.log(1);\ntest('x', async ({ page }) => {});", /Only imports and one test/],
    ["test('x', async ({ page, request }) => {});", /should take \(\{ page \}\)/],
    ["test('x', ({ page }) => {});", /should be async/],
    ["", /Add a test/],
  ];
  for (const [code, message] of cases) {
    const errors = errorsOf(code);
    assert.ok(
      errors.some((e) => message.test(e)),
      `${message} not in ${JSON.stringify(errors)} for:\n${code}`,
    );
  }
});

test("lines outside a step and steps out of order are caught", () => {
  assert.match(errorsOf(wrap(`  await page.goto('/');`)).join(), /under a \/\/ step comment/);
  assert.match(errorsOf(wrap(`  // step 1: a\n  // step 3: b`)).join(), /count up by one/);
  assert.match(errorsOf(wrap(`  // step 2: a`)).join(), /should be \/\/ step 1/);
});

test("syntax errors come back with a line number", () => {
  const p = parseLock(wrap(`  // step 1: x\n  await page.goto('/';`));
  assert.ok(!p.ok);
  assert.equal(p.errors[0]!.line, 5);
  assert.match(firstError(p), /^Line 5: /);
});
