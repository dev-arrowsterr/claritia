// Contacts week 1: CSV reading, column guesses, consent rules, import preparation and the shared filters.
import assert from "node:assert/strict";
import { test } from "node:test";
import { formValues, newContact, writeContacts } from "../src/lib/contacts/contacts.ts";
import { basisFor, parseBasis } from "../src/lib/contacts/consent.ts";
import { parseCsv, toCsv } from "../src/lib/contacts/csv.ts";
import { countryCode, customValue, guessTarget, type CustomField } from "../src/lib/contacts/fields.ts";
import { mappingError, prepareImport, type Mapping } from "../src/lib/contacts/import.ts";
import { applyFilters, cleanFilters, describe, matches, type Filter, type FilterField } from "../src/lib/filters.ts";

const custom: CustomField[] = [
  { key: "plan", label: "Plan", type: "enum", options: ["Free", "Pro"] },
  { key: "seats", label: "Seats", type: "number", options: [] },
  { key: "trial_end", label: "Trial end", type: "date", options: [] },
  { key: "paying", label: "Paying", type: "bool", options: [] },
];

test("csv: quotes, line breaks in cells, BOM, CRLF, semicolons and tabs", () => {
  assert.deepEqual(parseCsv('﻿email,name\r\n"a@x.com","Doe, Jane"\r\nb@x.com,"Say ""hi""\nthere"\r\n\r\n'), [
    ["email", "name"],
    ["a@x.com", "Doe, Jane"],
    ["b@x.com", 'Say "hi"\nthere'],
  ]);
  assert.deepEqual(parseCsv("email;country\na@x.com;DE"), [["email", "country"], ["a@x.com", "DE"]]);
  assert.deepEqual(parseCsv("email\tcountry\na@x.com\tDE\n"), [["email", "country"], ["a@x.com", "DE"]]);
  assert.deepEqual(parseCsv("a,b\n1,\n,\n"), [["a", "b"], ["1", ""]], "empty rows go");
  assert.deepEqual(parseCsv("a\nno\"quote"), [["a"], ['no"quote']], "a quote mid-cell stays");
});

test("csv out: quoting and formula guard round-trip", () => {
  const out = toCsv([["email", "note"], ["a@x.com", 'He said "hi", twice'], ["=cmd()", "@sum"]]);
  assert.deepEqual(parseCsv(out), [["email", "note"], ["a@x.com", 'He said "hi", twice'], ["'=cmd()", "'@sum"]]);
});

test("column guesses", () => {
  const g = (h: string) => guessTarget(h, custom);
  assert.equal(g("E-mail Address"), "email");
  assert.equal(g("First Name"), "first_name");
  assert.equal(g("Surname"), "last_name");
  assert.equal(g("Job Title"), "title");
  assert.equal(g("Company Name"), "company");
  assert.equal(g("Website URL"), "website");
  assert.equal(g("Lifecycle Stage"), "lifecycle");
  assert.equal(g("Marketing consent"), "basis");
  assert.equal(g("Plan"), "f.plan");
  assert.equal(g("trial_end"), "f.trial_end");
  assert.equal(g("Favourite colour"), "skip");
});

test("countries and custom values", () => {
  assert.equal(countryCode("de"), "DE");
  assert.equal(countryCode("Germany"), "DE");
  assert.equal(countryCode("United States"), "US");
  assert.equal(countryCode("USA"), "US");
  assert.equal(countryCode("UK"), "GB");
  assert.equal(countryCode("Narnia"), undefined);
  assert.equal(countryCode("ZZ"), undefined);
  assert.equal(customValue(custom[0], "pro"), "Pro");
  assert.equal(customValue(custom[0], "Enterprise"), undefined);
  assert.equal(customValue(custom[1], "1,200"), 1200);
  assert.equal(customValue(custom[1], "lots"), undefined);
  assert.equal(customValue(custom[2], "2026-03-31"), "2026-03-31");
  assert.equal(customValue(custom[2], "31/03/2026"), undefined);
  assert.equal(customValue(custom[3], "Yes"), true);
  assert.equal(customValue(custom[3], "0"), false);
});

test("consent: strict regions keep only opt-in; unknown places count as strict", () => {
  assert.equal(parseBasis("Opt-in"), "opt_in");
  assert.equal(parseBasis("legitimate interest"), "legitimate_interest");
  assert.equal(parseBasis("unsubscribed"), "none");
  assert.equal(parseBasis("maybe"), null);
  assert.equal(basisFor("US", "legitimate_interest"), "legitimate_interest");
  assert.equal(basisFor("DE", "legitimate_interest"), "none");
  assert.equal(basisFor("GB", "opt_in"), "opt_in");
  assert.equal(basisFor("FR", "soft_opt_in"), "soft_opt_in");
  assert.equal(basisFor(null, "legitimate_interest"), "none");
  assert.equal(basisFor("CA", "legitimate_interest"), "none", "Canada without a province could be Quebec");
});

