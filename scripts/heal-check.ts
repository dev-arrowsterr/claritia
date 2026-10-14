// Drives the Healer: saved code that breaks when the page changes, with a scripted stand-in for Claude.
//   CHROMIUM_PATH=/path/to/chrome node scripts/heal-check.ts
// Covers: a renamed button healed and passed with the test's code unchanged, a fix that keeps the lines that already
// ran, a step whose button is gone failing with the reason, a slow page passing on retry with no AI call, healing
// turned off, and a fix that's the same as the old code.

import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildLock } from "../src/lib/lock.ts";
import { executeRun, type RunStep, type StepUpdate } from "../worker/runner.ts";
import type { WriteReply, WriteRequest, Writer } from "../worker/writer.ts";

// The site changes between versions, like a real app after a release.
let version: "v1" | "v2" | "gone" = "v1";
let slowVisits = 0;
const server = createServer((req, res) => {
  const path = new URL(req.url!, "http://x").pathname;
  res.writeHead(200, { "content-type": "text/html" });
  if (path === "/contact") {
    const button = version === "v1" ? "<button>Book a call</button>" : version === "v2" ? "<button>Book a demo</button>" : "";
    return res.end(`<title>Contact</title><form onsubmit="event.preventDefault(); document.body.insertAdjacentHTML('beforeend', '<h1>Thanks</h1>')"><label>Name <input id="n"></label><label>Email <input id="e"></label>${button}</form>`);
  }
  // The first visit has no button yet, like a slow page. The runner's retry reloads nothing, so the button shows up by script.
  if (path === "/slow") return res.end(++slowVisits === 1 ? `<title>Slow</title><script>setTimeout(() => document.body.insertAdjacentHTML('beforeend', '<button>Ready</button>'), 4000)</script>` : `<title>Slow</title><button>Ready</button>`);
  res.end("");
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

let failures = 0;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${what}`);
  if (!ok) failures++;
};

const STEPS: RunStep[] = [
  { position: 1, kind: "do", label: "Open the contact page", intent: "Open the contact page" },
  { position: 2, kind: "do", label: "Fill in and send the form", intent: "Fill in and send the form" },
  { position: 3, kind: "check", label: "check: It says thanks", intent: "It says thanks" },
];
const LOCK = buildLock("Contact", [
  { label: STEPS[0]!.label, lines: ["await page.goto('/contact');"] },
  { label: STEPS[1]!.label, lines: ["await page.getByLabel('Name').fill('Sam');", "await page.getByLabel('Email').fill('sam@example.com');", "await page.getByRole('button', { name: 'Book a call' }).click();"] },
  { label: STEPS[2]!.label, lines: ["await expect(page.getByRole('heading', { name: 'Thanks' })).toBeVisible();"] },
]);

function scripted(replies: Partial<WriteReply>[]) {
  const seen: WriteRequest[] = [];
  const writer: Writer = async (r) => {
    seen.push(r);
    return { lines: [], done: true, problem: "", usage: { input: 1000, output: 100 }, ...(replies[seen.length - 1] ?? { problem: "Script ran out." }) };
  };
  return { writer, seen };
}

const run = async (lock: string, writer: Writer | undefined, opts: { steps?: RunStep[]; heal?: boolean } = {}) => {
  const updates: StepUpdate[] = [];
  const steps = opts.steps ?? STEPS;
  const res = await executeRun(
    {
      baseUrl: base,
      lock,
      positions: steps.map((s) => s.position),
      secrets: {},
      dir: mkdtempSync(join(tmpdir(), "claritia-heal-")),
      chromiumPath: process.env.CHROMIUM_PATH,
      allowPrivate: true,
      expectTimeoutMs: 2000,
      actionTimeoutMs: 2000,
      writer,
      steps,
      testName: "Contact",
      heal: opts.heal,
    },
    { step: async (u) => void updates.push(u) },
  );
  const final = (p: number) => updates.filter((u) => u.position === p && u.status !== "running").at(-1);
  return { res, final };
};

// 0. The saved code passes on the page it was written for, with no AI calls.
{
  version = "v1";
  const { writer, seen } = scripted([]);
  const { res } = await run(LOCK, writer);
  check(res.status === "passed" && seen.length === 0 && res.heals.length === 0, "unchanged page: passes with no AI calls and no fixes");
}

// 1. The button is renamed. The fix keeps the two lines that already ran and clicks the new button.
{
  version = "v2";
  const { writer, seen } = scripted([{ lines: ["await page.getByRole('button', { name: 'Book a demo' }).click();"] }]);
  const { res, final } = await run(LOCK, writer);
  check(res.status === "passed", `a renamed button is healed and the run passes (${res.status} ${res.error ?? ""})`);
  check(final(2)?.status === "passed" && final(2)?.healed === true, "the step is marked as healed");
  check(seen.length === 1 && !!seen[0]!.heal && /Book a call/.test(seen[0]!.heal.oldCode.join("\n")) && /Book a call/.test(seen[0]!.heal.error), "the writer gets the old code and why it broke");
  check(seen[0]!.done.length === 2 && /Email/.test(seen[0]!.done[1]!), "the lines that already ran are kept, not repeated");
  const h = res.heals[0];
  check(res.heals.length === 1 && h!.position === 2 && h!.newLines.length === 3 && /Book a demo/.test(h!.newLines[2]!) && /Book a call/.test(h!.oldLines[2]!), "the fix holds the full new code for the step");
  check(res.lock === null, "the test's code is unchanged until someone approves the fix");
  check(final(3)?.status === "passed", "the steps after it still run");
}

// 2. The button is gone. The writer says so, and the step fails with both the error and the reason.
{
  version = "gone";
  const { writer } = scripted([{ lines: [], done: false, problem: "There is no button to send the form anymore." }]);
  const { res, final } = await run(LOCK, writer);
  check(res.status === "failed" && final(2)?.status === "failed" && /Book a call/.test(final(2)?.error ?? "") && /no button to send the form/.test(final(2)?.error ?? ""), `a missing button fails with the reason (${final(2)?.error})`);
  check(res.heals.length === 0 && final(3)?.status === "skipped", "no fix is saved and later steps are skipped");
}

// 3. A slow page passes on the retry. No fix and no AI call.
{
  const { writer, seen } = scripted([]);
  const slow: RunStep[] = [{ position: 1, kind: "do", label: "Wait for Ready", intent: "Wait for Ready" }];
  const lock = buildLock("Slow", [{ label: "Wait for Ready", lines: ["await page.goto('/slow');", "await page.getByRole('button', { name: 'Ready' }).click();"] }]);
  const { res, final } = await run(lock, writer, { steps: slow });
  check(res.status === "passed" && final(1)?.retried === true && seen.length === 0 && res.heals.length === 0, `a slow page passes on retry with no AI call (${res.status} ${final(1)?.error ?? ""})`);
}

// 4. Healing turned off: a broken step just fails.
{
  version = "v2";
  const { writer, seen } = scripted([{ lines: ["await page.getByRole('button', { name: 'Book a demo' }).click();"] }]);
  const { res } = await run(LOCK, writer, { heal: false });
  check(res.status === "failed" && seen.length === 0, "with healing off, the step fails and Claude isn't asked");
}

// 5. A "fix" that's the old code again doesn't count.
{
  version = "v2";
  const { writer } = scripted([{ lines: ["await page.getByRole('button', { name: 'Book a call' }).click();"] }, { lines: [], problem: "The button is now called Book a demo." }]);
  const { res, final } = await run(LOCK, writer);
  check(res.status === "failed" && res.heals.length === 0 && /Claritia tried a fix/.test(final(2)?.error ?? ""), `the same old code isn't saved as a fix (${final(2)?.error})`);
}

server.close();
console.log(failures ? `${failures} failed` : "All heal checks passed");
process.exit(failures ? 1 : 0);
