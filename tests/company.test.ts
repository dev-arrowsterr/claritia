import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { readCoresignal, sizeBand } from "../src/lib/company/coresignal.ts";
import { readIpinfo, sampleIp } from "../src/lib/company/ipinfo.ts";

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

test("a network's sample address", () => {
  assert.equal(sampleIp("203.0.113.0/24"), "203.0.113.1");
  assert.equal(sampleIp("2001:db8:abcd::/48"), "2001:db8:abcd::1");
  assert.equal(sampleIp("nope"), null);
});

test("Coresignal company data from a real response", () => {
  const f = readCoresignal(JSON.parse(readFileSync(new URL("./fixtures/coresignal-company-clean.json", import.meta.url), "utf8")));
  assert.deepEqual(f, { name: "Stripe", employees: 16597, size: "10,001+", industry: "Technology, Information and Internet", country: "US", founded: 2010, type: "Privately Held" });
  assert.equal(sizeBand(7), "1-10");
  assert.equal(sizeBand(600), "501-1,000");
  assert.equal(sizeBand(null), null);
  assert.deepEqual(readCoresignal({}), { name: null, employees: null, size: null, industry: null, country: null, founded: null, type: null });
});