const mapping = (columns: Mapping["columns"], extra: Partial<Mapping> = {}): Mapping => ({ columns, source: "signups", basis: "legitimate_interest", ...extra });

test("mapping checks", () => {
  assert.match(mappingError(mapping(["skip", "name"]), 2, custom)!, /Email/);
  assert.match(mappingError(mapping(["email"], { source: "bought" }), 1, custom)!, /Bought/);
  assert.match(mappingError(mapping(["email"], { basis: null }), 1, custom)!, /consent/);
  assert.equal(mappingError(mapping(["email", "basis"], { basis: null }), 2, custom), null, "a consent column is enough");
  assert.match(mappingError(mapping(["email", "email"]), 2, custom)!, /one column/);
  assert.match(mappingError(mapping(["email", "f.gone"]), 2, custom)!, /no longer exists/);
  assert.match(mappingError(mapping(["email"]), 2, custom)!, /every column/);
});

test("import: cleans, merges duplicates, drops bad cells, skips bad emails", () => {
  const rows = [
    ["Jane.Doe+news@Gmail.com", "Jane Doe", "", "Germany", "Pro", "opt-in", "acme.io"],
    ["janedoe@gmail.com", "", "CEO", "", "Enterprise", "", ""],
    ["bob@acme.com", "Bob", "", "US", "", "", ""],
    ["sales@acme.com", "", "", "", "free", "no", ""],
    ["", "No Email", "", "", "", "", ""],
    ["not-an-email", "", "", "", "", "", ""],
    ["x@mailinator.com", "", "", "", "", "", ""],
    ["max@firma.de", "Max", "", "DE", "", "", ""],
  ];
  const { contacts, counts } = prepareImport(rows, mapping(["email", "name", "title", "country", "f.plan", "basis", "website"]), { custom });
  assert.deepEqual(counts.skipped, { missing_email: 1, invalid_email: 1, disposable: 1 });
  assert.equal(counts.merged, 1);
  assert.equal(contacts.length, 4);
  const jane = contacts.find((c) => c.email_clean === "janedoe@gmail.com")!;
  assert.deepEqual([jane.first_name, jane.last_name, jane.title, jane.country, jane.fields.plan, jane.basis, jane.company_domain], ["Jane", "Doe", "CEO", "DE", "Pro", "opt_in", "acme.io"]);
  const bob = contacts.find((c) => c.email_clean === "bob@acme.com")!;
  assert.equal(bob.company_domain, "acme.com", "work email gives the company");
  assert.equal(bob.basis, "legitimate_interest", "the list's basis stands in the US");
  assert.equal(contacts.find((c) => c.email_clean === "sales@acme.com")!.basis, "none");
  assert.equal(contacts.find((c) => c.email_clean === "max@firma.de")!.basis, "none", "Germany needs opt-in");
  assert.equal(counts.no_basis, 2);
  assert.equal(contacts.find((c) => c.email_clean === "janedoe@gmail.com")!.email_class, "free");
});

test("import: long cells are cut, never fail the row", () => {
  const { contacts } = prepareImport([["a@acme.com", "x".repeat(500), "y".repeat(500)]], mapping(["email", "title", "company"]), { custom });
  assert.equal(contacts[0].title!.length, 200);
  assert.equal(contacts[0].company_name!.length, 200);
});

test("add and edit forms", () => {
  const made = newContact({ email: " Ann@Acme.com ", first_name: "Ann", country: "france", basis: "legitimate_interest", fields: { seats: "12" } }, custom);
  assert.ok("contact" in made);
  assert.deepEqual([made.contact.email_clean, made.contact.country, made.contact.company_domain, made.contact.basis, made.contact.fields.seats], ["ann@acme.com", "FR", "acme.com", "none", 12]);
  assert.match((newContact({ first_name: "x" }, custom) as { error: string }).error, /email/);
  assert.match((formValues({ country: "Atlantis" }, custom) as { error: string }).error, /country/);
  assert.match((formValues({ fields: { seats: "many" } }, custom) as { error: string }).error, /Seats/);
  const edit = formValues({ title: "", website: "https://www.acme.co.uk/about", fields: { plan: "" } }, custom);
  assert.deepEqual("values" in edit && edit.values, { title: null, company_domain: "acme.co.uk", fields: { plan: null } });
});

