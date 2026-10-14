// The Judge. When a run fails, it sorts the failure into an app bug, a flaky test or a setup problem, with a
// one-line reason. Clear cases are sorted by fixed rules with no AI call. The rest go to Claude with the evidence:
// the failed step, its code and error, a screenshot, console errors and failed requests.

import Anthropic from "@anthropic-ai/sdk";

export type Verdict = "app_bug" | "flaky" | "setup";
export type JudgeRequest = {
  testName: string;
  baseUrl: string;
  steps: { position: number; kind: string; intent: string; status: string }[];
  failed: { position: number; kind: string; intent: string; code: string; error: string; retried: boolean; healTried: boolean };
  /** A JPEG of the page when the step failed, base64. */
  screenshot: string | null;
  consoleErrors: string[];
  failedRequests: string[];
};
export type JudgeReply = { verdict: Verdict; reason: string; usage: { input: number; output: number } };
export type Judge = (req: JudgeRequest) => Promise<JudgeReply>;

/** Failures that are plainly setup problems, sorted with no AI call. Null when a rule doesn't settle it. */
export function judgeByRules(error: string): { verdict: Verdict; reason: string } | null {
  const rules: [RegExp, string][] = [
    [/Claritia blocked .* private network address/i, "The site points to a private network address, which Claritia can't reach."],
    [/ERR_NAME_NOT_RESOLVED|ENOTFOUND|getaddrinfo/i, "The site's address doesn't resolve. Check the environment's address."],
    [/ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET|ERR_CONNECTION_CLOSED|ERR_ADDRESS_UNREACHABLE/i, "The site didn't accept the connection. It may be down or blocking Claritia."],
    [/ERR_CERT_|SSL_ERROR|certificate/i, "The site's HTTPS certificate isn't valid."],
    [/Add [A-Z0-9_, ]+ to this environment/i, "A secret the test uses is missing from the environment."],
    [/AI credits are used up|cloud minutes are used up/i, "The plan's limit was reached."],
    [/ANTHROPIC_API_KEY|Claude couldn't write this step|Claude declined/i, "Claritia couldn't reach Claude to write the step."],
    [/test inboxes aren't set up/i, "Test inboxes aren't set up for this runner."],
    [/tunneled to localhost|The tunnel shares localhost|Tunnels aren't set up|connect to the tunnel/i, "The run is on localhost and no matching tunnel is open. Run npx claritia tunnel <port>."],
    [/The test's code has a problem on line/i, "The test's code can't be read."],
  ];
  for (const [re, reason] of rules) if (re.test(error)) return { verdict: "setup", reason };
  return null;
}

const SYSTEM = `You sort failed end-to-end test runs for Claritia. A test drives a real browser through plain-English steps. One step failed. Decide which kind of failure it is, so the team knows whether to fix the app, the test, or the setup.

- app_bug: the app did something wrong. Examples: an error page or error message, a server error (5xx) from the app's own API, a check that is plainly false on the page (wrong text, wrong count, missing result), a page that never loads its content, a JavaScript error that breaks the page.
- flaky: the app looks fine and the test or timing is the problem. Examples: the page was still loading or animating, a toast or popup covered the element, a request was slow, a locator matched several elements, text changed slightly but the feature works, the step passed on retry before.
- setup: the test can't run as set up. Examples: wrong login or password, an expired test account, a captcha or bot check, rate limiting, a site that is down or unreachable, a missing environment value, a page behind a login the test never did.

Look at the screenshot first: it shows the page when the step failed. Use the error, the console errors and the failed requests as evidence. When the evidence points to the app, say app_bug even if timing could also explain it. When nothing on the page looks wrong and the error is about waiting or finding an element, say flaky.

Reply with the verdict and one short plain sentence a developer can act on, naming what you saw. No more than 25 words.`;

const SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["app_bug", "flaky", "setup"] },
    reason: { type: "string" },
  },
  required: ["verdict", "reason"],
  additionalProperties: false,
};

function prompt(r: JudgeRequest) {
  const outline = r.steps.map((s) => `${s.position === r.failed.position ? "→" : " "} ${s.position}. [${s.kind}] ${s.intent.replace(/\n/g, " / ")} (${s.status})`).join("\n");
  return [
    `Test: ${r.testName}`,
    `Site: ${r.baseUrl}`,
    `Steps:\n${outline}`,
    `Failed step ${r.failed.position} (${r.failed.kind}): ${r.failed.intent}`,
    `Its code:\n${r.failed.code || "(written during this run)"}`,
    `Error:\n${r.failed.error}`,
    `It was ${r.failed.retried ? "" : "not "}retried.${r.failed.healTried ? " Claritia also tried a fix for the code, and it didn't work." : ""}`,
    `Console errors:\n${r.consoleErrors.length ? r.consoleErrors.join("\n") : "none"}`,
    `Failed requests:\n${r.failedRequests.length ? r.failedRequests.join("\n") : "none"}`,
  ].join("\n\n");
}

/** A judge backed by Claude. Needs ANTHROPIC_API_KEY. */
export function claudeJudge(opts: { apiKey: string; model?: string; effort?: "low" | "medium" | "high" }): Judge {
  const client = new Anthropic({ apiKey: opts.apiKey, maxRetries: 3, timeout: 120_000 });
  const model = opts.model || "claude-opus-5-5";
  return async (r) => {
    const content: Anthropic.Beta.BetaContentBlockParam[] = [];
    if (r.screenshot) content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: r.screenshot } });
    content.push({ type: "text", text: prompt(r) });
    const res = await client.beta.messages.create({
      model,
      max_tokens: 8000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      thinking: { type: "adaptive" },
      output_config: { effort: opts.effort ?? "medium", format: { type: "json_schema", schema: SCHEMA } },
      system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content }],
    });
    const u = res.usage;
    const usage = { input: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), output: u.output_tokens ?? 0 };
    if (res.stop_reason === "refusal" || res.stop_reason === "max_tokens") throw new Error("The Judge gave no answer.");
    const out = JSON.parse(res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("")) as { verdict?: unknown; reason?: unknown };
    if (out.verdict !== "app_bug" && out.verdict !== "flaky" && out.verdict !== "setup") throw new Error("The Judge's answer couldn't be read.");
    return { verdict: out.verdict, reason: typeof out.reason === "string" ? out.reason.trim().slice(0, 300) : "", usage };
  };
}
