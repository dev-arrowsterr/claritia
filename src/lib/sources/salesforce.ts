// Salesforce, two-way (docs/contact-sources.md Part 4). Leads that aren't converted and Contacts come in through
// queryAll on SystemModstamp (oldest first, 5 minutes of overlap, deleted rows included so deletes come across),
// Accounts as companies. Changes go out through Composite sObject collections, 200 per call; new contacts are
// created as Leads unless Salesforce already has the email. Change Data Capture (Pub/Sub API) comes later; until
// then the pull runs every few minutes.

import { readCursor } from "./ctx.ts";
import { dealRecord, day, num } from "./opportunities.ts";
import type { Connector, Ctx, Page, PushChange, PushResult, RawRecord } from "./types.ts";

const V = "v61.0";
const OVERLAP_MS = 5 * 60_000;
const base = (ctx: Ctx) => {
  const u = ctx.secret("instance_url");
  if (!/^https:\/\/[a-z0-9.-]+\.(salesforce|force)\.com$/i.test(u)) throw new Error("Sign in to Salesforce again.");
  return `${u}/services/data/${V}`;
};

const LEAD = "Id, Email, FirstName, LastName, Title, Phone, Company, Website, Country, State, Status, HasOptedOutOfEmail, EmailBouncedReason, IsDeleted, SystemModstamp";
const CONTACT = "Id, Email, FirstName, LastName, Title, Phone, Account.Name, Account.Website, MailingCountry, MailingState, HasOptedOutOfEmail, EmailBouncedReason, IsDeleted, SystemModstamp";
const ACCOUNT = "Id, Name, Website, Industry, NumberOfEmployees, BillingCountry, IsDeleted, SystemModstamp";

type Row = Record<string, unknown> & { Id: string; SystemModstamp: string; IsDeleted?: boolean };
type QueryOut = { records: Row[]; done: boolean; nextRecordsUrl?: string };
type Cur = { phase: "Lead" | "Contact"; since: Record<string, string>; next: string | null; max: string };

const soqlTime = (iso: string) => new Date(iso).toISOString().replace(/\.\d{3}Z$/, "Z");

// Leads and Contacts share one set of column names, so one mapping fits both.
function person(type: "Lead" | "Contact", r: Row): RawRecord {
  const acc = (r.Account ?? {}) as Record<string, unknown>;
  const data =
    type === "Lead"
      ? { Type: "Lead", Email: r.Email, FirstName: r.FirstName, LastName: r.LastName, Title: r.Title, Phone: r.Phone, Company: r.Company, Website: r.Website, Country: r.Country, State: r.State, LeadStatus: r.Status, HasOptedOutOfEmail: r.HasOptedOutOfEmail, EmailBouncedReason: r.EmailBouncedReason }
      : { Type: "Contact", Email: r.Email, FirstName: r.FirstName, LastName: r.LastName, Title: r.Title, Phone: r.Phone, Company: acc.Name, Website: acc.Website, Country: r.MailingCountry, State: r.MailingState, HasOptedOutOfEmail: r.HasOptedOutOfEmail, EmailBouncedReason: r.EmailBouncedReason };
  return { id: r.Id, updatedAt: r.SystemModstamp, deleted: !!r.IsDeleted, data };
}

async function query(ctx: Ctx, soql: string, next: string | null): Promise<QueryOut> {
  const url = next ? `${ctx.secret("instance_url")}${next}` : `${base(ctx)}/queryAll?q=${encodeURIComponent(soql)}`;
  return ctx.api<QueryOut>(url);
}

async function pullPeople(ctx: Ctx, cursor: string | null): Promise<Page> {
  const c = readCursor<Cur>(cursor, { phase: "Lead", since: {}, next: null, max: "" });
  const since = c.since[c.phase] ?? "1970-01-01T00:00:00.000Z";
  const soql =
    c.phase === "Lead"
      ? `SELECT ${LEAD} FROM Lead WHERE IsConverted = false AND SystemModstamp >= ${soqlTime(since)} ORDER BY SystemModstamp ASC`
      : `SELECT ${CONTACT} FROM Contact WHERE SystemModstamp >= ${soqlTime(since)} ORDER BY SystemModstamp ASC`;
  const d = await query(ctx, soql, c.next);
  const records = d.records.map((r) => person(c.phase, r));
  const max = records.reduce((m, r) => ((r.updatedAt ?? "") > m ? (r.updatedAt as string) : m), c.max);
  if (!d.done && d.nextRecordsUrl) return { records, cursor: JSON.stringify({ ...c, next: d.nextRecordsUrl, max }), more: true };
  const done = { ...c.since, [c.phase]: max ? new Date(Math.max(Date.parse(since), Date.parse(max) - OVERLAP_MS)).toISOString() : since };
  if (c.phase === "Lead") return { records, cursor: JSON.stringify({ phase: "Contact", since: done, next: null, max: "" }), more: true };
  return { records, cursor: JSON.stringify({ phase: "Lead", since: done, next: null, max: "" }), more: false };
}

