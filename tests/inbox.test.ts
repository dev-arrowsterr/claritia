import assert from "node:assert/strict";
import { test } from "node:test";
import { parseLock } from "../src/lib/lock.ts";
import { anyDigits, codeNearWords, extractLink, type InboxMail } from "../worker/runner.ts";
import { inboxAddress } from "../worker/handle.ts";

const mail = (subject: string, text: string, html = ""): InboxMail => ({ subject, text, html, receivedAt: "" });
const wrap = (body: string) => `import { test, expect } from '@playwright/test';\n\ntest('x', async ({ page }) => {\n  // step 1: x\n${body}\n});\n`;

test("codes are read from the words around them", () => {
  assert.equal(codeNearWords(mail("Your code", "Your verification code is 482913.")), "482913");
  assert.equal(codeNearWords(mail("Sign in", "", "<p>Your one-time code: <b>AB3-K9Q</b></p>")), "AB3-K9Q");
  assert.equal(codeNearWords(mail("Sign in", "Use code X7K2P9 to sign in")), "X7K2P9");
  assert.equal(codeNearWords(mail("Welcome", "Thanks for joining. Order 2024 ships soon.")), null);
  assert.equal(anyDigits(mail("Welcome", "Thanks for joining. Order 2024 ships soon.")), null);
  assert.equal(anyDigits(mail("Confirm your account", "Enter 5521 on the page")), "5521");
  assert.equal(anyDigits(mail("Sign in", "Call 555-1234 or use 8812")), "8812");
});

test("links prefer sign-in and confirm links, or match a pattern", () => {
  const m = mail("Confirm", "", `<a href="https://acme.com/unsubscribe">Unsubscribe</a> <a href="https://acme.com/blog">Blog</a> <a href="https://acme.com/verify?t=1&amp;u=2">Verify</a>`);
  assert.equal(extractLink(m), "https://acme.com/verify?t=1&u=2");
  assert.equal(extractLink(m, /blog/), "https://acme.com/blog");
  assert.equal(extractLink(m, /reset/), null);
  assert.equal(extractLink(mail("Hi", "Open https://acme.com/magic/abc to sign in.")), "https://acme.com/magic/abc");
});

test("inbox addresses are per project, name and run", () => {
  assert.equal(inboxAddress("k7x2q9ab", "signup", "1f2e3d4c-0000-4000-8000-000000000000", "inbox.tryclaritia.com"), "k7x2q9ab-signup-1f2e3d@inbox.tryclaritia.com");
});

test("the lock reads inbox values and waits", () => {
  const ok = parseLock(wrap(`  await page.getByLabel('Email').fill(inbox.address('signup'));\n  await page.getByLabel('Code').fill(inbox.code('signup'));\n  await page.goto(inbox.link('signup', /confirm/));\n  await inbox.waitFor('signup', /Welcome/i);`));
  assert.ok(ok.ok);
  assert.equal(ok.ok && ok.usesInbox, true);
  assert.equal(ok.ok && ok.secrets.length, 0);
  const plain = parseLock(wrap(`  await page.goto('/');`));
  assert.equal(plain.ok && plain.usesInbox, false);
  const bad = (body: string) => {
    const p = parseLock(wrap(body));
    return p.ok ? "" : p.errors[0]!.message;
  };
  assert.match(bad(`  await page.getByLabel('Email').fill(inbox.address('Sign Up'));`), /lowercase letters/);
  assert.match(bad(`  await page.getByLabel('Email').fill(inbox.read('signup'));`), /isn't something Claritia knows/);
  assert.match(bad(`  await page.getByLabel('Email').fill(inbox.code('signup', /x/));`), /takes an inbox name/);
  assert.match(bad(`  await inbox.delete('signup');`), /isn't an inbox action/);
  assert.match(bad(`  await page.goto(inbox.link('signup', 'confirm'));`), /\/pattern\//);
});
