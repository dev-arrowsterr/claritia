// The AI writer. Given one plain-English step and what the page looks like now, Claude writes the
// Playwright lines for it. The runner checks every line against the allowed list (src/lib/lock.ts)
// before running it, so the model can only do what a person could write in the Code tab.

import Anthropic from "@anthropic-ai/sdk";

export type WriteRequest = {
  testName: string;
  steps: { position: number; kind: string; intent: string }[];
  position: number;
  url: string;
  title: string;
  /** The page's accessibility tree, as text. */
  snapshot: string;
  /** Form fields and buttons, including ones hidden behind custom styling. */
  fields: string;
  /** A JPEG of the page, base64. */
  screenshot: string | null;
  secretNames: string[];
  /** Lines already run for this step, in this run. */
  done: string[];
  /** What went wrong with the last lines, if anything. */
  error: string | null;
};
export type WriteReply = { lines: string[]; done: boolean; problem: string; usage: { input: number; output: number } };
export type Writer = (req: WriteRequest) => Promise<WriteReply>;

const SYSTEM = `You write Playwright test code for Claritia, one plain-English step at a time.

You get the whole test for context, the step to write now, and the page as it is right now: its address, its accessibility tree, its form fields, and a screenshot. Reply with the lines of code that do the step.

Every line is one statement in one of these forms, and nothing else:
  await page.goto('https://example.com/path');
  await page.reload(); await page.goBack(); await page.goForward();
  await page.waitForURL(/pattern/);
  await page.waitForLoadState('load');
  await page.waitForTimeout(1000);   (up to 10000, only when nothing else works)
  await page.keyboard.press('Enter');  (also keyboard.type and keyboard.insertText)
  await <locator>.<action>;
  await expect(page).toHaveURL(/pattern/);  (also toHaveTitle)
  await expect(<locator>).<matcher>;  (expect(...).not.<matcher> works too)

A locator starts from page with getByRole, getByLabel, getByText, getByPlaceholder, getByAltText, getByTitle, getByTestId or locator('css'), and can continue with first(), last(), nth(n) or filter({ hasText: '...' }).
Locator options: name, exact, hasText, hasNotText, level, checked, selected, pressed, expanded, disabled, includeHidden.
Actions: click(), dblclick(), fill('text'), clear(), press('Key'), pressSequentially('text'), check(), uncheck(), setChecked(true), selectOption('value'), hover(), focus(), scrollIntoViewIfNeeded(), waitFor().
Matchers: toBeVisible(), toBeHidden(), toBeEnabled(), toBeDisabled(), toBeChecked(), toBeEmpty(), toBeFocused(), toHaveText('...'), toContainText('...'), toHaveValue('...'), toHaveCount(n), toHaveAttribute('name', 'value').
Arguments are plain strings in single quotes, numbers, true or false, /regex/ with flags i, m, s or u, objects with the options above, or process.env.NAME for a secret. No variables, no template strings with \${}, no other JavaScript.

How to write good lines:
- Prefer getByRole with a name, then getByLabel, getByPlaceholder and getByText. Use locator('css') only when nothing else is unique, for example label[for="id"] when a radio or checkbox input is hidden behind a styled label.
- Make each locator match exactly one element. Add { exact: true }, first() or a filter when the text appears more than once.
- To fill a form, invent realistic test data that fits each field. Use the listed secrets for passwords, logins and keys, as process.env.NAME. Never type a secret's value.
- A "check" step only checks: use expect lines (and waitForURL if the page has to arrive first). Never click or type in a check step.
- A "wait until" step waits with waitForURL or an expect that waits, for example await expect(page.getByText('Thanks')).toBeVisible();
- Match patterns loosely enough to survive small changes, for example /calendly\\.com/ rather than a full address with a query string.
- Write only the current step. Don't repeat lines listed as already done.

Set done to true when your lines finish the step. Set it to false when the page must change before you can write the rest, for example after a click that opens another page; you will be asked again with the new page.
If the step can't be done on this page, or a check step is plainly false on this page, return no lines and say why in problem, in one short plain sentence. Otherwise leave problem empty.`;

const SCHEMA = {
  type: "object",
  properties: {
    lines: { type: "array", items: { type: "string" } },
    done: { type: "boolean" },
    problem: { type: "string" },
  },
  required: ["lines", "done", "problem"],
  additionalProperties: false,
};

function prompt(r: WriteRequest) {
  const current = r.steps.find((s) => s.position === r.position)!;
  const kind = current.kind === "use" ? "do (a saved block of steps)" : current.kind;
  const outline = r.steps.map((s) => `${s.position === r.position ? "→" : " "} ${s.position}. [${s.kind}] ${s.intent.replace(/\n/g, " / ")}`).join("\n");
  return [
    `Test: ${r.testName}`,
    `All steps:\n${outline}`,
    `Write step ${r.position} now. Kind: ${kind}.\n${current.intent}`,
    `Secrets you can use: ${r.secretNames.length ? r.secretNames.map((n) => `process.env.${n}`).join(", ") : "none"}`,
    r.done.length ? `Already done for this step:\n${r.done.join("\n")}` : "",
    r.error ? `Your last lines failed with:\n${r.error}\nWrite lines that will work on the page as it is now.` : "",
    `Page address: ${r.url}\nPage title: ${r.title}`,
    `Form fields and buttons:\n${r.fields || "none"}`,
    `Accessibility tree:\n${r.snapshot || "empty"}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** A writer backed by Claude. Needs ANTHROPIC_API_KEY. */
export function claudeWriter(opts: { apiKey: string; model?: string; effort?: "low" | "medium" | "high" }): Writer {
  const client = new Anthropic({ apiKey: opts.apiKey, maxRetries: 3, timeout: 120_000 });
  const model = opts.model || "claude-opus-5-5";
  return async (r) => {
    const content: Anthropic.Beta.BetaContentBlockParam[] = [];
    if (r.screenshot) content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: r.screenshot } });
    content.push({ type: "text", text: prompt(r) });
    let res: Anthropic.Beta.BetaMessage;
    try {
      res = await client.beta.messages.create({
        model,
        max_tokens: 16000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        thinking: { type: "adaptive" },
        output_config: { effort: opts.effort ?? "medium", format: { type: "json_schema", schema: SCHEMA } },
        system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content }],
      });
    } catch (e) {
      if (e instanceof Anthropic.AuthenticationError) throw new Error("The runner's ANTHROPIC_API_KEY was refused.");
      if (e instanceof Anthropic.APIError) throw new Error(`Claude couldn't write this step (${e.status ?? "no answer"}).`);
      throw e;
    }
    const u = res.usage;
    const usage = { input: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), output: u.output_tokens ?? 0 };
    if (res.stop_reason === "refusal") return { lines: [], done: false, problem: "Claude declined to write this step.", usage };
    if (res.stop_reason === "max_tokens") return { lines: [], done: false, problem: "Claude's answer was cut off.", usage };
    const text = res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    let out: { lines?: unknown; done?: unknown; problem?: unknown };
    try {
      out = JSON.parse(text);
    } catch {
      return { lines: [], done: false, problem: "Claude's answer couldn't be read.", usage };
    }
    const lines = Array.isArray(out.lines) ? out.lines.filter((l): l is string => typeof l === "string" && !!l.trim()).map((l) => l.trim()).slice(0, 20) : [];
    return { lines, done: out.done === true, problem: typeof out.problem === "string" ? out.problem.trim().slice(0, 300) : "", usage };
  };
}
