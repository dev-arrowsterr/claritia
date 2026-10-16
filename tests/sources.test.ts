// Every connector against recorded answers (docs/contact-sources.md Part 1): it reads two pages and keeps its
// cursor, gets through a 429, marks deleted records, maps consent, and checks webhook signatures. Answers are
// shaped from each tool's docs; they're re-recorded from a real account before launch.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { makeCtx } from "../src/lib/sources/ctx.ts";
import { effectiveMapping, recordsToRows } from "../src/lib/sources/map.ts";
import { connectorFor } from "../src/lib/sources/registry.ts";
import type { Creds, Page, RawRecord, SourceRow } from "../src/lib/sources/types.ts";
import { CATALOG } from "../src/lib/sources/catalog.ts";

const row = (kind: string): SourceRow => ({ id: "s1", workspace_id: "w1", kind, name: kind, account: "a", status: "active", settings: {}, cursors: {}, push_cursor: null });

/** A fetch that answers in order for each URL pattern, with a 429 first. */
function recorded(routes: [RegExp, unknown[]][]) {
  const seen = new Map<RegExp, number>();
  const calls: string[] = [];
  let throttled = false;
  const fetcher: typeof fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (!throttled) {
      throttled = true;
      return new Response("{}", { status: 429, headers: { "retry-after": "1" } });
    }
    for (const [re, answers] of routes) {
      if (!re.test(url)) continue;
      const i = seen.get(re) ?? 0;
      seen.set(re, i + 1);
      return Response.json(answers[Math.min(i, answers.length - 1)]);
    }
    return Response.json({ message: `no recording for ${url}` }, { status: 404 });
  };
  return { fetcher, calls };
}

async function pullAll(kind: string, creds: Creds, routes: [RegExp, unknown[]][], object: "contacts" | "companies" | "suppressions" = "contacts") {
  const { fetcher, calls } = recorded(routes);
  const ctx = makeCtx({ source: row(kind), creds, fetcher, sleep: async () => {} });
  const c = connectorFor(kind)!;
  const records: RawRecord[] = [];
  let cursor: string | null = null;
  const pages: Page[] = [];
  for (let i = 0; i < 10; i++) {
    const p: Page = await c.pull!(ctx, object, cursor);
    pages.push(p);
    records.push(...p.records);
    cursor = p.cursor;
    if (!p.more) break;
  }
  return { records, pages, calls, cursor, consent: (r: RawRecord) => c.consent?.(r) ?? null };
}

const key = (values: Record<string, string>): Creds => ({ type: "key", values });
const oauth = (extra: Record<string, string> = {}): Creds => ({ type: "oauth", access: "tok", refresh: "r", expiresAt: Date.now() + 3_600_000, extra });

test("every catalog entry has a connector", () => {
  for (const e of CATALOG) assert.ok(connectorFor(e.kind), e.kind);
});

test("HubSpot: search pages, the window moves on, deletes and consent", async () => {
  const p1 = { results: [{ id: "1", properties: { email: "a@x.com", hs_email_optout: "true", lastmodifieddate: "2026-01-01T00:00:00Z" } }], paging: { next: { after: "100" } } };
  const p2 = { results: [{ id: "2", properties: { email: "b@x.com", hs_legal_basis: "Freely given consent from contact", lastmodifieddate: "2026-01-02T00:00:00Z" } }] };
  const r = await pullAll("hubspot", oauth(), [[/contacts\/search/, [p1, p2]]]);
  assert.deepEqual(r.records.map((x) => x.id), ["1", "2"]);
  assert.equal(r.pages.length, 2);
  assert.equal(JSON.parse(r.cursor!).since, Date.parse("2026-01-02T00:00:00Z") - 300_000, "next window starts 5 minutes before the newest change");
  assert.equal(r.consent(r.records[0]), "unsubscribed");
  assert.equal(r.consent(r.records[1]), "opt_in");
  // A record that's gone reads as deleted.
  const { fetcher } = recorded([[/batch\/read/, [{ results: [{ id: "1", properties: { email: "a@x.com" } }] }]]]);
  const got = await connectorFor("hubspot")!.fetch!(makeCtx({ source: row("hubspot"), creds: oauth(), fetcher, sleep: async () => {} }), "contacts", ["1", "9"]);
  assert.deepEqual(got.map((x) => [x.id, !!x.deleted]), [["1", false], ["9", true]]);
});

