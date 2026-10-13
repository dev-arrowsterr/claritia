// The lock: the Playwright code that runs a test. It reads like a normal Playwright spec,
// but Claritia never runs it as JavaScript. This file reads it into a list of allowed actions,
// and the runner carries those out. Anything outside the list is an error, so test code can't
// reach the server, its files or its keys.
//
//   import { test, expect } from '@playwright/test';
//
//   test('Checkout with a coupon', async ({ page }) => {
//     // step 1: Add the blue hoodie to the cart
//     await page.goto('/products/blue-hoodie');
//     await page.getByRole('button', { name: 'Add to cart' }).click();
//     // step 2: check: The cart shows 1 item
//     await expect(page.getByTestId('cart-count')).toHaveText('1');
//   });
//
// Secrets come in as process.env.NAME and are filled in at run time from the environment's secrets.

import ts from "typescript";

export type Arg =
  | { kind: "string"; value: string }
  | { kind: "number"; value: number }
  | { kind: "boolean"; value: boolean }
  | { kind: "regex"; source: string; flags: string }
  | { kind: "secret"; name: string }
  | { kind: "object"; entries: Record<string, Arg> }
  | { kind: "array"; items: Arg[] };

export type Call = { fn: string; args: Arg[] };

export type Action =
  | { type: "page"; method: string; args: Arg[]; line: number }
  | { type: "keyboard"; method: string; args: Arg[]; line: number }
  | { type: "locator"; chain: Call[]; method: string; args: Arg[]; line: number }
  | { type: "expect"; subject: "page" | Call[]; not: boolean; matcher: string; args: Arg[]; line: number };

export type LockStep = { number: number; label: string; actions: Action[] };
export type LockError = { line: number; message: string };
export type ParsedLock = { ok: true; name: string; steps: LockStep[]; secrets: string[]; actionCount: number } | { ok: false; errors: LockError[] };

// What a locator can be built from, and what it can do.
const LOCATOR_BUILDERS = new Set(["getByRole", "getByText", "getByLabel", "getByPlaceholder", "getByAltText", "getByTitle", "getByTestId", "locator"]);
const LOCATOR_REFINERS = new Set(["first", "last", "nth", "filter"]);
const LOCATOR_ACTIONS: Record<string, [number, number]> = {
  click: [0, 0],
  dblclick: [0, 0],
  fill: [1, 1],
  clear: [0, 0],
  press: [1, 1],
  pressSequentially: [1, 1],
  check: [0, 0],
  uncheck: [0, 0],
  setChecked: [1, 1],
  selectOption: [1, 1],
  hover: [0, 0],
  focus: [0, 0],
  scrollIntoViewIfNeeded: [0, 0],
  waitFor: [0, 1],
};
const PAGE_ACTIONS: Record<string, [number, number]> = {
  goto: [1, 1],
  reload: [0, 0],
  goBack: [0, 0],
  goForward: [0, 0],
  waitForURL: [1, 1],
  waitForLoadState: [0, 1],
  waitForTimeout: [1, 1],
};
const KEYBOARD_ACTIONS: Record<string, [number, number]> = { press: [1, 1], type: [1, 1], insertText: [1, 1] };
const LOCATOR_MATCHERS: Record<string, [number, number]> = {
  toBeVisible: [0, 0],
  toBeHidden: [0, 0],
  toBeEnabled: [0, 0],
  toBeDisabled: [0, 0],
  toBeChecked: [0, 0],
  toBeEmpty: [0, 0],
  toBeFocused: [0, 0],
  toHaveText: [1, 1],
  toContainText: [1, 1],
  toHaveValue: [1, 1],
  toHaveCount: [1, 1],
  toHaveAttribute: [1, 2],
};
const PAGE_MATCHERS: Record<string, [number, number]> = { toHaveURL: [1, 1], toHaveTitle: [1, 1] };
const OPTION_KEYS = new Set(["name", "exact", "hasText", "hasNotText", "level", "checked", "selected", "pressed", "expanded", "disabled", "includeHidden", "state"]);
const MAX_WAIT_MS = 10_000;
const MAX_ACTIONS = 1000;

const STEP_COMMENT = /^\/\/\s*step\s+(\d+)\s*:?\s*(.*)$/i;

class ReadError extends Error {
  node: ts.Node;
  constructor(node: ts.Node, message: string) {
    super(message);
    this.node = node;
  }
}

