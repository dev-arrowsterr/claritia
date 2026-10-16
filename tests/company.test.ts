import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { readCoresignal, sizeBand } from "../src/lib/company/coresignal.ts";
import { ipKey, netVerdict, openIp, readIpinfo, sealIp, setsAccount } from "../src/lib/company/ipinfo.ts";

test("IPinfo kinds and confidence", () => {
  const biz = readIpinfo({ company: { name: "Acme", domain: "acme.com", type: "business" }, asn: { domain: "acme.com", type: "business" }, privacy: {} });
  assert.deepEqual([biz.kind, biz.domain, biz.confidence], ["business", "acme.com", 90]);
  const broadband = readIpinfo({ company: { name: "Acme", domain: "acme.com", type: "business" }, asn: { domain: "comcast.net", type: "isp" } });
  assert.deepEqual([broadband.kind, broadband.confidence], ["business", 75]);
  assert.equal(readIpinfo({ company: { domain: "x.com", type: "business" }, asn: { type: "isp" }, privacy: { vpn: true } }).kind, "vpn");
  assert.equal(readIpinfo({ company: { domain: "aws.com", type: "hosting" }, asn: { type: "hosting" } }).kind, "hosting");
  assert.equal(readIpinfo({ company: { domain: "mit.edu", type: "education" } }).kind, "education");
  assert.equal(readIpinfo({ asn: { domain: "comcast.net", type: "isp" } }).kind, "isp");
  // Lite: network owner only, never a company.
  const lite = readIpinfo({ ip: "8.8.8.8", asn: "AS15169", as_name: "Google LLC", as_domain: "google.com", country_code: "US" });
  assert.deepEqual([lite.kind, lite.domain, lite.confidence, lite.asnDomain], ["unknown", null, 0, "google.com"]);
});

test("IPinfo's newer API shape (as, anonymous, is_hosting, is_mobile) reads the same way", () => {
  assert.equal(readIpinfo({ company: { domain: "acme.com", type: "business" }, as: { domain: "acme.com", type: "business" } }).confidence, 90);
  assert.equal(readIpinfo({ company: { domain: "acme.com", type: "business" }, as: { type: "isp" }, anonymous: { is_vpn: true } }).kind, "vpn");
  assert.equal(readIpinfo({ company: { domain: "acme.com", type: "business" }, is_anonymous: true }).kind, "vpn");
  assert.equal(readIpinfo({ company: { domain: "aws.com", type: "business" }, is_hosting: true }).kind, "hosting");
  assert.equal(readIpinfo({ company: { domain: "t-mobile.com", type: "business" }, is_mobile: true }).kind, "mobile");
  assert.equal(readIpinfo({ as: { domain: "comcast.net", type: "isp" } }).kind, "isp");
});

test("a lookup sets an account only for a confident business, school or government match", () => {
  assert.ok(setsAccount({ domain: "acme.com", kind: "business", confidence: 75 }));
  assert.ok(!setsAccount({ domain: "acme.com", kind: "business", confidence: 60 }));
  assert.ok(!setsAccount({ domain: "comcast.net", kind: "isp", confidence: 90 }));
  assert.ok(!setsAccount({ domain: null, kind: "business", confidence: 90 }));
  assert.ok(!setsAccount(null));
});

test("a whole network gets a company only when 3 different IPs agree, and one dissent makes it mixed", () => {
  const acme = { domain: "acme.com", kind: "business" as const, confidence: 90 };
  assert.deepEqual(netVerdict([]), { state: "undecided" });
  assert.deepEqual(netVerdict([acme, acme]), { state: "undecided" }, "two agreeing IPs aren't enough");
  assert.deepEqual(netVerdict([acme, acme, { ...acme, confidence: 75 }]), { state: "agreed", domain: "acme.com", kind: "business", confidence: 75 });
  // A shared broadband block: one office's static IP, neighbors on home lines and another company.
  assert.deepEqual(netVerdict([acme, { domain: "comcast.net", kind: "isp", confidence: 90 }, acme, acme]), { state: "mixed" });
  assert.deepEqual(netVerdict([acme, acme, { domain: "globex.com", kind: "business", confidence: 90 }]), { state: "mixed" });
  assert.deepEqual(netVerdict([acme, acme, { ...acme, confidence: 60 }]), { state: "mixed" }, "a weak match is a dissent");
  assert.deepEqual(netVerdict([{ domain: null, kind: "unknown", confidence: 0 }]), { state: "mixed" });
});

test("the visitor's IP travels encrypted and the cache key never holds it", () => {
  const secret = "s".repeat(40);
  const sealed = sealIp("203.0.113.57", secret);
  assert.ok(!sealed.includes("203.0.113"));
  assert.equal(openIp(sealed, secret), "203.0.113.57");
  assert.equal(openIp(sealed, "t".repeat(40)), null, "another secret can't open it");
  assert.equal(openIp(sealed.slice(0, -2) + (sealed.endsWith("A") ? "BB" : "AA"), secret), null, "a changed value fails");
  assert.equal(openIp(undefined, secret), null);
  assert.notEqual(sealIp("203.0.113.57", secret), sealed, "a fresh nonce each time");
  assert.deepEqual(ipKey("203.0.113.57", secret), ipKey("203.0.113.57", secret), "the cache key is stable");
  assert.notDeepEqual(ipKey("203.0.113.57", secret), ipKey("203.0.113.58", secret));
  assert.ok(!ipKey("203.0.113.57", secret).toString("latin1").includes("203.0.113"));
});

test("Coresignal company data from a real response", () => {
  const f = readCoresignal(JSON.parse(readFileSync(new URL("./fixtures/coresignal-company-clean.json", import.meta.url), "utf8")));
  assert.deepEqual(f, { name: "Stripe", employees: 16597, size: "10,001+", industry: "Technology, Information and Internet", country: "US", founded: 2010, type: "Privately Held" });
  assert.equal(sizeBand(7), "1-10");
  assert.equal(sizeBand(600), "501-1,000");
  assert.equal(sizeBand(null), null);
  assert.deepEqual(readCoresignal({}), { name: null, employees: null, size: null, industry: null, country: null, founded: null, type: null });
});
