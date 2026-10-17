// Forms (supabase/migrations/041_forms.sql): the builder's checks, answers against fields, the contact row, page
// context, the signed page token, and the page and embed script.
import assert from "node:assert/strict";
import { test } from "node:test";
import { embedScript, formPage } from "../src/lib/forms/render.ts";
import { checkAnswers, cleanContext, cleanFields, contactRow, formProblems, type FormField } from "../src/lib/forms/schema.ts";
import { shownAgo, shownToken } from "../src/lib/forms/token.ts";

const SECRET = "f".repeat(40);
const base: FormField[] = [
  { key: "email", label: "Email", type: "email", required: true, maps_to: "email" },
  { key: "first_name", label: "First name", type: "text", maps_to: "first_name" },
  { key: "size", label: "Team size", type: "select", options: ["1-10", "11-50"], required: true },
  { key: "topics", label: "Topics", type: "multi", options: ["SEO", "Ads"] },
  { key: "terms", label: "I agree", type: "checkbox", required: true },
  { key: "campaign", label: "", type: "hidden", value: "utm_campaign" },
];

test("the builder needs a name, one email field that fills email, unique keys and choices", () => {
  assert.deepEqual(formProblems("Demo", base, {}), []);
  assert.ok(formProblems("", base, {}).includes("Name the form."));
  assert.ok(formProblems("Demo", base.slice(1), {}).includes("Add one Email field that fills the contact's email."));
  assert.ok(formProblems("Demo", [...base, { ...base[1] }], {}).some((p) => p.includes("key first_name")));
  assert.ok(formProblems("Demo", [...base, { key: "x", label: "X", type: "select", options: [] }], {}).some((p) => p.includes("choices")));
  assert.ok(formProblems("Demo", base, { redirect_url: "http://x.com" }).includes("The redirect must start with https://."));
  assert.ok(formProblems("Demo", base, { color: "blue" }).includes("Pick a color like #266DF0."));
  assert.deepEqual(cleanFields([...base, { key: "Bad Key", label: "x", type: "text" }, { key: "y", type: "nope" }, null]).map((f) => f.key), base.map((f) => f.key));
});

test("answers are checked against their fields", () => {
  const ok = checkAnswers(base, { email: " ann@acme.com ", first_name: "Ann", size: "1-10", topics: ["SEO", "Hacked"], terms: "on", extra: "dropped" });
  assert.deepEqual(ok.errors, {});
  assert.deepEqual(ok.answers, { email: "ann@acme.com", first_name: "Ann", size: "1-10", topics: ["SEO"], terms: true });
  const bad = checkAnswers(base, { email: "not-an-email", size: "500+", first_name: "x".repeat(501) });
  assert.deepEqual(bad.errors, { email: "Enter a valid email", first_name: "Too long", size: "Pick one of the choices", terms: "Required" });
  assert.deepEqual(checkAnswers(base, {}).errors.email, "Required");
});

test("mapped answers become a contact row with the consent basis", () => {
  assert.deepEqual(contactRow(base, { email: "ann@acme.com", first_name: "Ann", size: "1-10" }, "opt_in"), { targets: ["email", "first_name", "basis"], cells: ["ann@acme.com", "Ann", "opt_in"] });
});

test("page context keeps latest and first-touch UTMs, click ids, and http pages only", () => {
  const c = cleanContext({ utm: { utm_source: "linkedin", gclid: "g1", junk: "x" }, first: { utm_source: "google" }, page: "https://acme.com/pricing", referrer: "javascript:alert(1)" });
  assert.deepEqual(c, { utm: { utm_source: "linkedin", gclid: "g1", first_utm_source: "google" }, page_url: "https://acme.com/pricing", referrer: null });
  assert.deepEqual(cleanContext("nonsense"), { utm: {}, page_url: null, referrer: null });
});

test("the page token is signed for one form and tells how long ago it was shown", () => {
  const t = shownToken("form-a", 1_000_000, SECRET);
  assert.equal(shownAgo("form-a", t, 1_005_000, SECRET), 5_000);
  assert.equal(shownAgo("form-b", t, 1_005_000, SECRET), null, "another form's token");
  assert.equal(shownAgo("form-a", t.replace(/.$/, (c) => (c === "A" ? "B" : "A")), 1_005_000, SECRET), null, "a changed signature");
  assert.equal(shownAgo("form-a", "123.abc", 1_005_000, SECRET), null);
  assert.equal(shownAgo("form-a", undefined, 1_005_000, SECRET), null);
});

test("the page escapes what the builder typed and carries the honeypot, token and consent", () => {
  const html = formPage({
    id: "f1",
    name: "<b>Demo</b>",
    fields: [{ key: "email", label: `Email"><script>alert(1)</script>`, type: "email", required: true, maps_to: "email" }],
    settings: { consent: "checkbox", submit_label: "Get it", color: "#112233" },
    token: "123.abc",
    preview: false,
    captchaKey: null,
    topic: "Product news",
  });
  assert.ok(!html.includes("<script>alert(1)</script>"));
  assert.match(html, /<title>&lt;b&gt;Demo&lt;\/b&gt;<\/title>/);
  assert.match(html, /name="_hp"/);
  assert.match(html, /name="_t" value="123.abc"/);
  assert.match(html, /<input type="checkbox" name="_consent" value="1">/);
  assert.match(html, /Product news emails/);
  assert.match(html, /--brand:#112233/);
  assert.ok(!html.includes("cf-turnstile") && !html.includes("turnstile/v0/api.js"), "no Turnstile without a site key");
  const notice = formPage({ id: "f1", name: "D", fields: [], settings: { consent: "notice", captcha: true }, token: "t", preview: false, captchaKey: "site-key", topic: null });
  assert.ok(!notice.includes('<input type="checkbox" name="_consent"'));
  assert.match(notice, /class="cf-turnstile" data-sitekey="site-key"/);
});

test("the embed only listens to the app's own frames", () => {
  const js = embedScript("https://app.tryclaritia.com");
  assert.match(js, /e\.origin!==B/);
  assert.match(js, /fr\.contentWindow!==e\.source/);
  assert.match(js, /window\.claritia\("form",d\.email\)/);
  assert.doesNotThrow(() => new Function(js));
});