async function pullAccounts(ctx: Ctx, cursor: string | null): Promise<Page> {
  const c = readCursor<{ since: string; next: string | null; max: string }>(cursor, { since: "1970-01-01T00:00:00.000Z", next: null, max: "" });
  const d = await query(ctx, `SELECT ${ACCOUNT} FROM Account WHERE SystemModstamp >= ${soqlTime(c.since)} ORDER BY SystemModstamp ASC`, c.next);
  const records = d.records.map((r) => ({ id: r.Id, updatedAt: r.SystemModstamp, deleted: !!r.IsDeleted, data: { Name: r.Name, Website: r.Website, Industry: r.Industry, NumberOfEmployees: r.NumberOfEmployees, BillingCountry: r.BillingCountry } }));
  const max = records.reduce((m, r) => (r.updatedAt > m ? r.updatedAt : m), c.max);
  if (!d.done && d.nextRecordsUrl) return { records, cursor: JSON.stringify({ ...c, next: d.nextRecordsUrl, max }), more: true };
  const since = max ? new Date(Math.max(Date.parse(c.since), Date.parse(max) - OVERLAP_MS)).toISOString() : c.since;
  return { records, cursor: JSON.stringify({ since, next: null, max: "" }), more: false };
}

// Opportunities with their account and contact roles, deleted ones included.
const OPPORTUNITY = "Id, Name, Amount, StageName, CloseDate, Probability, IsClosed, IsWon, NextStep, Owner.Name, AccountId, IsDeleted, SystemModstamp, (SELECT ContactId FROM OpportunityContactRoles)";

async function pullOpportunities(ctx: Ctx, cursor: string | null): Promise<Page> {
  const c = readCursor<{ since: string; next: string | null; max: string }>(cursor, { since: "1970-01-01T00:00:00.000Z", next: null, max: "" });
  const d = await query(ctx, `SELECT ${OPPORTUNITY} FROM Opportunity WHERE SystemModstamp >= ${soqlTime(c.since)} ORDER BY SystemModstamp ASC`, c.next);
  const records = d.records.map((r) => {
    const roles = ((r.OpportunityContactRoles as { records?: { ContactId: string }[] } | null)?.records ?? []).map((x) => x.ContactId).filter(Boolean);
    return dealRecord(r.Id, r.SystemModstamp, !!r.IsDeleted, {
      name: (r.Name as string) ?? null,
      amount: num(r.Amount),
      stage: (r.StageName as string) ?? null,
      stageKind: r.IsClosed ? (r.IsWon ? "won" : "lost") : "open",
      closeDate: day(r.CloseDate),
      probability: num(r.Probability),
      owner: (r.Owner as { Name?: string } | null)?.Name ?? null,
      pipeline: null,
      nextStep: (r.NextStep as string) ?? null,
      url: `${ctx.secret("instance_url")}/lightning/r/Opportunity/${r.Id}/view`,
      company: (r.AccountId as string) ?? null,
      contacts: roles,
    });
  });
  const max = records.reduce((m, r) => ((r.updatedAt ?? "") > m ? (r.updatedAt as string) : m), c.max);
  if (!d.done && d.nextRecordsUrl) return { records, cursor: JSON.stringify({ ...c, next: d.nextRecordsUrl, max }), more: true };
  const since = max ? new Date(Math.max(Date.parse(c.since), Date.parse(max) - OVERLAP_MS)).toISOString() : c.since;
  return { records, cursor: JSON.stringify({ since, next: null, max: "" }), more: false };
}

// Our column names to each object's fields, for writes.
const OUT: Record<"Lead" | "Contact", Record<string, string>> = {
  Lead: { Email: "Email", FirstName: "FirstName", LastName: "LastName", Title: "Title", Phone: "Phone", Country: "Country", State: "State", LeadStatus: "Status" },
  Contact: { Email: "Email", FirstName: "FirstName", LastName: "LastName", Title: "Title", Phone: "Phone", Country: "MailingCountry", State: "MailingState" },
};
const typeOf = (id: string) => (id.startsWith("00Q") ? "Lead" : "Contact");
const fieldsFor = (type: "Lead" | "Contact", values: Record<string, unknown>) => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(values)) if (OUT[type][k]) out[OUT[type][k]] = v;
  return out;
};
const soqlList = (xs: string[]) => xs.map((x) => `'${x.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`).join(",");

