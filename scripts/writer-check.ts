// Drives the AI writer path of the runner with a scripted stand-in for Claude, a real browser and a local site
// that acts like a real contact form (hidden radio inputs behind labels, a slow thank-you page).
//   CHROMIUM_PATH=/path/to/chrome node scripts/writer-check.ts
// Covers: writing every step of a test with no code, saving it, replaying with no AI calls, bad lines and failing
// lines sent back to the writer, steps that need two rounds, check steps that try to click, a step the writer
// can't do, rewriting a step whose words changed, live frames, and that secret values never reach the writer.

import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseLock } from "../src/lib/lock.ts";
import { executeRun, type RunStep, type StepUpdate } from "../worker/runner.ts";
import type { WriteReply, WriteRequest, Writer } from "../worker/writer.ts";

const PASSWORD = "s3cret-pass-998877";
const pages: Record<string, string> = {
  "/contact": `<title>Contact</title><style>.sr{position:absolute;opacity:0;width:1px;height:1px}</style>
    <form onsubmit="event.preventDefault(); setTimeout(() => location.href = '/thanks?name=' + encodeURIComponent(document.querySelector('#name').value), 300)">
      <label for="name">Full name</label><input id="name" required>
      <label for="email">Work email</label><input id="email" type="email" required>
      <label for="code">Access code</label><input id="code">
      <input class="sr" type="radio" name="spend" id="spend1"><label for="spend1">Under $5k</label>
      <input class="sr" type="radio" name="spend" id="spend2"><label for="spend2">$5k to $20k</label>
      <button>Book a call</button>
    </form>`,
  // The thank-you text shows up late, like a slow page.
  "/thanks": `<title>Thanks</title><div id="t"></div><script>setTimeout(() => document.querySelector('#t').textContent = 'Thanks, ' + new URLSearchParams(location.search).get('name'), 800)</script>`,
};
const server = createServer((req, res) => {
  const path = new URL(req.url!, "http://x").pathname;
  res.writeHead(pages[path] ? 200 : 404, { "content-type": "text/html" });
  res.end(pages[path] ?? "not found");
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const chromiumPath = process.env.CHROMIUM_PATH;

let failures = 0;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${what}`);
  if (!ok) failures++;
};

const STEPS: RunStep[] = [
  { position: 1, kind: "do", label: "Go to the contact page", intent: "Go to the contact page" },
  { position: 2, kind: "do", label: "Fill in the contact form", intent: "Fill in the contact form" },
  { position: 3, kind: "do", label: "Submit the form", intent: "Submit the form" },
  { position: 4, kind: "do", label: "Wait until it says thanks", intent: "Wait until it says thanks" },
  { position: 5, kind: "check", label: "check: The page thanks the person by name", intent: "The page thanks the person by name" },
];

/** A stand-in for Claude: each call gets the next reply in the script for that step. Records every request. */
function scripted(script: Record<number, Partial<WriteReply>[]>) {
  const seen: WriteRequest[] = [];
  const writer: Writer = async (r) => {
    seen.push(r);
    const turn = seen.filter((x) => x.position === r.position).length - 1;
    const reply = script[r.position]?.[turn] ?? { lines: [], done: false, problem: "Script ran out." };
    return { lines: [], done: true, problem: "", usage: { input: 1000, output: 100 }, ...reply };
  };
  return { writer, seen };
}

const run = async (lock: string, writer: Writer | undefined, steps = STEPS, frames?: Buffer[]) => {
  const updates: StepUpdate[] = [];
  const res = await executeRun(
    {
      baseUrl: base,
      lock,
      positions: steps.map((s) => s.position),
      secrets: { ACCESS_CODE: PASSWORD },
      dir: mkdtempSync(join(tmpdir(), "claritia-write-")),
      chromiumPath,
      allowPrivate: true,
      expectTimeoutMs: 3000,
      actionTimeoutMs: 3000,
      writer,
      testName: "Contact form",
      steps,
      frameMs: 300,
    },
    { step: async (u) => void updates.push(u), frame: frames ? async (j) => void frames.push(j) : undefined },
  );
  const final = (p: number) => updates.filter((u) => u.position === p && u.status !== "running").at(-1);
  return { res, updates, final };
};

// 1. A test with no code: every step is written, with a bad line, a failing line, two rounds and a refused click along the way.
let savedLock = "";
{
  const { writer, seen } = scripted({
    1: [{ lines: ["await page.goto('/contact');"] }],
    2: [
      // Not an allowed action: sent back.
      { lines: ["await page.evaluate(() => 1);"] },
      // Wrong label: fails on the page, sent back with what already ran.
      {
        lines: [
          "await page.getByLabel('Full name').fill('Sam Test');",
          "await page.getByLabel('Email address').fill('sam@example.com');",
        ],
      },
      {
        lines: [
          "await page.getByLabel('Work email').fill('sam@example.com');",
          "await page.getByLabel('Access code').fill(process.env.ACCESS_CODE);",
          "await page.locator('label[for=\"spend2\"]').click();",
        ],
      },
    ],
    // Two rounds: the click changes the page, then the writer waits for the new address.
    3: [{ lines: ["await page.getByRole('button', { name: 'Book a call' }).click();"], done: false }, { lines: ["await page.waitForURL(/thanks/);"] }],
    4: [{ lines: ["await expect(page.getByText('Thanks', { exact: false })).toBeVisible();"] }],
    // A check step that tries to click is refused, then fixed.
    5: [{ lines: ["await page.getByText('Thanks').click();"] }, { lines: ["await expect(page.locator('#t')).toHaveText('Thanks, Sam Test');"] }],
  });
  const frames: Buffer[] = [];
  const { res, final } = await run("", writer, STEPS, frames);
  check(res.status === "passed", `a test with no code is written and passes (${res.status} ${res.error ?? ""})`);
  check([1, 2, 3, 4, 5].every((p) => final(p)?.status === "passed" && final(p)?.written === true), "every step passes and is marked as written");
  const step2 = seen.filter((r) => r.position === 2);
  check(/evaluate isn't a page action/.test(step2[1]?.error ?? ""), `a line outside the allowed list goes back to the writer (${step2[1]?.error})`);
  check(/Email address/.test(step2[2]?.error ?? "") && step2[2]?.done.length === 1, "a line that fails on the page goes back, with the lines that already ran");
  check(seen.filter((r) => r.position === 3).length === 2 && seen.filter((r) => r.position === 3)[1]!.done.length === 1, "a step that changes the page is finished in a second round");
  check(/only checks/.test(seen.filter((r) => r.position === 5)[1]?.error ?? ""), "a check step can't click");
  check(seen.every((r) => !JSON.stringify(r).includes(PASSWORD)), "the secret's value never reaches the writer");
  check(seen[0]!.secretNames.join() === "ACCESS_CODE", "the writer gets the secret's name");
  const contact = seen.find((r) => r.position === 2)!;
  check(/#spend2/.test(contact.fields) && /label="\$5k to \$20k"/.test(contact.fields) && /hidden/.test(contact.fields), "the writer sees hidden radio inputs and their labels");
  check(!!contact.screenshot && contact.screenshot.length > 1000 && /textbox "Full name"/.test(contact.snapshot), "the writer gets a screenshot and the accessibility tree");
  check(res.ai.calls === seen.length && res.ai.input === seen.length * 1000, `AI calls and tokens are counted (${res.ai.calls})`);
  check(frames.length > 2, `live frames are sent while the run goes (${frames.length})`);
  check(!!res.lock && parseLock(res.lock).ok, "the written code is a valid lock");
  savedLock = res.lock ?? "";
  check(savedLock.includes("// step 5: check: The page thanks the person by name") && savedLock.includes("process.env.ACCESS_CODE") && !savedLock.includes("Email address"), "the lock keeps only the lines that worked, under the right steps");
}

// 2. The saved code replays with no AI calls.
{
  const never: Writer = async () => {
    throw new Error("The writer was called on a replay.");
  };
  const { res, final } = await run(savedLock, never);
  check(res.status === "passed" && res.ai.calls === 0, `the saved code replays with no AI calls (${res.status} ${res.error ?? ""})`);
  check([1, 2, 3, 4, 5].every((p) => final(p)?.written === undefined), "replayed steps aren't marked as written");
  check(res.lock === null, "nothing new to save after a replay");
}

// 3. A step whose words changed is written again; the others replay.
{
  const steps = STEPS.map((s) => (s.position === 5 ? { ...s, label: "check: The page title is Thanks", intent: "The page title is Thanks" } : s));
  const { writer, seen } = scripted({ 5: [{ lines: ["await expect(page).toHaveTitle('Thanks');"] }] });
  const { res, final } = await run(savedLock, writer, steps);
  check(res.status === "passed" && seen.length === 1 && seen[0]!.position === 5 && final(5)?.written === true, `only the changed step is written again (${seen.map((s) => s.position).join(",")})`);
  check(!!res.lock && res.lock.includes("toHaveTitle('Thanks')") && !res.lock.includes("toHaveText('Thanks, Sam Test')") && res.lock.includes("process.env.ACCESS_CODE"), "the new lock swaps that step's code and keeps the rest");
}

// 4. A step the writer can't do fails with its reason; later steps are skipped; passing steps are still saved.
{
  const { writer } = scripted({
    1: [{ lines: ["await page.goto('/contact');"] }],
    2: [{ lines: [], done: false, problem: "There is no contact form on this page." }],
  });
  const { res, final } = await run("", writer);
  check(res.status === "failed" && final(2)?.status === "failed" && final(2)?.error === "There is no contact form on this page.", `the writer's reason is the step's error (${final(2)?.error})`);
  check([3, 4, 5].every((p) => final(p)?.status === "skipped"), "the steps after it are skipped");
  check(!!res.lock && res.lock.includes("await page.goto('/contact');") && parseLock(res.lock).ok, "the step that passed is still saved");
}

// 5. A writer that keeps failing stops after five tries.
{
  const { writer, seen } = scripted({ 1: Array.from({ length: 9 }, () => ({ lines: ["await page.getByText('Nope').click();"] })) });
  const { res, final } = await run("", writer, STEPS.slice(0, 1));
  check(res.status === "failed" && seen.length === 5 && /couldn't write this step/.test(final(1)?.error ?? ""), `the writer gets five tries (${seen.length}: ${final(1)?.error})`);
}

// 6. A writer that can't be reached fails the step with a plain message.
{
  const down: Writer = async () => {
    throw new Error("Claude couldn't write this step (529).");
  };
  const { res, final } = await run("", down, STEPS.slice(0, 1));
  check(res.status === "failed" && /529/.test(final(1)?.error ?? ""), "a writer error fails the step with its message");
}

server.close();
console.log(failures ? `${failures} failed` : "All writer checks passed");
process.exit(failures ? 1 : 0);
