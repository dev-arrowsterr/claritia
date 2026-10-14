// Export and import. Export gives a project's tests as a zip a team can keep in its repo and run with plain Playwright:
// the YAML test files, one .spec.ts per test, a playwright.config.ts and a README. Import reads Claritia YAML files
// and plain Playwright specs. A spec without "// step" comments gets one step per line, named from what the line does.

import ts from "typescript";
import { zipSync, strToU8 } from "fflate";
import { buildLock, parseLock, type Action, type Arg, type Call } from "./lock.ts";
import { fromYaml, lockOutline, lockPath, slug, stepId, TestFileError, testPath, toYaml, type BlockRef, type Step, type TestDoc } from "./testfile.ts";

export type ExportTest = TestDoc & { lock: string | null };

const CONFIG = (baseUrl: string) => `import { defineConfig } from '@playwright/test';

// Exported from Claritia. BASE_URL points the tests at another address, such as a preview deploy.
export default defineConfig({
  testDir: '.claritia/lock',
  testMatch: '**/*.spec.ts',
  retries: 1,
  use: { baseURL: process.env.BASE_URL || ${JSON.stringify(baseUrl)}, trace: 'retain-on-failure', video: 'retain-on-failure' },
});
`;

const README = (project: string, secrets: string[], inbox: string[], unwritten: string[]) =>
  [
    `# ${project}: end-to-end tests`,
    "",
    "Exported from Claritia. `.claritia/tests/` has each test in plain English; `.claritia/lock/` has its Playwright code.",
    "",
    "```bash",
    "npm i -D @playwright/test && npx playwright install chromium",
    secrets.length ? `${secrets.map((s) => `${s}=...`).join(" ")} npx playwright test` : "npx playwright test",
    "```",
    "",
    secrets.length ? `Secrets come from environment variables: ${secrets.join(", ")}.` : "",
    inbox.length ? `These tests read email through Claritia's test inboxes and only run in Claritia: ${inbox.join(", ")}.` : "",
    unwritten.length ? `These tests have no code yet (Claritia writes it on the first run): ${unwritten.join(", ")}.` : "",
    "",
    "Import these files back into Claritia from Settings → Project → Import tests.",
    "",
  ]
    .filter((l, i, all) => l !== "" || all[i - 1] !== "")
    .join("\n");

/** The project's tests as files: path → content. */
export function exportFiles(project: string, baseUrl: string, tests: ExportTest[], blocks: BlockRef[]): Record<string, string> {
  const files: Record<string, string> = {};
  const secrets = new Set<string>();
  const inbox: string[] = [];
  const unwritten: string[] = [];
  const used = new Set<string>();
  for (const t of tests) {
    let name = slug(t.name);
    for (let n = 2; used.has(name); n++) name = `${slug(t.name)}-${n}`;
    used.add(name);
    files[testPath(name)] = toYaml(t, blocks);
    const parsed = t.lock ? parseLock(t.lock) : null;
    if (parsed?.ok) {
      parsed.secrets.forEach((s) => secrets.add(s));
      if (parsed.usesInbox) inbox.push(t.name);
      files[lockPath(name)] = t.lock!;
    } else {
      unwritten.push(t.name);
      files[lockPath(name)] = lockOutline(t, blocks);
    }
  }
  files["playwright.config.ts"] = CONFIG(baseUrl);
  files[".claritia/README.md"] = README(project, [...secrets].sort(), inbox, unwritten);
  return files;
}

export function zipFiles(files: Record<string, string>): Uint8Array {
  return zipSync(Object.fromEntries(Object.entries(files).map(([path, text]) => [path, strToU8(text)])), { level: 6 });
}

// --- Import -----------------------------------------------------------------------------------------------------

const quote = (s: string) => `"${s.length > 60 ? `${s.slice(0, 57)}…` : s}"`;
const argText = (a: Arg | undefined): string => {
  if (!a) return "";
  if (a.kind === "string") return a.value;
  if (a.kind === "number" || a.kind === "boolean") return String(a.value);
  if (a.kind === "regex") return a.source;
  if (a.kind === "secret") return `process.env.${a.name}`;
  if (a.kind === "inbox") return `the ${a.tag} inbox ${a.fn}`;
  if (a.kind === "array") return a.items.map(argText).join(", ");
  return "";
};