type SaveResult = { id?: string; success: boolean; errors?: { statusCode: string; message: string }[] };

async function collection(ctx: Ctx, method: "POST" | "PATCH", records: Record<string, unknown>[]) {
  return ctx.api<SaveResult[]>(`${base(ctx)}/composite/sobjects`, { method, body: JSON.stringify({ allOrNone: false, records }) });
}

async function pushAll(ctx: Ctx, changes: PushChange[]): Promise<PushResult[]> {
  const out: PushResult[] = [];
  for (let i = 0; i < changes.length; i += 200) {
    const part = changes.slice(i, i + 200);
    // New ones: link to a Contact or Lead Salesforce already has with that email, else create a Lead.
    const fresh = part.filter((c) => !c.externalId);
    const emails = fresh.map((c) => String(c.values.Email ?? "").toLowerCase()).filter(Boolean);
    const existing = new Map<string, string>();
    if (emails.length) {
      for (const obj of ["Contact", "Lead"] as const) {
        const where = obj === "Lead" ? " AND IsConverted = false" : "";
        const d = await ctx.api<QueryOut>(`${base(ctx)}/query?q=${encodeURIComponent(`SELECT Id, Email FROM ${obj} WHERE Email IN (${soqlList(emails)})${where}`)}`);
        for (const r of d.records) if (r.Email && !existing.has(String(r.Email).toLowerCase())) existing.set(String(r.Email).toLowerCase(), r.Id);
      }
    }
    const updates = part.map((c) => ({ c, id: c.externalId ?? existing.get(String(c.values.Email ?? "").toLowerCase()) ?? null })).filter((x) => x.id);
    const creates = part.filter((c) => !c.externalId && !existing.has(String(c.values.Email ?? "").toLowerCase()));
    if (updates.length) {
      const res = await collection(ctx, "PATCH", updates.map(({ c, id }) => ({ attributes: { type: typeOf(id!) }, id, ...fieldsFor(typeOf(id!), c.values) })));
      updates.forEach(({ c, id }, j) => {
        const r = res[j];
        if (r?.success) out.push({ localId: c.localId, externalId: id! });
        else if (r?.errors?.some((e) => e.statusCode === "ENTITY_IS_DELETED" || e.statusCode === "NOT_FOUND" || e.statusCode === "INVALID_CROSS_REFERENCE_KEY")) out.push({ localId: c.localId, gone: true });
        else out.push({ localId: c.localId, error: r?.errors?.[0]?.message ?? "Salesforce didn't take this contact." });
      });
    }
    if (creates.length) {
      const res = await collection(
        ctx,
        "POST",
        creates.map((c) => ({ attributes: { type: "Lead" }, ...fieldsFor("Lead", c.values), LastName: c.values.LastName || "[not provided]", Company: c.values.Company || "[not provided]" })),
      );
      creates.forEach((c, j) => {
        const r = res[j];
        out.push(r?.success && r.id ? { localId: c.localId, externalId: r.id } : { localId: c.localId, error: r?.errors?.[0]?.message ?? "Salesforce didn't take this contact." });
      });
    }
  }
  return out;
}

export const salesforce: Connector = {
  kind: "salesforce",
  objects: ["companies", "contacts", "opportunities"],
  twoWay: true,
  gapMs: 200,
  async account(ctx) {
    const d = await ctx.api<QueryOut>(`${base(ctx)}/query?q=${encodeURIComponent("SELECT Id, Name FROM Organization")}`);
    const org = d.records[0] ?? ({} as Row);
    return { id: String(org.Id ?? ""), label: String(org.Name ?? "Salesforce") };
  },
  pull: (ctx, object, cursor) => (object === "companies" ? pullAccounts(ctx, cursor) : object === "opportunities" ? pullOpportunities(ctx, cursor) : pullPeople(ctx, cursor)),
  push: pushAll,
  consent(r) {
    if (r.data.EmailBouncedReason) return "bounced";
    if (r.data.HasOptedOutOfEmail === true) return "unsubscribed";
    return null;
  },
  defaults: {
    contact: { Email: "email", FirstName: "first_name", LastName: "last_name", Title: "title", Phone: "phone", Company: "company", Website: "website", Country: "country", State: "region", LeadStatus: "lead_status" },
    company: { Name: "name", Website: "domain", Industry: "industry", NumberOfEmployees: "size", BillingCountry: "country" },
    valueMaps: { LeadStatus: { "Open - Not Contacted": "new", "Working - Contacted": "attempting", "Closed - Converted": "qualified", "Closed - Not Converted": "disqualified" } },
  },
};