/** Read the lock. Returns every problem found, each with its line number. */
export function parseLock(code: string): ParsedLock {
  const sf = ts.createSourceFile("lock.spec.ts", code, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const errors: LockError[] = [];
  const lineOf = (pos: number) => sf.getLineAndCharacterOfPosition(pos).line + 1;
  const fail = (node: ts.Node, message: string) => errors.push({ line: lineOf(node.getStart(sf)), message });

  // Syntax errors first: nothing else is worth checking if the code doesn't parse.
  const syntax = (sf as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics ?? [];
  if (syntax.length) {
    return { ok: false, errors: syntax.slice(0, 5).map((d) => ({ line: lineOf(d.start ?? 0), message: ts.flattenDiagnosticMessageText(d.messageText, " ") })) };
  }

  let testCall: ts.CallExpression | null = null;
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st)) {
      const from = ts.isStringLiteral(st.moduleSpecifier) ? st.moduleSpecifier.text : "";
      if (from !== "@playwright/test") fail(st, `Only imports from @playwright/test are allowed.`);
      continue;
    }
    if (ts.isExpressionStatement(st) && ts.isCallExpression(st.expression) && ts.isIdentifier(st.expression.expression) && st.expression.expression.text === "test") {
      if (testCall) fail(st, "A lock holds one test.");
      else testCall = st.expression;
      continue;
    }
    fail(st, "Only imports and one test(...) are allowed at the top level.");
  }
  if (!testCall) {
    if (!errors.length) errors.push({ line: 1, message: "Add a test: test('Name', async ({ page }) => { ... });" });
    return { ok: false, errors };
  }

  const [nameArg, fnArg, ...rest] = testCall.arguments;
  const name = nameArg && (ts.isStringLiteral(nameArg) || ts.isNoSubstitutionTemplateLiteral(nameArg)) ? nameArg.text : null;
  if (name === null) fail(testCall, "The test needs a name in quotes.");
  if (rest.length) fail(testCall, "test(...) takes a name and one function.");
  if (!fnArg || !(ts.isArrowFunction(fnArg) || ts.isFunctionExpression(fnArg)) || !fnArg.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) || !ts.isBlock(fnArg.body)) {
    fail(testCall, "The test's function should be async ({ page }) => { ... }.");
    return { ok: false, errors };
  }
  const param = fnArg.parameters[0];
  const pageParamOk =
    fnArg.parameters.length === 1 &&
    param &&
    ts.isObjectBindingPattern(param.name) &&
    param.name.elements.length === 1 &&
    ts.isIdentifier(param.name.elements[0]!.name) &&
    param.name.elements[0]!.name.text === "page" &&
    !param.name.elements[0]!.propertyName;
  if (!pageParamOk) fail(fnArg, "The test's function should take ({ page }).");

  // Step comments split the body into steps. Read them from the raw text so empty steps count too.
  const body = fnArg.body;
  const marks: { pos: number; number: number; label: string }[] = [];
  const bodyText = code.slice(body.getStart(sf), body.getEnd());
  const re = /\/\/[^\n]*/g;
  for (let m = re.exec(bodyText); m; m = re.exec(bodyText)) {
    const hit = STEP_COMMENT.exec(m[0].trim());
    if (hit) marks.push({ pos: body.getStart(sf) + m.index, number: Number(hit[1]), label: hit[2]!.trim() });
  }
  for (let i = 1; i < marks.length; i++) {
    if (marks[i]!.number !== marks[i - 1]!.number + 1) errors.push({ line: lineOf(marks[i]!.pos), message: `Steps should count up by one: step ${marks[i - 1]!.number} is followed by step ${marks[i]!.number}.` });
  }
  if (marks[0] && marks[0].number !== 1) errors.push({ line: lineOf(marks[0].pos), message: "The first step comment should be // step 1." });

  const steps: LockStep[] = marks.map((m) => ({ number: m.number, label: m.label, actions: [] }));
  const secrets = new Set<string>();
  let count = 0;

  for (const st of body.statements) {
    const pos = st.getStart(sf);
    const stepIndex = marks.filter((m) => m.pos < pos).length - 1;
    if (stepIndex < 0) {
      fail(st, "Put each line under a // step comment, like // step 1: Open the home page.");
      continue;
    }
    try {
      const action = readStatement(st, sf, secrets);
      steps[stepIndex]!.actions.push(action);
      if (++count > MAX_ACTIONS) throw new ReadError(st, `A test can have up to ${MAX_ACTIONS} lines.`);
    } catch (e) {
      if (e instanceof ReadError) fail(e.node, e.message);
      else throw e;
    }
  }

  if (errors.length) return { ok: false, errors: errors.sort((a, b) => a.line - b.line) };
  return { ok: true, name: name!, steps, secrets: [...secrets].sort(), actionCount: count };
}

