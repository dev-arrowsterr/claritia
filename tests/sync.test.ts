// Two-way sync, part 2 (supabase/migrations/040_sync.sql): which side wins each field, activity text, and the
// HubSpot and Salesforce activity writes with their failure cases.
import assert from "node:assert/strict";
import { test } from "node:test";
import { activityText } from "../src/lib/sources/activity.ts";
import { hubspot } from "../src/lib/sources/hubspot.ts";
import { decide, toRemote, type Col } from "../src/lib/sources/map.ts";
import { salesforce } from "../src/lib/sources/salesforce.ts";
import type { ActivityItem, Ctx } from "../src/lib/sources/types.ts";

const cols = (wins: Col["wins"] = "claritia"): Col[] => [
  { col: "email", target: "email", valueMap: {} },
  { col: "jobtitle", target: "title", valueMap: {}, wins },
  { col: "phone", target: "phone", valueMap: {}, wins },
  { col: "claritia_score", target: "score", valueMap: {} },
];

test("a change on one side only goes across, whatever the setting", () => {
  const last = { title: "CEO", phone: "1" };
  // The CRM changed the title; Claritia didn't touch it.
  assert.deepEqual(decide(cols(), { title: "CTO", phone: "1" }, last, { title: "CEO", phone: "1" }, 10, () => 5), { strip: ["phone"], force: { title: "CTO" } });
  // Claritia changed the title; the CRM didn't. It stays here (and goes out on the next push).
  assert.deepEqual(decide(cols("crm"), { title: "CEO", phone: "1" }, last, { title: "VP", phone: "1" }, 10, () => 5), { strip: ["title", "phone"], force: {} });
  // The CRM cleared a field.
  assert.deepEqual(decide(cols(), { phone: "1" }, last, { title: "CEO", phone: "1" }, 10, () => 5).force, { title: null });
});

test("both sides changed: Claritia, CRM or the newest change wins", () => {
  const last = { title: "CEO" };
  const remote = { title: "CTO" };
  const local = { title: "VP" };
  assert.deepEqual(decide(cols("claritia"), remote, last, local, 10, () => 5), { strip: ["title", "phone"], force: {} });
  assert.deepEqual(decide(cols("crm"), remote, last, local, 10, () => 5).force, { title: "CTO" });
  assert.deepEqual(decide(cols("newest"), remote, last, local, 10, () => 5).force, { title: "CTO" }, "the CRM changed later");
  assert.deepEqual(decide(cols("newest"), remote, last, local, 5, () => 10).force, {}, "Claritia changed later");
  assert.deepEqual(decide(cols("newest"), remote, last, local, null, () => 10).force, {}, "no time from the CRM: Claritia keeps it");
  // Both landed on the same value: nothing to do.
  assert.deepEqual(decide(cols("crm"), { title: "VP" }, last, local, 10, () => 5), { strip: ["phone"], force: {} });
});

test("the score is out only and goes out in the CRM's column", () => {
  const r = decide(cols("crm"), { title: "CEO" }, { title: "CEO", score: 10 }, { title: "CEO", score: 80 }, 10, () => 5);
  assert.ok(!("score" in r.force) && !r.strip.includes("score"));
  assert.deepEqual(toRemote(cols(), { email_clean: "a@b.co", email: "a@b.co", title: "CEO", score: 80 }), { email: "a@b.co", jobtitle: "CEO", claritia_score: 80 });
});

const item = (o: Partial<ActivityItem>): ActivityItem => ({ id: "e1", kind: "email.sent", at: "2026-10-17T10:00:00.000Z", contact_id: "c1", external_id: "101", data: {}, subject: "October news", ...o });

test("activity reads as one line plus detail", () => {
  assert.deepEqual(activityText(item({})), { action: "Email sent", title: "October news", detail: "" });
  assert.deepEqual(activityText(item({ kind: "email.clicked", data: { url: "https://acme.com/a" } })), { action: "Email clicked", title: "October news", detail: "https://acme.com/a" });
  assert.equal(activityText(item({ kind: "email.unsubscribed", data: { scope: "topic" } })).detail, "From this topic");
  assert.deepEqual(activityText(item({ kind: "form.submitted", subject: null, data: { form_name: "Demo request", answers: { Company: "Acme", Seats: 40, Empty: "", Topics: ["SEO", "Ads"] } } })), {
    action: "Form submitted",
    title: "Demo request",
    detail: "Company: Acme\nSeats: 40\nTopics: SEO, Ads",
  });
});

function ctxWith(handler: (url: string, body: unknown) => unknown): { ctx: Ctx; calls: { url: string; body: unknown }[] } {
  const calls: { url: string; body: unknown }[] = [];
  const ctx = {
    api: async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ url, body });
      return handler(url, body);
    },
    secret: (n: string) => (n === "instance_url" ? "https://acme.my.salesforce.com" : ""),
  } as unknown as Ctx;
  return { ctx, calls };
}

