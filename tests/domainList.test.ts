import assert from "node:assert/strict";
import { test } from "node:test";
import { domainList } from "../src/lib/identity/domainList.ts";

test("domain lists clean and dedupe", () => {
  assert.deepEqual(domainList("Acme.com, https://www.acme.com/about  @partner.io\nacme.com"), { ok: ["acme.com", "partner.io"], bad: [] });
  assert.deepEqual(domainList(""), { ok: [], bad: [] });
  assert.deepEqual(domainList("acme, a..com, ok.co.uk"), { ok: ["ok.co.uk"], bad: ["acme", "a..com"] });
});
