// Nurture drafts (supabase/migrations/042_nurture.sql, src/lib/nurture): cleaning what the AI wrote, the cache that
// keeps a repeat request off the model, and the email layout.
import assert from "node:assert/strict";
import { test } from "node:test";
import { briefDomains, cleanSteps, draftKey, draftSteps, type DraftInput, type DraftStep, type Drafter } from "../src/lib/nurture/draft.ts";
import { readStep, stepEmail } from "../src/lib/nurture/email.ts";

const step = (o: Partial<DraftStep> = {}): DraftStep => ({ subject: "Your guide", preheader: "Three ideas", paragraphs: ["Hi {{first_name}}, here it is."], cta_label: "Read it", cta_url: "https://acme.com/guide", wait_days: 3, review_notes: [], ...o });
const input = (o: Partial<DraftInput> = {}): DraftInput => ({ workspace: "Acme", brief: "Acme helps finance teams close the books in 3 days. Guide: https://go.acme.com/close", domains: ["acme.com", "go.acme.com"], existing: [], count: 2, replace: null, ...o });

test("drafts keep links on our domains only, lose placeholders, and stay in range", () => {
  const out = cleanSteps(
    [step(), step({ cta_url: "https://evil.example.com/x", wait_days: 400 }), step({ cta_url: "http://acme.com/plain" }), step()],
    ["acme.com"],
    3,
  );
  assert.equal(out.length, 3);
  assert.equal(out[0].paragraphs[0], "Hi, here it is.");
  assert.equal(out[0].cta_url, "https://acme.com/guide");
  assert.equal(out[1].cta_url, "");
  assert.equal(out[1].cta_label, "");
  assert.equal(out[1].wait_days, 90);
  assert.match(out[1].review_notes.at(-1)!, /isn't on your domains: https:\/\/evil\.example\.com\/x/);
  assert.equal(out[2].cta_url, "", "http links are dropped");
  assert.equal(cleanSteps([step({ cta_url: "https://www.blog.acme.com/a" })], ["acme.com"], 1)[0].cta_url, "https://www.blog.acme.com/a", "subdomains count");
  assert.deepEqual(briefDomains("See https://go.acme.com/close and https://www.acme.com."), ["go.acme.com", "acme.com."]);
});

test("the cache key follows every input, and the domains' order doesn't matter", () => {
  assert.equal(draftKey(input()), draftKey(input({ domains: ["go.acme.com", "acme.com"] })));
  assert.notEqual(draftKey(input()), draftKey(input({ brief: "Something else entirely, long enough to matter." })));
  assert.notEqual(draftKey(input()), draftKey(input({ count: 3 })));
  assert.match(draftKey(input()), /^[0-9a-f]{64}$/);
});

test("a repeat request comes from the cache and never calls the model", async () => {
  const store = new Map<string, unknown>();
  const rpc = async (fn: string, args: Record<string, unknown>) => {
    if (fn === "ai_cache_get") return { data: store.get(String(args.p_key)) ?? null, error: null };
    if (fn === "ai_cache_put") {
      store.set(String(args.p_key), args.p_output);
      return { data: null, error: null };
    }
    return { data: null, error: { message: "unexpected" } };
  };
  let calls = 0;
  const drafter: Drafter = async () => {
    calls++;
    return { steps: [step(), step({ subject: "Second" })], model: "claude-opus-5-5", input_tokens: 900, output_tokens: 700 };
  };
  const first = await draftSteps(rpc, drafter, "ws1", input());
  const again = await draftSteps(rpc, drafter, "ws1", input());
  assert.equal(calls, 1);
  assert.equal(first.cached, false);
  assert.equal(again.cached, true);
  assert.deepEqual(again.steps, first.steps);
  await draftSteps(rpc, drafter, "ws1", input({ count: 1 }));
  assert.equal(calls, 2, "a different request calls the model");
  const empty: Drafter = async () => ({ steps: [], model: "m", input_tokens: 0, output_tokens: 0 });
  await assert.rejects(draftSteps(rpc, empty, "ws1", input({ brief: "x".repeat(50) })), /didn't write any emails/);
});

test("a step's email escapes what was typed and reads back for editing", () => {
  const e = stepEmail({ paragraphs: ["Close <faster>.", "Line one\nline two"], cta_label: "Get the \"guide\"", cta_url: "https://acme.com/g?a=1&b=2" });
  assert.ok(!e.html.includes("<faster>"));
  assert.match(e.html, /Close &lt;faster&gt;\./);
  assert.match(e.html, /href="https:\/\/acme\.com\/g\?a=1&amp;b=2"/);
  assert.deepEqual(e.links, ["https://acme.com/g?a=1&b=2"]);
  assert.equal(e.text, 'Close <faster>.\n\nLine one\nline two\n\nGet the "guide": https://acme.com/g?a=1&b=2\n');
  assert.deepEqual(readStep(e.html, e.text), { paragraphs: ["Close <faster>.", "Line one\nline two"], cta_label: 'Get the "guide"', cta_url: "https://acme.com/g?a=1&b=2" });
  const plain = stepEmail({ paragraphs: ["Just words."], cta_label: "", cta_url: "" });
  assert.deepEqual(plain.links, []);
  assert.deepEqual(readStep(plain.html, plain.text), { paragraphs: ["Just words."], cta_label: "", cta_url: "" });
});