test("HubSpot timeline: our event id rides along, and a copy HubSpot already has counts as sent", async () => {
  process.env.HUBSPOT_TIMELINE_TEMPLATE = "tpl-1";
  try {
    const { ctx, calls } = ctxWith(() => ({
      results: [{ id: "e1" }],
      errors: [
        { message: "Event e2 already exists", context: { id: ["e2"] } },
        { message: "Object 999 not found", context: { id: ["e3"] } },
      ],
    }));
    const out = await hubspot.activity!(ctx, [item({ id: "e1" }), item({ id: "e2" }), item({ id: "e3", external_id: "999" }), item({ id: "e4" })]);
    assert.deepEqual(out.map((r) => [r.id, r.status]), [["e1", "sent"], ["e2", "sent"], ["e3", "failed"], ["e4", "unknown"]]);
    const sent = (calls[0].body as { inputs: { eventTemplateId: string; objectId: string; id: string; tokens: Record<string, string> }[] }).inputs[0];
    assert.deepEqual(sent, { eventTemplateId: "tpl-1", objectId: "101", id: "e1", timestamp: "2026-10-17T10:00:00.000Z", tokens: { action: "Email sent", title: "October news", detail: "" } });
  } finally {
    delete process.env.HUBSPOT_TIMELINE_TEMPLATE;
  }
});

test("HubSpot notes, when no timeline template: one note per event; a rate limit leaves the rest unknown", async () => {
  let n = 0;
  const { ctx, calls } = ctxWith(() => {
    n++;
    if (n === 2) throw new Error("HubSpot: rate limit reached");
    return { id: `n${n}` };
  });
  const out = await hubspot.activity!(ctx, [item({ id: "e1" }), item({ id: "e2" }), item({ id: "e3" })]);
  assert.deepEqual(out.map((r) => [r.id, r.status]), [["e1", "sent"], ["e2", "unknown"], ["e3", "unknown"]]);
  assert.equal(calls.length, 2, "nothing more after the rate limit");
  const note = calls[0].body as { properties: { hs_note_body: string }; associations: { to: { id: string }; types: { associationTypeId: number }[] }[] };
  assert.match(note.properties.hs_note_body, /Email sent:<\/strong> October news/);
  assert.equal(note.associations[0].to.id, "101");
  assert.equal(note.associations[0].types[0].associationTypeId, 202);
});

test("Salesforce tasks: one completed Task per event; a failed call leaves its events unknown", async () => {
  const { ctx, calls } = ctxWith(() => [{ id: "00T1", success: true }, { success: false, errors: [{ statusCode: "INVALID_CROSS_REFERENCE_KEY", message: "bad WhoId" }] }]);
  const out = await salesforce.activity!(ctx, [item({ id: "e1", external_id: "00Q1" }), item({ id: "e2", kind: "form.submitted", external_id: "003X", data: { form_name: "Demo" } })]);
  assert.deepEqual(out, [
    { id: "e1", status: "sent", external_id: "00T1" },
    { id: "e2", status: "failed", error: "bad WhoId" },
  ]);
  const recs = (calls[0].body as { records: Record<string, unknown>[] }).records;
  assert.equal(calls[0].url, "https://acme.my.salesforce.com/services/data/v61.0/composite/sobjects");
  assert.deepEqual(recs[0], { attributes: { type: "Task" }, WhoId: "00Q1", Subject: "Email sent: October news", Status: "Completed", Priority: "Normal", ActivityDate: "2026-10-17", TaskSubtype: "Email" });
  assert.equal(recs[1].TaskSubtype, "Task");

  const down = ctxWith(() => {
    throw new Error("Salesforce 503");
  });
  assert.deepEqual((await salesforce.activity!(down.ctx, [item({ id: "e1" })])).map((r) => r.status), ["unknown"]);
});

test("Salesforce pushes the score only where the org has Claritia's fields", async () => {
  const seen: Record<string, unknown>[] = [];
  const { ctx } = ctxWith((url, body) => {
    if (url.endsWith("/sobjects/Lead/describe")) return { fields: [{ name: "Claritia_Score__c", updateable: true }] };
    if (url.endsWith("/sobjects/Contact/describe")) return { fields: [] };
    if (url.includes("/composite/sobjects")) {
      seen.push(...(body as { records: Record<string, unknown>[] }).records);
      return (body as { records: unknown[] }).records.map(() => ({ success: true }));
    }
    return { records: [] };
  });
  await salesforce.push!(ctx, [
    { localId: "l1", externalId: "00Q1", values: { Email: "a@b.co", ClaritiaScore: 80, ClaritiaBand: "hot" } },
    { localId: "l2", externalId: "0031", values: { Email: "c@d.co", ClaritiaScore: 40 } },
  ]);
  assert.deepEqual(seen[0], { attributes: { type: "Lead" }, id: "00Q1", Email: "a@b.co", Claritia_Score__c: 80 });
  assert.deepEqual(seen[1], { attributes: { type: "Contact" }, id: "0031", Email: "c@d.co" });
});