/** "the Sign in button", "the Email field", "Welcome" — the element a locator chain points at. */
export function describeTarget(chain: Call[]): string {
  const first = chain[0];
  if (!first) return "the page";
  const v = argText(first.args[0]);
  const name = first.args[1]?.kind === "object" ? argText(first.args[1].entries.name) : "";
  let target: string;
  switch (first.fn) {
    case "getByRole":
      target = name ? `the ${quote(name)} ${v === "textbox" ? "field" : v}` : `the ${v}`;
      break;
    case "getByLabel":
    case "getByPlaceholder":
      target = `the ${quote(v)} field`;
      break;
    case "getByText":
      target = quote(v);
      break;
    case "getByAltText":
      target = `the ${quote(v)} image`;
      break;
    case "getByTitle":
      target = `the ${quote(v)} element`;
      break;
    case "getByTestId":
      target = `the ${v} element`;
      break;
    default:
      target = `"${v}"`;
  }
  const nth = chain.find((c) => c.fn === "first" || c.fn === "last" || c.fn === "nth");
  if (nth) target = `${nth.fn === "first" ? "the first of " : nth.fn === "last" ? "the last of " : `item ${Number(argText(nth.args[0])) + 1} of `}${target}`;
  return target;
}

const MATCHER: Record<string, (target: string, v: string) => string> = {
  toBeVisible: (t) => `${t} shows`,
  toBeHidden: (t) => `${t} is hidden`,
  toHaveText: (t, v) => `${t} says ${quote(v)}`,
  toContainText: (t, v) => `${t} contains ${quote(v)}`,
  toHaveValue: (t, v) => `${t} has ${quote(v)}`,
  toHaveCount: (t, v) => `There are ${v} of ${t}`,
  toBeChecked: (t) => `${t} is ticked`,
  toBeEnabled: (t) => `${t} is enabled`,
  toBeDisabled: (t) => `${t} is disabled`,
  toHaveURL: (_t, v) => `The address is ${v}`,
  toHaveTitle: (_t, v) => `The page title is ${quote(v)}`,
};

/** One action as a plain-English step. */
export function describeAction(a: Action): { kind: "do" | "check"; text: string } {
  if (a.type === "expect") {
    const target = a.subject === "page" ? "The page" : describeTarget(a.subject);
    const say = MATCHER[a.matcher]?.(target, argText(a.args[0])) ?? `${target} ${a.matcher.replace(/^to/, "").replace(/([A-Z])/g, " $1").trim().toLowerCase()}`;
    const text = a.not ? `Not: ${say}` : say;
    return { kind: "check", text: text.charAt(0).toUpperCase() + text.slice(1) };
  }
  if (a.type === "page") {
    const v = argText(a.args[0]);
    const map: Record<string, string> = { goto: `Go to ${v}`, reload: "Reload the page", goBack: "Go back", goForward: "Go forward", waitForURL: `Wait for the address ${v}`, waitForLoadState: "Wait for the page to load", waitForTimeout: `Wait ${v} ms` };
    return { kind: "do", text: map[a.method] ?? `${a.method} ${v}`.trim() };
  }
  if (a.type === "keyboard") return { kind: "do", text: a.method === "press" ? `Press ${argText(a.args[0])}` : `Type ${quote(argText(a.args[0]))}` };
  if (a.type === "inbox") return { kind: "do", text: `Wait for an email in the ${a.tag} inbox` };
  const t = describeTarget(a.chain);
  const v = argText(a.args[0]);
  const map: Record<string, string> = {
    click: `Click ${t}`,
    dblclick: `Double-click ${t}`,
    fill: `Type ${quote(v)} into ${t}`,
    pressSequentially: `Type ${quote(v)} into ${t}`,
    clear: `Clear ${t}`,
    press: `Press ${v} in ${t}`,
    check: `Tick ${t}`,
    uncheck: `Untick ${t}`,
    setChecked: `${v === "false" ? "Untick" : "Tick"} ${t}`,
    selectOption: `Choose ${quote(v)} in ${t}`,
    hover: `Hover over ${t}`,
    focus: `Focus ${t}`,
    scrollIntoViewIfNeeded: `Scroll to ${t}`,
    waitFor: `Wait for ${t}`,
  };
  const text = map[a.method] ?? `${a.method} ${t}`;
  return { kind: "do", text: text.charAt(0).toUpperCase() + text.slice(1) };
}

export type Imported = { tests: (TestDoc & { lock: string | null; file: string })[]; skipped: { file: string; test?: string; reason: string }[] };