function readStatement(st: ts.Statement, sf: ts.SourceFile, secrets: Set<string>): Action {
  const line = sf.getLineAndCharacterOfPosition(st.getStart(sf)).line + 1;
  if (!ts.isExpressionStatement(st) || !ts.isAwaitExpression(st.expression) || !ts.isCallExpression(st.expression.expression)) {
    throw new ReadError(st, "Each line should start with await, like await page.goto('/').");
  }
  const call = st.expression.expression;
  if (!ts.isPropertyAccessExpression(call.expression)) throw new ReadError(call, "This line isn't a Claritia action.");
  const method = call.expression.name.text;
  const target = call.expression.expression;
  const args = () => call.arguments.map((a) => readArg(a, secrets));

  // await expect(x)[.not].matcher(...)
  const expectInfo = readExpectTarget(target);
  if (expectInfo) {
    const subjectNode = expectInfo.subject;
    if (ts.isIdentifier(subjectNode) && subjectNode.text === "page") {
      checkArity(call, method, PAGE_MATCHERS, "check on the page");
      return { type: "expect", subject: "page", not: expectInfo.not, matcher: method, args: args(), line };
    }
    const chain = readLocatorChain(subjectNode, secrets);
    checkArity(call, method, LOCATOR_MATCHERS, "check on an element");
    return { type: "expect", subject: chain, not: expectInfo.not, matcher: method, args: args(), line };
  }

  // await page.method(...)
  if (ts.isIdentifier(target) && target.text === "page") {
    checkArity(call, method, PAGE_ACTIONS, "page action");
    const a = args();
    if (method === "waitForTimeout" && (a[0]?.kind !== "number" || a[0].value < 0 || a[0].value > MAX_WAIT_MS)) throw new ReadError(call, `waitForTimeout takes a number of milliseconds up to ${MAX_WAIT_MS}.`);
    if (method === "goto" && a[0]?.kind === "string" && !/^(\/|https?:\/\/)/i.test(a[0].value)) throw new ReadError(call, "goto takes a path like '/pricing' or a full http(s) address.");
    return { type: "page", method, args: a, line };
  }

  // await page.keyboard.method(...)
  if (ts.isPropertyAccessExpression(target) && target.name.text === "keyboard" && ts.isIdentifier(target.expression) && target.expression.text === "page") {
    checkArity(call, method, KEYBOARD_ACTIONS, "keyboard action");
    return { type: "keyboard", method, args: args(), line };
  }

  // await page.getByRole(...).first().click()
  const chain = readLocatorChain(target, secrets);
  checkArity(call, method, LOCATOR_ACTIONS, "element action");
  return { type: "locator", chain, method, args: args(), line };
}

function checkArity(call: ts.CallExpression, method: string, table: Record<string, [number, number]>, what: string) {
  const range = table[method];
  if (!range) throw new ReadError(call, `${method} isn't a ${what} Claritia can run. Use one of: ${Object.keys(table).join(", ")}.`);
  const n = call.arguments.length;
  if (n < range[0] || n > range[1]) throw new ReadError(call, `${method} takes ${range[0] === range[1] ? range[0] : `${range[0]} to ${range[1]}`} argument${range[1] === 1 ? "" : "s"}.`);
}

function readExpectTarget(node: ts.Expression): { subject: ts.Expression; not: boolean } | null {
  let not = false;
  let n = node;
  if (ts.isPropertyAccessExpression(n) && n.name.text === "not") {
    not = true;
    n = n.expression;
  }
  if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "expect") {
    if (n.arguments.length !== 1) throw new ReadError(n, "expect takes one thing to check.");
    return { subject: n.arguments[0]!, not };
  }
  return null;
}

