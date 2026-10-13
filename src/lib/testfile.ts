// The test file: what a test looks like as YAML in a repo, and how it reads back.
// People and agents edit this file. Claritia writes the Playwright lock from it.
//
//   name: Checkout with a coupon
//   use_case: Checkout
//   priority: high
//   steps:
//     - use: sign-in
//     - Add the blue hoodie to the cart
//     - check: The total drops 10%

import { parse, stringify } from "yaml";

export type StepKind = "do" | "check" | "use";
export type TextStep = { id: string; kind: "do" | "check"; text: string };
export type UseStep = { id: string; kind: "use"; block: string };
export type Step = TextStep | UseStep;
export const isUse = (s: Step): s is UseStep => s.kind === "use";
export type Priority = "low" | "medium" | "high";
export type TestDoc = { name: string; use_case: string; priority: Priority; steps: Step[] };
export type BlockRef = { id: string; name: string };

export const PRIORITIES: Priority[] = ["low", "medium", "high"];
export const MAX_STEPS = 200;
export const MAX_STEP_TEXT = 500;
export const MAX_NAME = 120;
export const MAX_USE_CASE = 60;

/** "Sign in with Google" becomes "sign-in-with-google". Used for file names and block references. */
export function slug(name: string) {
  return (
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "untitled"
  );
}

/** A short id for a new step. Ids stay with a step when it moves, so its lock code can follow it. */
export function stepId() {
  return Math.random().toString(36).slice(2, 10);
}

export function testPath(name: string) {
  return `.claritia/tests/${slug(name)}.yaml`;
}

export function lockPath(name: string) {
  return `.claritia/lock/${slug(name)}.spec.ts`;
}

/** The test as YAML. Blocks are named by their slug. */
export function toYaml(doc: TestDoc, blocks: BlockRef[]): string {
  const byId = new Map(blocks.map((b) => [b.id, b]));
  const steps = doc.steps.map((s) => {
    if (!isUse(s)) return s.kind === "check" ? { check: s.text } : s.text;
    const b = byId.get(s.block);
    return { use: b ? slug(b.name) : `missing-block-${s.block.slice(0, 8)}` };
  });
  return stringify({ name: doc.name, use_case: doc.use_case, priority: doc.priority, steps }, { lineWidth: 0 });
}

export class TestFileError extends Error {}

/**
 * Read YAML back into a test. Throws TestFileError with a plain message when something is wrong.
 * Step ids are kept for steps whose kind and text didn't change, so edits in YAML don't lose their lock code.
 */
export function fromYaml(text: string, blocks: BlockRef[], previous: Step[] = []): TestDoc {
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (e) {
    throw new TestFileError(`The YAML can't be read: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new TestFileError("The file needs name and steps at the top level.");
  const o = raw as Record<string, unknown>;

  const name = typeof o.name === "string" ? o.name.trim() : "";
  if (!name) throw new TestFileError("Add a name, like name: Checkout with a coupon.");
  if (name.length > MAX_NAME) throw new TestFileError(`The name is longer than ${MAX_NAME} characters.`);

  const useCase = o.use_case == null ? "General" : typeof o.use_case === "string" ? o.use_case.trim() || "General" : null;
  if (useCase === null) throw new TestFileError("use_case should be a short phrase, like Checkout.");
  if (useCase.length > MAX_USE_CASE) throw new TestFileError(`use_case is longer than ${MAX_USE_CASE} characters.`);

  const priority = o.priority == null ? "medium" : String(o.priority).toLowerCase();
  if (!PRIORITIES.includes(priority as Priority)) throw new TestFileError("priority should be low, medium or high.");

  if (o.steps != null && !Array.isArray(o.steps)) throw new TestFileError("steps should be a list, with each step on a line starting with a dash.");
  const list = (o.steps as unknown[] | undefined) ?? [];
  if (list.length > MAX_STEPS) throw new TestFileError(`A test can have up to ${MAX_STEPS} steps.`);

  const bySlug = new Map(blocks.map((b) => [slug(b.name), b]));
  const unused = [...previous];
  const reuse = (match: (s: Step) => boolean) => {
    const i = unused.findIndex(match);
    return i >= 0 ? unused.splice(i, 1)[0]!.id : stepId();
  };

  const steps = list.map((item, i): Step => {
    const n = i + 1;
    let kind: "do" | "check";
    let value: unknown;
    if (typeof item === "string") {
      kind = "do";
      value = item;
    } else if (item && typeof item === "object" && !Array.isArray(item) && Object.keys(item).length === 1) {
      const [key, v] = Object.entries(item)[0]!;
      if (key === "use") {
        const b = bySlug.get(slug(String(v ?? "")));
        if (!b) throw new TestFileError(`Step ${n}: there's no block called "${v}".`);
        return { id: reuse((s) => isUse(s) && s.block === b.id), kind: "use", block: b.id };
      }
      if (key !== "check" && key !== "do") throw new TestFileError(`Step ${n}: use plain text, check: or use:.`);
      kind = key;
      value = v;
    } else {
      throw new TestFileError(`Step ${n}: use plain text, check: or use:.`);
    }
    const t = typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
    if (!t) throw new TestFileError(`Step ${n} is empty.`);
    if (t.length > MAX_STEP_TEXT) throw new TestFileError(`Step ${n} is longer than ${MAX_STEP_TEXT} characters.`);
    return { id: reuse((s) => !isUse(s) && s.kind === kind && s.text === t), kind, text: t };
  });

  return { name, use_case: useCase, priority: priority as Priority, steps };
}

/** Drop empty steps and trim the rest, before saving. */
export function cleanSteps(steps: Step[]): Step[] {
  return steps.flatMap((s): Step[] => (isUse(s) ? [s] : s.text.trim() ? [{ ...s, text: s.text.trim().slice(0, MAX_STEP_TEXT) }] : []));
}

/** What the lock looks like before Claritia has written any code for it. */
export function lockOutline(doc: TestDoc, blocks: BlockRef[]): string {
  const byId = new Map(blocks.map((b) => [b.id, b]));
  const lines = doc.steps.map((s, i) => {
    const label = isUse(s) ? `use: ${byId.get(s.block)?.name ?? "missing block"}` : s.kind === "check" ? `check: ${s.text}` : s.text;
    return `  // step ${i + 1}: ${label.replace(/\*\//g, "* /")}`;
  });
  return [`import { test, expect } from '@playwright/test';`, ``, `test(${JSON.stringify(doc.name)}, async ({ page }) => {`, ...(lines.length ? lines : ["  // no steps yet"]), `});`, ``].join("\n");
}