test("HubSpot: an expired token is refreshed once", async () => {
  let n = 0;
  const fetcher: typeof fetch = async (input, init) => {
    n++;
    const auth = new Headers(init?.headers).get("authorization");
    if (String(input).includes("account-info")) return auth === "Bearer new" ? Response.json({ portalId: 5 }) : Response.json({}, { status: 401 });
    return Response.json({});
  };
  const ctx = makeCtx({ source: row("hubspot"), creds: oauth(), fetcher, sleep: async () => {}, refresh: async () => ({ access: "new", refresh: "r2", expiresAt: Date.now() + 1e6 }) });
  assert.deepEqual(await connectorFor("hubspot")!.account(ctx), { id: "5", label: "Portal 5" });
  assert.equal(n, 2);
});

test("Salesforce: leads then contacts, deleted rows, consent", async () => {
  const lead = { records: [{ Id: "00Q1", Email: "l@x.com", Status: "Open - Not Contacted", HasOptedOutOfEmail: true, IsDeleted: false, SystemModstamp: "2026-01-01T00:00:00.000+0000" }], done: false, nextRecordsUrl: "/services/data/v61.0/query/01g-2000" };
  const lead2 = { records: [{ Id: "00Q2", Email: "gone@x.com", IsDeleted: true, SystemModstamp: "2026-01-02T00:00:00.000+0000" }], done: true };
  const contact = { records: [{ Id: "0031", Email: "c@x.com", Account: { Name: "Acme", Website: "acme.com" }, EmailBouncedReason: "550", IsDeleted: false, SystemModstamp: "2026-01-03T00:00:00.000+0000" }], done: true };
  const r = await pullAll("salesforce", oauth({ instance_url: "https://acme.my.salesforce.com" }), [
    [/query\/01g-2000/, [lead2]],
    [/FROM%20Lead/, [lead]],
    [/FROM%20Contact/, [contact]],
  ]);
  assert.deepEqual(r.records.map((x) => [x.id, !!x.deleted]), [["00Q1", false], ["00Q2", true], ["0031", false]]);
  assert.equal(r.records[2].data.Company, "Acme");
  assert.equal(r.consent(r.records[0]), "unsubscribed");
  assert.equal(r.consent(r.records[2]), "bounced");
  const cols = effectiveMapping(connectorFor("salesforce")!, "contact", [], [], []);
  const { rows } = recordsToRows([r.records[0]], cols, connectorFor("salesforce")!.consent);
  assert.ok(rows[0].includes("new"), "lead status maps to ours");
});

test("Omniscient: offset pages, signed webhooks", async () => {
  const full = Array.from({ length: 100 }, (_, i) => ({ id: `c${i}`, email: `p${i}@x.com`, name: "A B", title: null, phone: null, lifecycle: "engaged" }));
  const r = await pullAll("omniscient", key({ api_key: "omn_x", url: "https://app.tryomniscient.com" }), [[/contacts/, [{ data: full }, { data: [{ id: "z", email: "z@x.com", lifecycle: "lost" }] }]]]);
  assert.equal(r.records.length, 101);
  assert.equal(r.cursor, null, "starts over next time");
  const c = connectorFor("omniscient")!;
  const body = JSON.stringify({ id: "d1", event: "contact.updated", data: { id: "c1", email: "p1@x.com" } });
  const t = Math.floor(Date.now() / 1000);
  const sig = `t=${t},v1=${createHmac("sha256", "whsec_1").update(`${t}.${body}`).digest("hex")}`;
  assert.ok(c.verify!({ headers: new Headers({ "omniscient-signature": sig }), body, url: "", method: "POST" }, "whsec_1"));
  assert.ok(!c.verify!({ headers: new Headers({ "omniscient-signature": sig }), body: body + " ", url: "", method: "POST" }, "whsec_1"));
  assert.equal(c.parse!(JSON.parse(body), new Headers())[0].id, "c1");
});