test("writing retries a batch whose answer was lost, and stops after the last try", async () => {
  let calls = 0;
  const seen: number[] = [];
  const rpc = async (_fn: string, args: Record<string, unknown>) => {
    calls++;
    seen.push((args.p_rows as unknown[]).length);
    if (calls === 2) return { data: null, error: { message: "socket hang up" } };
    return { data: { created: (args.p_rows as unknown[]).length, updated: 0, ids: (args.p_rows as unknown[]).map((_, i) => String(i)) }, error: null };
  };
  const rows = Array.from({ length: 2500 }, (_, i) => ({ email: `${i}@x.com`, email_clean: `${i}@x.com`, email_class: "work", fields: {} }));
  const r = await writeContacts(rpc, "ws", "import", rows, { backoffMs: 1 });
  assert.deepEqual(seen, [1000, 1000, 1000, 500], "the failed batch is sent again");
  assert.equal(r.created, 2500);
  const failing = async () => ({ data: null, error: { message: "down" } });
  await assert.rejects(writeContacts(failing, "ws", "import", rows, { backoffMs: 1, tries: 2 }), /down/);
});

type Row = { name: string | null; tags: string[]; n: number | null; at: string | null; ok: boolean; kind: string | null };
const fields: FilterField<Row>[] = [
  { key: "name", label: "Name", type: "text", get: (r) => r.name },
  { key: "tags", label: "Tags", type: "text", get: (r) => r.tags },
  { key: "n", label: "Count", type: "number", get: (r) => r.n },
  { key: "at", label: "Seen", type: "date", get: (r) => r.at },
  { key: "ok", label: "Known", type: "bool", get: (r) => r.ok },
  { key: "kind", label: "Kind", type: "enum", options: [{ value: "a", label: "Alpha" }], get: (r) => r.kind },
];

test("filters: every condition", () => {
  const now = Date.parse("2026-10-15T12:00:00Z");
  const rows: Row[] = [
    { name: "Acme Corp", tags: ["/pricing", "/docs"], n: 5, at: "2026-10-14T00:00:00Z", ok: true, kind: "a" },
    { name: null, tags: [], n: null, at: null, ok: false, kind: null },
    { name: "Globex", tags: ["/"], n: 1, at: "2026-08-01T00:00:00Z", ok: false, kind: "b" },
  ];
  const names = (fs: Filter[]) => applyFilters(rows, fs, fields, now).map((r) => r.name);
  assert.deepEqual(names([{ field: "name", op: "contains", values: ["acme"] }]), ["Acme Corp"]);
  assert.deepEqual(names([{ field: "name", op: "is", values: ["GLOBEX"] }]), ["Globex"]);
  assert.deepEqual(names([{ field: "name", op: "is_not", values: ["globex"] }]), ["Acme Corp", null]);
  assert.deepEqual(names([{ field: "name", op: "empty", values: [] }]), [null]);
  assert.deepEqual(names([{ field: "tags", op: "contains", values: ["pric"] }]), ["Acme Corp"]);
  assert.deepEqual(names([{ field: "tags", op: "empty", values: [] }]), [null]);
  assert.deepEqual(names([{ field: "n", op: "gte", values: ["2"] }]), ["Acme Corp"]);
  assert.deepEqual(names([{ field: "n", op: "lte", values: ["1"] }]), ["Globex"]);
  assert.deepEqual(names([{ field: "at", op: "within", values: ["7"] }]), ["Acme Corp"]);
  assert.deepEqual(names([{ field: "at", op: "before", values: ["30"] }]), ["Globex"]);
  assert.deepEqual(names([{ field: "ok", op: "is", values: ["false"] }]), [null, "Globex"]);
  assert.deepEqual(names([{ field: "kind", op: "is_not", values: ["a"] }]), [null, "Globex"]);
  assert.deepEqual(names([{ field: "kind", op: "is", values: ["a"] }, { field: "n", op: "gte", values: ["9"] }]), [], "all filters must pass");
  assert.equal(matches(5, { field: "n", op: "gte", values: ["x"] }, "number"), false);
});

test("filters: tags read as words, and saved filters are checked", () => {
  assert.equal(describe({ field: "kind", op: "is", values: ["a"] }, fields[5] as never), "Kind is Alpha");
  assert.equal(describe({ field: "at", op: "before", values: ["30"] }, fields[3] as never), "Seen more than 30 days ago");
  assert.equal(describe({ field: "ok", op: "is", values: ["true"] }, fields[4] as never), "Known: Yes");
  assert.deepEqual(
    cleanFilters([{ field: "name", op: "contains", values: ["a", 3] }, { field: "nope", op: "is", values: ["x"] }, { field: "n", op: "contains", values: ["1"] }, { field: "name", op: "empty", values: ["x"] }], fields as never),
    [{ field: "name", op: "contains", values: ["a"] }, { field: "name", op: "empty", values: [] }],
  );
});
