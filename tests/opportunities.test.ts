import assert from "node:assert/strict";
import { test } from "node:test";
import { day, dealRecord, num, stageValue, toOpportunityRows, type Deal } from "../src/lib/sources/opportunities.ts";

const deal = (over: Partial<Deal> = {}): Deal => ({
  name: "Acme renewal",
  amount: 12000,
  stage: "Contract sent",
  stageKind: "open",
  closeDate: "2026-11-30",
  probability: 80,
  owner: "Ana",
  pipeline: "Sales",
  nextStep: null,
  url: "https://app.hubspot.com/contacts/1/record/0-3/9",
  ...over,
});

test("closed deals always land on won and lost, open stages keep the CRM's name", () => {
  assert.equal(stageValue("Closed Won", "won"), "won");
  assert.equal(stageValue("Verloren", "lost"), "lost");
  assert.equal(stageValue("Contract sent", "open"), "contract_sent");
  assert.equal(stageValue("Négociation", "open"), "negociation");
  assert.equal(stageValue("Won", "open"), "won_open", "an open stage named Won isn't counted as won");
  assert.equal(stageValue(null, "open"), null);
  assert.equal(stageValue("—", "open"), null);
});

test("amounts, dates and win chances from every CRM's format", () => {
  assert.equal(num("12,500.50"), 12500.5);
  assert.equal(num(""), null);
  assert.equal(num("n/a"), null);
  assert.equal(day("2026-03-31"), "2026-03-31");
  assert.equal(day("2026-03-31T22:00:00.000Z"), "2026-03-31");
  assert.equal(day("1774915200000"), "2026-03-31");
  assert.equal(day("soon"), null);
  const [won] = toOpportunityRows([dealRecord("1", null, false, deal({ stageKind: "won", probability: null }))]);
  assert.equal(won.fields.probability, 100);
  const [lost] = toOpportunityRows([dealRecord("2", null, false, deal({ stageKind: "lost", probability: null }))]);
  assert.equal(lost.fields.probability, 0);
  const [over] = toOpportunityRows([dealRecord("3", null, false, deal({ probability: 140 }))]);
  assert.equal(over.fields.probability, 100);
});

test("rows carry links only when the CRM said something about them", () => {
  const rows = toOpportunityRows([
    dealRecord("1", null, false, deal({ company: "c1", contacts: ["p1", "p1", "p2"] })),
    dealRecord("2", null, false, deal({ company: null, contacts: [] })),
    dealRecord("3", null, false, deal()),
    dealRecord("4", null, true, deal()),
  ]);
  assert.deepEqual(
    rows.map((r) => r.id),
    ["1", "2", "3"],
    "deleted deals go through opportunities_remove",
  );
  assert.equal(rows[0].company, "c1");
  assert.deepEqual(rows[0].contacts, ["p1", "p2"]);
  assert.equal(rows[1].company, "", "an empty company clears the link");
  assert.deepEqual(rows[1].contacts, []);
  assert.ok(!("company" in rows[2]) && !("contacts" in rows[2]), "not read: links stay as they are");
});

test("only https CRM links are kept", () => {
  const [r] = toOpportunityRows([dealRecord("1", null, false, deal({ url: "javascript:alert(1)" }))]);
  assert.equal(r.fields.crm_url, undefined);
});