test("Pipedrive: full read, then the recents feed", async () => {
  const p1 = { data: [{ id: 1, name: "A", email: [{ value: "a@x.com", primary: true }], phone: [], org_name: "Acme", update_time: "2026-01-01 10:00:00", active_flag: true, marketing_status: "unsubscribed" }], additional_data: { pagination: { more_items_in_collection: true, next_start: 500 } } };
  const p2 = { data: [{ id: 2, name: "B", email: [{ value: "b@x.com", primary: true }], phone: [], update_time: "2026-01-02 10:00:00", active_flag: false }], additional_data: { pagination: { more_items_in_collection: false } } };
  const r = await pullAll("pipedrive", key({ api_key: "pd" }), [[/persons/, [p1, p2]]]);
  assert.deepEqual(r.records.map((x) => [x.id, !!x.deleted]), [["1", false], ["2", true]]);
  assert.equal(JSON.parse(r.cursor!).since, "2026-01-02 09:55:00");
  assert.equal(r.consent(r.records[0]), "unsubscribed");
  assert.ok(r.calls.every((u) => u.includes("api_token=pd")));
});

test("Attio and Close: pages and fields", async () => {
  const people = Array.from({ length: 500 }, (_, i) => ({ id: { record_id: `r${i}` }, created_at: "", values: { email_addresses: [{ email_address: `p${i}@x.com` }], name: [{ first_name: "A", last_name: "B" }] } }));
  const a = await pullAll("attio", oauth(), [[/people\/records\/query/, [{ data: people }, { data: [] }]]]);
  assert.equal(a.records.length, 500);
  assert.equal(a.records[0].data.email, "p0@x.com");
  const c = await pullAll("close", key({ api_key: "k" }), [[/contact\//, [{ data: [{ id: "c1", name: "A", emails: [{ email: "a@x.com" }], phones: [], date_updated: "2026-01-01T00:00:00Z" }], has_more: true }, { data: [], has_more: false }]]]);
  assert.equal(c.records[0].data.email, "a@x.com");
  assert.ok(c.calls.some((u) => u.includes("_skip=100")));
});

test("Mailchimp: audience by audience, status to consent, lists", async () => {
  const r = await pullAll("mailchimp", key({ api_key: "abc-us21" }), [
    [/\/lists\?/, [{ lists: [{ id: "L1", name: "Newsletter" }, { id: "L2", name: "Webinar" }] }]],
    [/lists\/L1\/members/, [{ members: [{ id: "m1", email_address: "a@x.com", status: "subscribed", merge_fields: { FNAME: "A" }, last_changed: "2026-01-01T00:00:00Z" }], total_items: 1 }]],
    [/lists\/L2\/members/, [{ members: [{ id: "m2", email_address: "b@x.com", status: "cleaned", merge_fields: {}, last_changed: "2026-01-02T00:00:00Z" }], total_items: 1 }]],
  ]);
  assert.deepEqual(r.records.map((x) => x.lists?.[0].name), ["Newsletter", "Webinar"]);
  assert.equal(r.consent(r.records[0]), "opt_in");
  assert.equal(r.consent(r.records[1]), "bounced");
  assert.ok(r.calls.every((u) => u.startsWith("https://us21.api.mailchimp.com")));
});

test("Klaviyo, ActiveCampaign, Brevo, Kit, MailerLite: pages and consent", async () => {
  const kv = await pullAll("klaviyo", key({ api_key: "pk" }), [
    [/profiles/, [
      { data: [{ id: "k1", attributes: { email: "a@x.com", updated: "2026-01-01T00:00:00Z", subscriptions: { email: { marketing: { consent: "SUBSCRIBED" } } } } }], links: { next: "https://a.klaviyo.com/api/profiles?page[cursor]=2" } },
      { data: [{ id: "k2", attributes: { email: "b@x.com", updated: "2026-01-02T00:00:00Z", subscriptions: { email: { marketing: { consent: "SUBSCRIBED", suppression: [{ reason: "HARD_BOUNCE" }] } } } } }], links: {} },
    ]],
  ]);
  assert.deepEqual(kv.records.map(kv.consent), ["opt_in", "bounced"]);
  const ac = await pullAll("activecampaign", key({ url: "https://acme.api-us1.com", api_key: "k" }), [[/contacts/, [{ contacts: [{ id: "1", email: "a@x.com", udate: "2026-01-01T00:00:00-05:00" }], meta: { total: "101" } }, { contacts: [{ id: "2", email: "b@x.com", udate: "2026-01-02T00:00:00-05:00" }], meta: { total: "101" } }]]]);
  assert.equal(ac.records.length, 2);
  const br = await pullAll("brevo", key({ api_key: "k" }), [[/contacts/, [{ contacts: [{ id: 1, email: "a@x.com", emailBlacklisted: true, attributes: { FIRSTNAME: "A" }, modifiedAt: "2026-01-01T00:00:00Z" }], count: 1 }]]]);
  assert.equal(br.consent(br.records[0]), "unsubscribed");
  const kt = await pullAll("kit", key({ api_key: "k" }), [[/subscribers/, [{ subscribers: [{ id: 1, email_address: "a@x.com", state: "active", created_at: "" }], total_pages: 2 }, { subscribers: [{ id: 2, email_address: "b@x.com", state: "bounced", created_at: "" }], total_pages: 2 }]]]);
  assert.deepEqual(kt.records.map(kt.consent), ["opt_in", "bounced"]);
  const ml = await pullAll("mailerlite", key({ api_key: "k" }), [[/subscribers/, [{ data: [{ id: "1", email: "a@x.com", status: "unsubscribed", fields: {} }], meta: { next_cursor: "n2" } }, { data: [{ id: "2", email: "b@x.com", status: "active", fields: {} }], meta: { next_cursor: null } }]]]);
  assert.deepEqual(ml.records.map(ml.consent), ["unsubscribed", "opt_in"]);
});

test("Stripe and Intercom: pages; Stripe customers are customers", async () => {
  const st = await pullAll("stripe", key({ api_key: "rk" }), [[/customers/, [{ data: [{ id: "cus_1", email: "a@x.com", created: 1 }], has_more: true }, { data: [{ id: "cus_2", email: "b@x.com", created: 1, deleted: true }], has_more: false }]]]);
  assert.deepEqual(st.records.map((x) => [x.id, !!x.deleted, x.data.lifecycle]), [["cus_1", false, "customer"], ["cus_2", true, "customer"]]);
  assert.ok(st.calls.some((u) => u.includes("starting_after=cus_1")));
  const ic = await pullAll("intercom", key({ api_key: "t" }), [[/contacts\/search/, [{ data: [{ id: "i1", email: "a@x.com", role: "lead", updated_at: 100, unsubscribed_from_emails: true }], pages: { next: { starting_after: "x" } } }, { data: [], pages: {} }]]]);
  assert.equal(ic.consent(ic.records[0]), "unsubscribed");
});

test("forms and meeting tools: signatures, answers to columns, one person per email", () => {
  const h = (headers: Record<string, string>, body: string) => ({ headers: new Headers(headers), body, url: "", method: "POST" });
  const tf = connectorFor("typeform")!;
  const tfBody = JSON.stringify({
    form_response: {
      token: "tok1",
      definition: { fields: [{ id: "f1", title: "Company name" }, { id: "f2", title: "Your role" }] },
      hidden: { utm_source: "linkedin" },
      answers: [
        { type: "email", email: "Jane@Acme.com", field: { id: "f0" } },
        { type: "text", text: "Acme", field: { id: "f1" } },
        { type: "choice", choice: { label: "Marketing" }, field: { id: "f2" } },
      ],
    },
  });
  const sig = `sha256=${createHmac("sha256", "s").update(tfBody).digest("base64")}`;
  assert.ok(tf.verify!(h({ "typeform-signature": sig }, tfBody), "s"));
  assert.ok(!tf.verify!(h({ "typeform-signature": sig }, tfBody), "other"));
  const [e] = tf.parse!(JSON.parse(tfBody), new Headers());
  assert.equal(e.id, "jane@acme.com");
  assert.deepEqual(e.record!.data, { utm_source: "linkedin", email: "Jane@Acme.com", "Company name": "Acme", "Your role": "Marketing" });
  const cols = effectiveMapping(tf, "contact", [], Object.keys(e.record!.data), []);
  assert.deepEqual(cols.map((c) => `${c.col}→${c.target}`).sort(), ["Company name→company", "email→email"]);

  const tl = connectorFor("tally")!;
  const tlBody = JSON.stringify({ eventId: "e1", data: { fields: [{ label: "Email", type: "INPUT_EMAIL", value: "a@x.com" }, { label: "Size", type: "MULTIPLE_CHOICE", value: ["o2"], options: [{ id: "o1", text: "1-10" }, { id: "o2", text: "11-50" }] }] } });
  assert.ok(tl.verify!(h({ "tally-signature": createHmac("sha256", "k").update(tlBody).digest("base64") }, tlBody), "k"));
  assert.equal(tl.parse!(JSON.parse(tlBody), new Headers())[0].record!.data.Size, "11-50");

  const cal = connectorFor("calendly")!;
  const calBody = JSON.stringify({ event: "invitee.created", payload: { email: "b@x.com", name: "B C", uri: "u1", questions_and_answers: [{ question: "Company", answer: "Beta" }] } });
  const t = Math.floor(Date.now() / 1000);
  assert.ok(cal.verify!(h({ "calendly-webhook-signature": `t=${t},v1=${createHmac("sha256", "k").update(`${t}.${calBody}`).digest("hex")}` }, calBody), "k"));
  assert.equal(cal.parse!(JSON.parse(calBody), new Headers())[0].record!.data.Company, "Beta");
  assert.deepEqual(cal.parse!({ event: "invitee.canceled", payload: { email: "b@x.com" } }, new Headers()), []);

  const cc = connectorFor("calcom")!;
  const ccBody = JSON.stringify({ triggerEvent: "BOOKING_CREATED", payload: { uid: "b1", attendees: [{ email: "c@x.com", name: "C" }], responses: { company: { label: "Company", value: "Gamma" } } } });
  assert.ok(cc.verify!(h({ "x-cal-signature-256": createHmac("sha256", "k").update(ccBody).digest("hex") }, ccBody), "k"));
  assert.equal(cc.parse!(JSON.parse(ccBody), new Headers())[0].record!.data.Company, "Gamma");

  const api = connectorFor("api")!;
  const twice = api.parse!({ contacts: [{ email: "d@x.com", company: { name: "Delta" } }] }, new Headers());
  assert.equal(twice[0].record!.data["company name"], "Delta");
  assert.equal(api.parse!({ contacts: [{ email: "d@x.com", company: { name: "Delta" } }] }, new Headers())[0].dedupe, twice[0].dedupe, "the same post twice is one event");
  assert.deepEqual(api.parse!({ name: "no email" }, new Headers()), []);
});

test("HubSpot webhooks: v3 signature, merges and deletes", () => {
  const c = connectorFor("hubspot")!;
  const body = JSON.stringify([
    { eventId: 1, subscriptionType: "contact.propertyChange", objectId: 11, portalId: 7, occurredAt: 1 },
    { eventId: 2, subscriptionType: "contact.deletion", objectId: 12, portalId: 7, occurredAt: 2 },
    { eventId: 3, subscriptionType: "contact.merge", objectId: 13, primaryObjectId: 13, mergedObjectIds: [13, 14], portalId: 7, occurredAt: 3 },
  ]);
  const ts = String(Date.now());
  const url = "https://app.tryclaritia.com/api/hooks/hubspot";
  const sig = createHmac("sha256", "cs").update(`POST${url}${body}${ts}`).digest("base64");
  const req = { headers: new Headers({ "x-hubspot-signature-v3": sig, "x-hubspot-request-timestamp": ts }), body, url, method: "POST" };
  assert.ok(c.verify!(req, "cs"));
  assert.ok(!c.verify!({ ...req, headers: new Headers({ "x-hubspot-signature-v3": sig, "x-hubspot-request-timestamp": String(Date.now() - 600_000) }) }, "cs"), "old requests are refused");
  const events = c.parse!(JSON.parse(body), new Headers());
  assert.deepEqual(events.map((e) => [e.id, !!e.deleted]), [["11", false], ["12", true], ["14", true], ["13", false]]);
  assert.equal(c.hookAccount!(JSON.parse(body)), "7");
});

test("a 5xx is retried and then reported, never swallowed", async () => {
  let n = 0;
  const ctx = makeCtx({ source: row("brevo"), creds: key({ api_key: "k" }), fetcher: async () => (n++, new Response("{}", { status: 503 })), sleep: async () => {} });
  await assert.rejects(ctx.api("https://api.brevo.com/v3/account"), /503/);
  assert.equal(n, 4);
});

// Warehouses -------------------------------------------------------------------------------------------------

import { generateKeyPairSync } from "node:crypto";
import { bindCursor, queryError } from "../src/lib/sources/sql.ts";
import { runQuery, snowflakeJwt } from "../src/lib/sources/warehouse.ts";

const q0 = { key: "email", cursor: "updated_at", target: "contacts" as const };

test("warehouse queries: one SELECT, nothing that writes, :cursor bound outside quoted text", () => {
  assert.equal(queryError({ ...q0, sql: "select email, updated_at from users where updated_at >= :cursor" }), null);
  assert.equal(queryError({ ...q0, sql: "with x as (select 1) select * from x;" }), null, "a trailing semicolon is fine");
  assert.equal(queryError({ ...q0, sql: "select 1; drop table users" }), "One statement only.");
  assert.equal(queryError({ ...q0, sql: "select ';' as s, email from users" }), null, "a semicolon inside quotes is text");
  assert.equal(queryError({ ...q0, sql: "select 1 -- ; drop\nfrom t" }), null, "comments are ignored");
  assert.equal(queryError({ ...q0, sql: "delete from users" }), "Start with SELECT or WITH.");
  assert.equal(queryError({ ...q0, sql: "with gone as (delete from users returning *) select * from gone" }), "Only reading is allowed.");
  assert.equal(queryError({ ...q0, sql: "select * into backup from users" }), "Only reading is allowed.");
  assert.equal(queryError({ ...q0, key: "email; drop", sql: "select 1" }), "Name the key column.");
  assert.equal(queryError({ ...q0, cursor: "", sql: "select 1" }), "Name the cursor column.");
  const b = bindCursor("select ':cursor' as x from t where a >= :cursor and b < :cursor", (n) => `$${n}`);
  assert.equal(b.sql, "select ':cursor' as x from t where a >= $1 and b < $2");
  assert.equal(b.count, 2);
});

test("Snowflake key-pair JWT names the user and the key's fingerprint", () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const [, body] = snowflakeJwt("myorg-acct", "claritia_read", pem, 1000).split(".");
  const c = JSON.parse(Buffer.from(body, "base64url").toString());
  assert.match(c.iss, /^MYORG-ACCT\.CLARITIA_READ\.SHA256:[A-Za-z0-9+/=]{44}$/);
  assert.equal(c.sub, "MYORG-ACCT.CLARITIA_READ");
  assert.equal(c.exp - c.iat, 3540);
});

test("REST warehouses: the query is wrapped, the cursor goes as a parameter, and rows come back by column", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const sql = "select email, updated_at from users where updated_at >= :cursor";
  const cases: { kind: string; creds: Record<string, string>; answers: [RegExp, unknown][]; check: (body: Record<string, unknown> | string, url: string) => void }[] = [
    {
      kind: "clickhouse",
      creds: { url: "https://abc.clickhouse.cloud:8443", user: "u", password: "p" },
      answers: [[/clickhouse/, { meta: [{ name: "email" }, { name: "updated_at" }], data: [["a@x.com", "2026-01-01 00:00:00"]] }]],
      check: (body, url) => {
        assert.equal(body, "select * from (select email, updated_at from users where updated_at >= {cursor:String}) q order by updated_at limit 5000");
        assert.match(url, /param_cursor=1970/);
        assert.match(url, /readonly=1/);
      },
    },
    {
      kind: "bigquery",
      creds: { service_account: JSON.stringify({ client_email: "sa@p.iam.gserviceaccount.com", private_key: pem, project_id: "proj" }) },
      answers: [
        [/oauth2/, { access_token: "ya29" }],
        [/queries/, { jobComplete: true, schema: { fields: [{ name: "email" }, { name: "updated_at" }] }, rows: [{ f: [{ v: "a@x.com" }, { v: "1.7E9" }] }] }],
      ],
      check: (body) => {
        const b = body as { query: string; queryParameters: { parameterValue: { value: string } }[] };
        assert.match(b.query, /updated_at >= @cursor\) q order by updated_at limit 5000$/);
        assert.equal(b.queryParameters[0].parameterValue.value, "1970-01-01 00:00:00");
      },
    },
    {
      kind: "snowflake",
      creds: { account: "myorg-acct", user: "claritia_read", private_key: pem, warehouse: "WH", database: "DB" },
      answers: [[/snowflakecomputing/, { statementHandle: "h1", resultSetMetaData: { rowType: [{ name: "EMAIL" }, { name: "UPDATED_AT" }] }, data: [["a@x.com", "2026-01-01"]] }]],
      check: (body, url) => {
        const b = body as { statement: string; bindings: Record<string, { value: string }> };
        assert.match(b.statement, /updated_at >= \?\)/);
        assert.equal(b.bindings["1"].value, "1970-01-01 00:00:00");
        assert.match(url, /^https:\/\/myorg-acct\.snowflakecomputing\.com\/api\/v2\/statements/);
      },
    },
    {
      kind: "databricks",
      creds: { host: "dbc-1.cloud.databricks.com", warehouse_id: "w1", token: "dapi" },
      answers: [[/databricks/, { statement_id: "s1", status: { state: "SUCCEEDED" }, manifest: { schema: { columns: [{ name: "email" }, { name: "updated_at" }] } }, result: { data_array: [["a@x.com", "2026-01-01"]] } }]],
      check: (body) => {
        const b = body as { statement: string; parameters: { name: string; value: string }[]; row_limit: number };
        assert.match(b.statement, /updated_at >= :cursor\)/);
        assert.deepEqual(b.parameters[0], { name: "cursor", value: "1970-01-01 00:00:00", type: "STRING" });
        assert.equal(b.row_limit, 5000);
      },
    },
  ];
  for (const c of cases) {
    let seen: { body: Record<string, unknown> | string; url: string } | null = null;
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      const raw = String(init?.body ?? "");
      if (!/oauth2/.test(url)) seen = { body: (() => { try { return JSON.parse(raw); } catch { return raw; } })(), url };
      const hit = c.answers.find(([re]) => re.test(url));
      return Response.json(hit ? hit[1] : { message: "no recording" }, { status: hit ? 200 : 404 });
    };
    const ctx = makeCtx({ source: row(c.kind), creds: key(c.creds), fetcher, sleep: async () => {}, local: true });
    const r = await runQuery(ctx, { ...q0, sql }, "1970-01-01 00:00:00");
    assert.equal(r.rows.length, 1, c.kind);
    assert.equal(String(Object.values(r.rows[0])[0]), "a@x.com", c.kind);
    c.check(seen!.body, seen!.url);
  }
});

test("a warehouse host on a private network is refused", async () => {
  const ctx = makeCtx({ source: row("clickhouse"), creds: key({ url: "https://127.0.0.1:8443", user: "u", password: "p" }), fetcher: async () => Response.json({}) });
  await assert.rejects(runQuery(ctx, { ...q0, sql: "select email, updated_at from t" }, "x"), /private network/);
});