/** page.getByRole('button', { name: 'Pay' }).first() becomes a list of calls. */
function readLocatorChain(node: ts.Expression, secrets: Set<string>): Call[] {
  const calls: Call[] = [];
  let n = node;
  while (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
    const fn = n.expression.name.text;
    if (!LOCATOR_BUILDERS.has(fn) && !LOCATOR_REFINERS.has(fn)) throw new ReadError(n, `${fn} isn't a way to find an element Claritia supports.`);
    calls.unshift({ fn, args: n.arguments.map((a) => readArg(a, secrets)) });
    n = n.expression.expression;
  }
  if (!ts.isIdentifier(n) || n.text !== "page") throw new ReadError(node, "Elements should be found from page, like page.getByRole('button', { name: 'Pay' }).");
  if (!calls.length || !LOCATOR_BUILDERS.has(calls[0]!.fn)) throw new ReadError(node, "Start with a way to find the element, like getByRole, getByText or locator.");
  for (const c of calls) {
    if (c.fn === "nth" && (c.args.length !== 1 || c.args[0]!.kind !== "number")) throw new ReadError(node, "nth takes one number.");
    if ((c.fn === "first" || c.fn === "last") && c.args.length) throw new ReadError(node, `${c.fn} takes no arguments.`);
    if (c.fn === "filter" && (c.args.length !== 1 || c.args[0]!.kind !== "object")) throw new ReadError(node, "filter takes one { hasText: ... } option.");
    if (LOCATOR_BUILDERS.has(c.fn) && (c.args.length < 1 || c.args.length > 2)) throw new ReadError(node, `${c.fn} takes what to find, and optional settings.`);
  }
  return calls;
}

function readArg(node: ts.Expression, secrets: Set<string>): Arg {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return { kind: "string", value: node.text };
  if (ts.isNumericLiteral(node)) return { kind: "number", value: Number(node.text) };
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(node.operand)) return { kind: "number", value: -Number(node.operand.text) };
  if (node.kind === ts.SyntaxKind.TrueKeyword) return { kind: "boolean", value: true };
  if (node.kind === ts.SyntaxKind.FalseKeyword) return { kind: "boolean", value: false };
  if (ts.isRegularExpressionLiteral(node)) {
    const m = /^\/([\s\S]*)\/([a-z]*)$/.exec(node.text);
    if (!m || /[^imsu]/.test(m[2]!)) throw new ReadError(node, "Patterns can use the i, m, s and u flags.");
    try {
      new RegExp(m[1]!, m[2]);
    } catch {
      throw new ReadError(node, "This pattern isn't valid.");
    }
    return { kind: "regex", source: m[1]!, flags: m[2]! };
  }
  if (ts.isPropertyAccessExpression(node) && ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === "process" && node.expression.name.text === "env") {
    const name = node.name.text;
    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(name)) throw new ReadError(node, "Secret names use capital letters, numbers and _.");
    secrets.add(name);
    return { kind: "secret", name };
  }
  if (ts.isObjectLiteralExpression(node)) {
    const entries: Record<string, Arg> = {};
    for (const p of node.properties) {
      if (!ts.isPropertyAssignment(p) || !(ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) throw new ReadError(p, "Settings should look like { name: 'Pay' }.");
      const key = p.name.text;
      if (!OPTION_KEYS.has(key)) throw new ReadError(p, `${key} isn't a setting Claritia supports.`);
      entries[key] = readArg(p.initializer, secrets);
    }
    return { kind: "object", entries };
  }
  if (ts.isArrayLiteralExpression(node)) return { kind: "array", items: node.elements.map((e) => readArg(e, secrets)) };
  throw new ReadError(node, "Use plain text in quotes, a number, a /pattern/ or process.env.NAME here.");
}

/** The first problem as one line, for buttons and API errors. */
export function firstError(p: ParsedLock) {
  return p.ok ? "" : `Line ${p.errors[0]!.line}: ${p.errors[0]!.message}`;
}

/** The code lines under each step comment, as written, keyed by step number. */
export function lockSections(code: string): Map<number, string[]> {
  const out = new Map<number, string[]>();
  let current: number | null = null;
  const lines = code.split("\n");
  let end = lines.length;
  while (end > 0 && !/^\s*\}\s*\)\s*;?\s*$/.test(lines[end - 1]!)) end--;
  end = end > 0 ? end - 1 : -1;
  for (const [i, raw] of lines.entries()) {
    if (end >= 0 && i >= end) break;
    const hit = STEP_COMMENT.exec(raw.trim());
    if (hit) {
      current = Number(hit[1]);
      out.set(current, []);
      continue;
    }
    if (current !== null && raw.trim()) out.get(current)!.push(raw.trim());
  }
  return out;
}

/** Write a lock from its steps: a step comment for each, then its code lines. */
export function buildLock(name: string, steps: { label: string; lines: string[] }[]) {
  const body = steps.flatMap((s, i) => [`  // step ${i + 1}: ${s.label.replace(/\n/g, " ").replace(/\*\//g, "* /")}`, ...s.lines.map((l) => `  ${l}`)]);
  return [`import { test, expect } from '@playwright/test';`, ``, `test(${JSON.stringify(name)}, async ({ page }) => {`, ...body, `});`, ``].join("\n");
}
