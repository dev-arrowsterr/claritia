import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanEmail, cleanHubspot, cleanIdentifier, cleanUser, hashOf } from "../src/lib/identity/clean.ts";
import { guardFails, identifyToken, verifyIdentify } from "../src/lib/identity/stitch.ts";

const clean = (s: string, ws = {}) => {
  const c = cleanEmail(s, ws);
  return "rejected" in c ? c.rejected : `${c.clean} ${c.class}`;
};

test("emails: trim, case, wrappers, provider rules", () => {
  assert.equal(clean("  Jane.Doe+news@GoogleMail.com "), "janedoe@gmail.com free");
  assert.equal(clean("j.a.n.e@gmail.com"), "jane@gmail.com free");
  assert.equal(clean("mailto:Bob@Acme.com"), "bob@acme.com work");
  assert.equal(clean("<bob@acme.com>"), "bob@acme.com work");
  assert.equal(clean('"bob@acme.com"'), "bob@acme.com work");
  assert.equal(clean("bob+crm@acme.com"), "bob@acme.com work", "company mail drops +tags");
  assert.equal(clean("b.o.b@acme.com"), "b.o.b@acme.com work", "dots matter outside Gmail");
  assert.equal(clean("me+x@yahoo.com"), "me+x@yahoo.com free", "Yahoo keeps the tag");
  assert.equal(clean("me@me.com"), "me@icloud.com free");
  assert.equal(clean("x@protonmail.com"), "x@proton.me free");
  assert.equal(clean("jane@bücher.de"), "jane@xn--bcher-kva.de work");
  assert.equal(clean("x@acme.com."), "x@acme.com work");
});

test("emails: classes", () => {
  const ws = { own_domains: ["tryclaritia.com"], partner_domains: ["agency.io"] };
  assert.equal(clean("me@tryclaritia.com", ws), "me@tryclaritia.com own");
  assert.equal(clean("me@eu.tryclaritia.com", ws), "me@eu.tryclaritia.com own");
  assert.equal(clean("sam@agency.io", ws), "sam@agency.io partner");
  assert.equal(clean("sales@acme.com", ws), "sales@acme.com role");
  assert.equal(clean("no-reply@acme.com", ws), "no-reply@acme.com role");
  assert.equal(clean("x@mailinator.com"), "disposable");
});

test("emails: invalid", () => {
  for (const s of ["", "a", "a@b", "@acme.com", "a@@acme.com", "a b@acme.com", "a@acme..com", "+@acme.com", "x".repeat(65) + "@acme.com", "a@" + "b".repeat(260) + ".com"]) assert.equal(clean(s), "invalid", s);
  assert.equal(cleanIdentifier("email", 42).constructor, Object);
});

test("user and HubSpot ids", () => {
  const u = cleanUser("  U_88 ");
  assert.ok(!("rejected" in u) && u.clean === "U_88", "case is kept");
  for (const bad of ["", "null", "undefined", "Anonymous", "0", "none"]) assert.deepEqual(cleanUser(bad), { rejected: "blocked" }, bad);
  assert.deepEqual(cleanUser("x".repeat(129)), { rejected: "invalid" });
  assert.ok(!("rejected" in cleanHubspot("12345")));
  assert.deepEqual(cleanHubspot("12a"), { rejected: "invalid" });
  assert.deepEqual(cleanHubspot("000"), { rejected: "invalid" });
});

test("hashes are SHA-256 of the clean value", () => {
  const c = cleanEmail("Jane@Acme.com");
  assert.ok(!("rejected" in c));
  assert.deepEqual(c.hash, hashOf("jane@acme.com"));
  assert.equal(c.hash.length, 32);
});

test("merge guards", () => {
  const e = (clean: string, domain: string, cls = "work") => ({ kind: "email", clean, domain, class: cls });
  assert.equal(guardFails([e("a@x.io", "x.io"), { kind: "user", clean: "u1", domain: null, class: null }]), null);
  assert.equal(guardFails([{ kind: "user", clean: "u1", domain: null, class: null }, { kind: "user", clean: "u2", domain: null, class: null }]), "two_user_ids");
  const hs = [{ kind: "hubspot", clean: "1", domain: null, class: null }, { kind: "hubspot", clean: "2", domain: null, class: null }];
  assert.equal(guardFails(hs), "two_hubspot_ids");
  assert.equal(guardFails(hs, true), null, "HubSpot's own merge is allowed");
  assert.equal(guardFails(["a", "b", "c", "d", "e", "f"].map((l) => e(`${l}@x.io`, "x.io"))), "too_many_emails");
  assert.equal(guardFails([e("a@x.io", "x.io"), e("a@y.io", "y.io"), e("a@z.io", "z.io")]), "three_company_domains");
  assert.equal(guardFails([e("a@x.io", "x.io"), e("a@y.io", "y.io"), e("a@gmail.com", "gmail.com", "free")]), null, "free mail doesn't count as a company");
});

test("signed identify tokens", () => {
  const at = Date.UTC(2026, 9, 15);
  const iat = at / 1000;
  const t = identifyToken("s1".repeat(20), "site", "u_88", "Jane@Acme.com", iat);
  assert.ok(verifyIdentify(["s1".repeat(20)], "site", "u_88", "jane@acme.com", iat, t, at), "email case doesn't matter");
  assert.ok(verifyIdentify(["old".repeat(12), "s1".repeat(20)], "site", "u_88", "jane@acme.com", iat, t, at), "the next secret works during rotation");
  assert.ok(!verifyIdentify(["s1".repeat(20)], "site", "u_99", "jane@acme.com", iat, t, at), "another user");
  assert.ok(!verifyIdentify(["s1".repeat(20)], "other", "u_88", "jane@acme.com", iat, t, at), "another site");
  assert.ok(!verifyIdentify(["s1".repeat(20)], "site", "u_88", "jane@acme.com", iat, t, at + 25 * 3600_000), "older than a day");
  assert.ok(!verifyIdentify(["s1".repeat(20)], "site", "u_88", "jane@acme.com", String(iat), t, at), "iat must be a number");
  assert.ok(!verifyIdentify([], "site", "u_88", "jane@acme.com", iat, t, at), "no secrets, nothing verifies");
});
