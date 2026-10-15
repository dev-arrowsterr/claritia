import assert from "node:assert/strict";
import { test } from "node:test";
import { pathMatches, REMOVED, scrubProps, scrubText, scrubUrl } from "../collect/scrub.ts";

const SECRETS = [
  "jane@acme.com",
  "jane.doe+news@sub.acme.co.uk",
  "o'neil@acme.io",
  "JANE@ACME.COM",
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
  "eyJhbGciOiJub25lIn0.eyJ1IjoxfQ.",
  "3f2b8c1e-9d4a-4f6b-8e2a-1c5d7e9f0a3b",
  "3F2B8C1E9D4A4F6B8E2A1C5D7E9F0A3B",
  "a1b2c3d4e5f6a7b8c9d0",
  // Built at runtime so secret scanners don't flag fake keys.
  ["sk", "live", "4eC39HqLyjWDarjtT1zdp7dc"].join("_"),
  ["ghp", "16C7e42F292c6912E7710c838347Ae178B4a"].join("_"),
  "Zx9_k-Qw2Er4Ty6Ui8Op0As2Df4Gh6Jk8Lz",
  "+1 (415) 555-0132",
  "415-555-0132x",
  "+44 20 7946 0958",
  "4155550132",
  "123456789012",
  "8f14e45fceea167a5a36dedd4bea2543",
  "Pa55w0rdResetCode",
  "AKIA" + "IOSFODNN7EXAMPLE",
];

const KEEP = [
  "pricing",
  "how-to-set-up-a-b2b-marketing-plan-for-2026",
  "internationalization",
  "2026-10-15",
  "v2",
  "case-studies",
  "q3",
  "page-12",
  "Book a demo",
  "salesforce-vs-hubspot",
];

test("secrets in free text are removed", () => {
  for (const s of SECRETS) {
    const out = scrubText(`see ${s} now`);
    assert.ok(!out.includes(s), `kept ${s}: ${out}`);
    assert.ok(out.includes(REMOVED), `no marker for ${s}`);
  }
});

test("normal words and slugs stay", () => {
  for (const s of KEEP) assert.equal(scrubText(s), s, s);
});

test("secrets in query values never survive, with and without encoding", () => {
  let n = 0;
  for (const s of SECRETS) {
    for (const key of ["q", "utm_content", "ref", "next", "x"]) {
      for (const v of [s, encodeURIComponent(s)]) {
        const out = scrubUrl(`https://acme.com/a?${key}=${v}`);
        assert.ok(!out.includes(s) && !out.includes(encodeURIComponent(s)), `${key}=${v} -> ${out}`);
        n++;
      }
    }
  }
  assert.ok(n >= 200);
});

test("secrets in path segments are replaced whole", () => {
  for (const s of SECRETS) {
    const out = scrubUrl(`https://acme.com/reset/${encodeURIComponent(s)}/done`);
    assert.equal(out, `/reset/${REMOVED}/done`, s);
  }
});

test("secret-named keys go even with a harmless value", () => {
  for (const key of ["token", "access_token", "password", "session_id", "api_key", "code", "email", "sig", "otp"]) {
    assert.equal(scrubUrl(`https://acme.com/x?${key}=abc&utm_source=g`), "/x?utm_source=g", key);
  }
});

test("allowlist keeps only allowed keys", () => {
  const allow = ["utm_source", "utm_medium", "q"];
  assert.equal(scrubUrl("https://acme.com/s?utm_source=g&foo=1&Q=crm&utm_medium=cpc", { allow }), "/s?utm_source=g&Q=crm&utm_medium=cpc");
  assert.equal(scrubUrl("https://acme.com/s?token=1", { allow: ["token"] }), "/s");
});

test("fragment, user info and own params are dropped", () => {
  assert.equal(scrubUrl("https://bob:pw@acme.com/a?b=1#access_token=xyz"), "/a?b=1");
  assert.equal(scrubUrl("https://acme.com/a?_clr_x=abc&clr=def&page=2"), "/a?page=2");
});

test("origin is kept on request", () => {
  assert.equal(scrubUrl("https://www.google.com/search?q=crm+tools&sxsrf=AB12cd34EF56gh78", { origin: true }), "https://www.google.com/search?q=crm%20tools");
});

test("non-web and broken URLs give nothing", () => {
  assert.equal(scrubUrl("mailto:jane@acme.com"), "");
  assert.equal(scrubUrl("javascript:alert(1)"), "");
  assert.equal(scrubUrl("http://[bad"), "");
  assert.equal(scrubUrl("/rel/path?q=1", { base: "https://acme.com/" }), "/rel/path?q=1");
});

test("output length is capped", () => {
  assert.ok(scrubUrl("https://acme.com/" + "a/".repeat(2000)).length <= 2000);
});

test("private path patterns", () => {
  const p = ["/account", "/checkout/*", "/help/*/ticket"];
  assert.ok(pathMatches("/account", p));
  assert.ok(pathMatches("/account/billing", p));
  assert.ok(pathMatches("/Checkout", p));
  assert.ok(pathMatches("/checkout/step-2", p));
  assert.ok(pathMatches("/help/42/ticket", p));
  assert.ok(!pathMatches("/accounts", p));
  assert.ok(!pathMatches("/pricing", p));
  assert.ok(!pathMatches("/help/42", p));
  assert.ok(!pathMatches("/x", [""]));
  assert.ok(!pathMatches("/a.b", ["/a+b"]));
});

test("track props are flat, scrubbed and small", () => {
  assert.deepEqual(scrubProps({ plan: "pro", seats: 5, trial: true, note: "mail jane@acme.com", password: "x", nested: { a: 1 }, n: NaN }), {
    plan: "pro",
    seats: 5,
    trial: true,
    note: `mail ${REMOVED}`,
  });
  assert.equal(scrubProps(null), null);
  assert.equal(scrubProps([1, 2]), null);
  const big: Record<string, string> = {};
  for (let i = 0; i < 15; i++) big["k" + i] = "w ".repeat(150);
  assert.equal(scrubProps(big), null);
});
