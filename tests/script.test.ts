import assert from "node:assert/strict";
import { test } from "node:test";
import { readConsent } from "../collect/script/consent.ts";
import { hubspotEmail } from "../collect/script/adapters/hubspot.ts";
import { otherDomain } from "../collect/script/hop.ts";

test("claritia.consent() wins over every tool", () => {
  const w = { Cookiebot: { consent: { statistics: true }, hasResponse: true } };
  assert.deepEqual(readConsent(w, false), { state: "denied", tool: "api" });
  assert.deepEqual(readConsent(w, true), { state: "granted", tool: "api" });
});

test("Cookiebot", () => {
  assert.deepEqual(readConsent({ Cookiebot: { consent: { statistics: true }, hasResponse: true } }, null), { state: "granted", tool: "cookiebot" });
  assert.deepEqual(readConsent({ Cookiebot: { consent: { statistics: false }, hasResponse: true } }, null), { state: "denied", tool: "cookiebot" });
  assert.deepEqual(readConsent({ Cookiebot: { consent: { statistics: false }, hasResponse: false } }, null), { state: "unknown", tool: "cookiebot" });
});

test("OneTrust", () => {
  assert.deepEqual(readConsent({ OnetrustActiveGroups: ",C0001,C0002," }, null), { state: "granted", tool: "onetrust" });
  assert.deepEqual(readConsent({ OnetrustActiveGroups: "C0001,C0002" }, null), { state: "granted", tool: "onetrust" });
  assert.deepEqual(readConsent({ OnetrustActiveGroups: ",C0001,C00021," }, null), { state: "unknown", tool: "onetrust" });
  assert.deepEqual(readConsent({ OnetrustActiveGroups: ",C0001,", OneTrust: { IsAlertBoxClosed: () => true } }, null), { state: "denied", tool: "onetrust" });
  assert.deepEqual(readConsent({ OnetrustActiveGroups: ",C0001,", OneTrust: { IsAlertBoxClosed: () => false } }, null), { state: "unknown", tool: "onetrust" });
});

test("Google Consent Mode v2: the last command wins, a bare default denied is unknown", () => {
  const args = (...a: unknown[]) => a;
  assert.deepEqual(readConsent({ dataLayer: [args("consent", "default", { analytics_storage: "denied" })] }, null), { state: "unknown", tool: "gcm" });
  assert.deepEqual(
    readConsent({ dataLayer: [args("consent", "default", { analytics_storage: "denied" }), { event: "x" }, args("consent", "update", { analytics_storage: "granted" })] }, null),
    { state: "granted", tool: "gcm" },
  );
  assert.deepEqual(
    readConsent({ dataLayer: [args("consent", "default", { analytics_storage: "granted" }), args("consent", "update", { analytics_storage: "denied" })] }, null),
    { state: "denied", tool: "gcm" },
  );
  assert.deepEqual(readConsent({ dataLayer: [args("consent", "update", { ad_storage: "granted" })] }, null), { state: "unknown", tool: "none" });
  assert.deepEqual(readConsent({ dataLayer: [null, 5, "x"] }, null), { state: "unknown", tool: "none" });
});

test("no tool at all", () => {
  assert.deepEqual(readConsent({}, null), { state: "unknown", tool: "none" });
});

test("HubSpot form message gives only the email", () => {
  assert.equal(hubspotEmail({ type: "hsFormCallback", eventName: "onFormSubmitted", data: { submissionValues: { email: "jane@acme.com", firstname: "Jane" } } }), "jane@acme.com");
  assert.equal(hubspotEmail({ type: "hsFormCallback", eventName: "onFormSubmitted", data: [{ name: "firstname", value: "Jane" }, { name: "email", value: "j@a.co" }] }), "j@a.co");
  assert.equal(hubspotEmail({ type: "hsFormCallback", eventName: "onFormReady", data: { submissionValues: { email: "jane@acme.com" } } }), "");
  assert.equal(hubspotEmail({ type: "other" }), "");
  assert.equal(hubspotEmail("hsFormCallback"), "");
  assert.equal(hubspotEmail(null), "");
});

test("hop links go only to the site's other domains", () => {
  const domains = ["acme.com", "acme.io"];
  assert.ok(otherDomain("acme.io", "www.acme.com", domains));
  assert.ok(otherDomain("app.acme.io", "www.acme.com", domains));
  assert.ok(otherDomain("ACME.IO", "www.acme.com", domains));
  assert.ok(!otherDomain("www.acme.com", "www.acme.com", domains));
  assert.ok(!otherDomain("evilacme.io", "www.acme.com", domains));
  assert.ok(!otherDomain("acme.io.evil.com", "www.acme.com", domains));
  assert.ok(!otherDomain("google.com", "www.acme.com", domains));
});
