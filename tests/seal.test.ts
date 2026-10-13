import assert from "node:assert/strict";
import { test } from "node:test";
import { SECRET_NAME, seal, unseal } from "../src/lib/seal.ts";

const KEY = "a-test-key-that-is-long-enough-for-aes-256";

test("a sealed value opens with the same key", () => {
  const sealed = seal("hunter2", KEY);
  assert.match(sealed, /^v1:/);
  assert.equal(unseal(sealed, KEY), "hunter2");
});

test("the same value seals differently each time", () => {
  assert.notEqual(seal("same", KEY), seal("same", KEY));
});

test("a different key can't open it", () => {
  assert.throws(() => unseal(seal("hunter2", KEY), KEY + "-other"));
});

test("a changed value is caught", () => {
  const [v, iv, tag, body] = seal("hunter2", KEY).split(":");
  const flipped = Buffer.from(body!, "base64");
  flipped[0]! ^= 1;
  assert.throws(() => unseal([v, iv, tag, flipped.toString("base64")].join(":"), KEY));
});

test("a short or missing key is refused", () => {
  assert.throws(() => seal("x", "short"), /SECRETS_KEY/);
  assert.throws(() => seal("x", ""), /SECRETS_KEY/);
});

test("secret names", () => {
  for (const ok of ["LOGIN_PASSWORD", "A", "API_KEY_2"]) assert.ok(SECRET_NAME.test(ok), ok);
  for (const bad of ["login", "2FA", "HAS SPACE", "", "X-Y"]) assert.ok(!SECRET_NAME.test(bad), bad);
});