/** The tests in a Playwright spec: each test("name", async ({ page }) => { ... }) with the text of its body's lines. */
function specTests(code: string): { name: string; lines: string[]; inner: string; hasSteps: boolean }[] {
  const sf = ts.createSourceFile("spec.ts", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out: { name: string; lines: string[]; inner: string; hasSteps: boolean }[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(sf);
      const [title, fn] = node.arguments;
      if ((callee === "test" || callee === "test.only" || callee === "it") && title && fn && (ts.isStringLiteral(title) || ts.isNoSubstitutionTemplateLiteral(title)) && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && ts.isBlock(fn.body)) {
        const body = fn.body;
        const inner = code.slice(body.getStart(sf) + 1, body.getEnd() - 1);
        out.push({ name: title.text, lines: body.statements.map((s) => s.getText(sf)), inner, hasSteps: /\/\/\s*step\s+\d+\s*:/i.test(inner) });
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** Read uploaded files into tests. Steps from a spec are named from what each line does. */
export function importFiles(files: { name: string; text: string }[], blocks: BlockRef[]): Imported {
  const result: Imported = { tests: [], skipped: [] };
  for (const f of files) {
    if (/\.ya?ml$/i.test(f.name)) {
      try {
        result.tests.push({ ...fromYaml(f.text, blocks), lock: null, file: f.name });
      } catch (e) {
        result.skipped.push({ file: f.name, reason: e instanceof TestFileError ? e.message : String(e) });
      }
      continue;
    }
    if (!/\.(spec|test)?\.?[cm]?[jt]s$/i.test(f.name)) {
      result.skipped.push({ file: f.name, reason: "Not a .yaml test file or a Playwright spec." });
      continue;
    }
    // TypeScript specs often write process.env.NAME! ; Claritia reads secrets without the "!".
    const found = specTests(f.text.replace(/(process\.env\.[A-Za-z_][A-Za-z0-9_]*)!/g, "$1"));
    if (!found.length) result.skipped.push({ file: f.name, reason: "No test(...) found in this file." });
    for (const t of found) {
      // A spec exported from Claritia keeps its steps; any other gets one step per line.
      const draft = t.hasSteps
        ? `import { test, expect } from '@playwright/test';\n\ntest(${JSON.stringify(t.name)}, async ({ page }) => {${t.inner}});\n`
        : buildLock(t.name, t.lines.map((l, i) => ({ label: `line ${i + 1}`, lines: l.split("\n") })));
      const parsed = parseLock(draft);
      if (!parsed.ok) {
        result.skipped.push({ file: f.name, test: t.name, reason: `Line ${parsed.errors[0]!.line}: ${parsed.errors[0]!.message}` });
        continue;
      }
      const steps: Step[] = [];
      const labelled: { label: string; lines: string[] }[] = [];
      const sections = t.hasSteps ? null : t.lines;
      parsed.steps.forEach((s, i) => {
        let kind: "do" | "check";
        let text: string;
        if (t.hasSteps) {
          const use = s.label.match(/^use:\s*(.+)$/i);
          const block = use ? blocks.find((b) => b.name.toLowerCase() === use[1]!.trim().toLowerCase()) : undefined;
          if (block) {
            steps.push({ id: stepId(), kind: "use", block: block.id });
            return;
          }
          const check = /^check:\s*/i.test(s.label);
          kind = check ? "check" : "do";
          text = s.label.replace(/^check:\s*/i, "");
        } else {
          const d = describeAction(s.actions[0]!);
          kind = d.kind;
          text = d.text;
          labelled.push({ label: kind === "check" ? `check: ${text}` : text, lines: sections![i]!.split("\n") });
        }
        steps.push({ id: stepId(), kind, text: text.slice(0, 500) });
      });
      const lock = t.hasSteps ? draft : buildLock(t.name, labelled);
      if (!parseLock(lock).ok) {
        result.skipped.push({ file: f.name, test: t.name, reason: "The code couldn't be read back after naming its steps." });
        continue;
      }
      result.tests.push({ name: t.name.slice(0, 120), use_case: "Imported", priority: "medium", steps, lock, file: f.name });
    }
  }
  // An exported pair (the YAML and its spec) becomes one test: the YAML's steps, use case and priority, with the
  // spec's code when it has a step for each of them.
  const yaml = result.tests.filter((t) => /\.ya?ml$/i.test(t.file));
  for (const y of yaml) {
    const i = result.tests.findIndex((t) => t !== y && !/\.ya?ml$/i.test(t.file) && t.name === y.name);
    if (i < 0) continue;
    const spec = result.tests[i]!;
    const p = parseLock(spec.lock ?? "");
    if (p.ok && p.steps.length === y.steps.length) y.lock = spec.lock;
    result.tests.splice(i, 1);
  }
  return result;
}
