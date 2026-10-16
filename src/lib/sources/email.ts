// Email tools (docs/contact-sources.md Part 5): contacts with their consent and their lists, unsubscribes and
// bounces first. Mailchimp, Klaviyo, ActiveCampaign, Brevo, Kit and MailerLite. Endpoints and fields are
// rechecked against a real account before launch ("check").

import { qs, readCursor } from "./ctx.ts";
import type { Connector, Ctx, Page, RawRecord } from "./types.ts";

const since5 = (iso: string) => new Date(Date.parse(iso) - 300_000).toISOString();
const newest = (rs: { updatedAt?: string | null }[], m: string) => rs.reduce((x, r) => ((r.updatedAt ?? "") > x ? (r.updatedAt as string) : x), m);

// Mailchimp ---------------------------------------------------------------------------------------------------

const endpoints = new Map<string, string>();
async function mcBase(ctx: Ctx) {
  if (ctx.creds.type === "key") {
    const dc = ctx.secret("api_key").split("-").pop() ?? "";
    if (!/^[a-z]{2}\d{1,3}$/.test(dc)) throw new Error("That doesn't look like a Mailchimp API key (it ends in -us21 or similar).");
    return `https://${dc}.api.mailchimp.com/3.0`;
  }
  // A signed-in account says which data center it lives in.
  const tok = await ctx.token();
  if (!endpoints.has(tok)) {
    const m = await ctx.api<{ api_endpoint: string }>("https://login.mailchimp.com/oauth2/metadata", { headers: { authorization: `OAuth ${tok}` }, auth: false });
    endpoints.set(tok, m.api_endpoint);
  }
  return `${endpoints.get(tok)}/3.0`;
}
const mcAuth = (ctx: Ctx) => (ctx.creds.type === "key" ? { headers: { authorization: `Basic ${Buffer.from(`any:${ctx.secret("api_key")}`).toString("base64")}` }, auth: false } : {});

type McMember = { id: string; email_address: string; status: string; merge_fields: Record<string, unknown>; location?: { country_code?: string }; last_changed: string };

export const mailchimp: Connector = {
  kind: "mailchimp",
  objects: ["contacts"],
  gapMs: 150,
  async account(ctx) {
    const d = await ctx.api<{ account_id: string; account_name: string }>(`${await mcBase(ctx)}/`, mcAuth(ctx));
    return { id: d.account_id, label: d.account_name };
  },
  async pull(ctx, _object, cursor): Promise<Page> {
    // Audience by audience; each member carries its audience, which becomes a list here.
    const c = readCursor<{ lists: { id: string; name: string }[] | null; i: number; offset: number; since: Record<string, string>; max: string }>(cursor, { lists: null, i: 0, offset: 0, since: {}, max: "" });
    const base = await mcBase(ctx);
    const lists = c.lists ?? (await ctx.api<{ lists: { id: string; name: string }[] }>(`${base}/lists?count=1000&fields=lists.id,lists.name`, mcAuth(ctx))).lists;
    const list = lists[c.i];
    if (!list) return { records: [], cursor: JSON.stringify({ ...c, lists: null, i: 0, offset: 0 }), more: false };
    const d = await ctx.api<{ members: McMember[]; total_items: number }>(
      `${base}/lists/${list.id}/members?${qs({ count: 1000, offset: c.offset, since_last_changed: c.since[list.id] ?? null, fields: "members.id,members.email_address,members.status,members.merge_fields,members.location,members.last_changed,total_items" })}`,
      mcAuth(ctx),
    );
    const records: RawRecord[] = (d.members ?? []).map((m) => ({
      id: m.id,
      updatedAt: m.last_changed,
      data: { email: m.email_address, status: m.status, FNAME: m.merge_fields?.FNAME ?? null, LNAME: m.merge_fields?.LNAME ?? null, PHONE: m.merge_fields?.PHONE ?? null, COMPANY: m.merge_fields?.COMPANY ?? null, country: m.location?.country_code ?? null },
      lists: [{ id: list.id, name: list.name }],
    }));
    const max = newest(records, c.max);
    if (c.offset + 1000 < d.total_items) return { records, cursor: JSON.stringify({ ...c, lists, offset: c.offset + 1000, max }), more: true };
    const since = { ...c.since, ...(max ? { [list.id]: since5(max) } : {}) };
    const next = c.i + 1;
    return { records, cursor: JSON.stringify({ lists: next < lists.length ? lists : null, i: next < lists.length ? next : 0, offset: 0, since, max: "" }), more: next < lists.length };
  },
  consent(r) {
    const s = String(r.data.status ?? "");
    return s === "subscribed" ? "opt_in" : s === "unsubscribed" ? "unsubscribed" : s === "cleaned" ? "bounced" : "none";
  },
  defaults: { contact: { email: "email", FNAME: "first_name", LNAME: "last_name", PHONE: "phone", COMPANY: "company", country: "country" } },
};

// Klaviyo -----------------------------------------------------------------------------------------------------

const kvHeaders = (ctx: Ctx) => ({ headers: { authorization: `Klaviyo-API-Key ${ctx.secret("api_key")}`, revision: "2024-10-15" }, auth: false });
type KvProfile = {
  id: string;
  attributes: {
    email: string | null;
    first_name: string | null;
    last_name: string | null;
    phone_number: string | null;
    title: string | null;
    organization: string | null;
    location?: { country?: string | null };
    updated: string;
    subscriptions?: { email?: { marketing?: { consent?: string; suppression?: { reason: string }[] } } };
  };
};

export const klaviyo: Connector = {
  kind: "klaviyo",
  objects: ["contacts"],
  gapMs: 400,
  async account(ctx) {
    const d = await ctx.api<{ data: { id: string; attributes: { contact_information?: { organization_name?: string } } }[] }>("https://a.klaviyo.com/api/accounts", kvHeaders(ctx));
    const a = d.data[0];
    return { id: a?.id ?? "", label: a?.attributes.contact_information?.organization_name ?? "Klaviyo" };
  },
  async pull(ctx, _object, cursor): Promise<Page> {
    const c = readCursor<{ next: string | null; since: string | null; max: string }>(cursor, { next: null, since: null, max: "" });
    const first = `https://a.klaviyo.com/api/profiles?${qs({ "page[size]": 100, sort: "updated", "additional-fields[profile]": "subscriptions", filter: c.since ? `greater-than(updated,${c.since})` : null })}`;
    const d = await ctx.api<{ data: KvProfile[]; links?: { next?: string | null } }>(c.next ?? first, kvHeaders(ctx));
    const records = (d.data ?? []).map((p) => ({
      id: p.id,
      updatedAt: p.attributes.updated,
      data: {
        email: p.attributes.email,
        first_name: p.attributes.first_name,
        last_name: p.attributes.last_name,
        phone_number: p.attributes.phone_number,
        title: p.attributes.title,
        organization: p.attributes.organization,
        country: p.attributes.location?.country ?? null,
        consent: p.attributes.subscriptions?.email?.marketing?.consent ?? null,
        suppression: p.attributes.subscriptions?.email?.marketing?.suppression?.[0]?.reason ?? null,
      },
    }));
    const max = newest(records, c.max);
    if (d.links?.next) return { records, cursor: JSON.stringify({ ...c, next: d.links.next, max }), more: true };
    return { records, cursor: JSON.stringify({ next: null, since: max ? since5(max) : c.since, max: "" }), more: false };
  },
  consent(r) {
    const sup = String(r.data.suppression ?? "");
    if (sup === "HARD_BOUNCE" || sup === "INVALID_EMAIL") return "bounced";
    if (sup) return "unsubscribed";
    const s = String(r.data.consent ?? "");
    return s === "SUBSCRIBED" ? "opt_in" : s === "UNSUBSCRIBED" ? "unsubscribed" : null;
  },
  defaults: { contact: { email: "email", first_name: "first_name", last_name: "last_name", phone_number: "phone", title: "title", organization: "company", country: "country" } },
};

// ActiveCampaign ----------------------------------------------------------------------------------------------

const acBase = (ctx: Ctx) => {
  const u = ctx.secret("url").replace(/\/+$/, "");
  if (!/^https:\/\/[a-z0-9-]+\.(api-us1|activehosted)\.com$|^https:\/\/[a-z0-9-]+\.api-[a-z]+\d*\.com$/i.test(u)) throw new Error("Use the API URL from ActiveCampaign › Settings › Developer.");
  return `${u}/api/3`;
};
const acHeaders = (ctx: Ctx) => ({ headers: { "api-token": ctx.secret("api_key") }, auth: false });

export const activecampaign: Connector = {
  kind: "activecampaign",
  objects: ["contacts"],
  gapMs: 250,
  async account(ctx) {
    const d = await ctx.api<{ user: { id: string; email: string } }>(`${acBase(ctx)}/users/me`, acHeaders(ctx));
    return { id: new URL(ctx.secret("url")).hostname, label: d.user?.email ?? new URL(ctx.secret("url")).hostname };
  },
  async pull(ctx, _object, cursor): Promise<Page> {
    const c = readCursor<{ offset: number; since: string | null; max: string }>(cursor, { offset: 0, since: null, max: "" });
    const d = await ctx.api<{ contacts: { id: string; email: string; firstName: string; lastName: string; phone: string; orgname?: string; udate: string }[]; meta: { total: string } }>(
      `${acBase(ctx)}/contacts?${qs({ limit: 100, offset: c.offset, "orders[udate]": "ASC", "filters[updated_after]": c.since })}`,
      acHeaders(ctx),
    );
    const records = (d.contacts ?? []).map((x) => ({ id: x.id, updatedAt: x.udate, data: { email: x.email, firstName: x.firstName, lastName: x.lastName, phone: x.phone, orgname: x.orgname ?? null } }));
    const max = newest(records, c.max);
    if (c.offset + 100 < Number(d.meta?.total ?? 0)) return { records, cursor: JSON.stringify({ ...c, offset: c.offset + 100, max }), more: true };
    return { records, cursor: JSON.stringify({ offset: 0, since: max ? max.slice(0, 19).replace("T", " ") : c.since, max: "" }), more: false };
  },
  defaults: { contact: { email: "email", firstName: "first_name", lastName: "last_name", phone: "phone", orgname: "company" } },
};

// Brevo -------------------------------------------------------------------------------------------------------

const brevoHeaders = (ctx: Ctx) => ({ headers: { "api-key": ctx.secret("api_key") }, auth: false });

export const brevo: Connector = {
  kind: "brevo",
  objects: ["contacts"],
  gapMs: 150,
  async account(ctx) {
    const d = await ctx.api<{ email: string; companyName: string }>("https://api.brevo.com/v3/account", brevoHeaders(ctx));
    return { id: d.email, label: d.companyName || d.email };
  },
  async pull(ctx, _object, cursor): Promise<Page> {
    const c = readCursor<{ offset: number; since: string | null; max: string }>(cursor, { offset: 0, since: null, max: "" });
    const d = await ctx.api<{ contacts: { id: number; email: string; emailBlacklisted: boolean; attributes: Record<string, unknown>; modifiedAt: string }[]; count: number }>(
      `https://api.brevo.com/v3/contacts?${qs({ limit: 1000, offset: c.offset, sort: "asc", modifiedSince: c.since })}`,
      brevoHeaders(ctx),
    );
    const records = (d.contacts ?? []).map((x) => ({
      id: String(x.id),
      updatedAt: x.modifiedAt,
      data: { email: x.email, blacklisted: x.emailBlacklisted, FIRSTNAME: x.attributes?.FIRSTNAME ?? null, LASTNAME: x.attributes?.LASTNAME ?? null, SMS: x.attributes?.SMS ?? null, COMPANY: x.attributes?.COMPANY ?? null },
    }));
    const max = newest(records, c.max);
    if (c.offset + 1000 < (d.count ?? 0)) return { records, cursor: JSON.stringify({ ...c, offset: c.offset + 1000, max }), more: true };
    return { records, cursor: JSON.stringify({ offset: 0, since: max ? since5(max) : c.since, max: "" }), more: false };
  },
  consent: (r) => (r.data.blacklisted === true ? "unsubscribed" : null),
  defaults: { contact: { email: "email", FIRSTNAME: "first_name", LASTNAME: "last_name", SMS: "phone", COMPANY: "company" } },
};

// Kit (ConvertKit) --------------------------------------------------------------------------------------------

export const kit: Connector = {
  kind: "kit",
  objects: ["contacts", "suppressions"],
  gapMs: 600,
  async account(ctx) {
    const d = await ctx.api<{ name: string; primary_email_address: string }>(`https://api.convertkit.com/v3/account?${qs({ api_secret: ctx.secret("api_key") })}`, { auth: false });
    return { id: d.primary_email_address, label: d.name || d.primary_email_address };
  },
  async pull(ctx, object, cursor): Promise<Page> {
    // Unsubscribes come from the cancelled list; everyone else from the subscriber list by last update.
    const c = readCursor<{ page: number; since: string | null; max: string }>(cursor, { page: 1, since: null, max: "" });
    const path = object === "suppressions" ? "/subscribers" : "/subscribers";
    const d = await ctx.api<{ subscribers: { id: number; first_name: string | null; email_address: string; state: string; created_at: string; fields: Record<string, unknown> }[]; total_pages: number }>(
      `https://api.convertkit.com/v3${path}?${qs({ api_secret: ctx.secret("api_key"), page: c.page, sort_order: "asc", sort_field: "updated_at", updated_from: c.since, subscriber_state: object === "suppressions" ? "cancelled" : null })}`,
      { auth: false },
    );
    const records: RawRecord[] = (d.subscribers ?? []).map((s) =>
      object === "suppressions"
        ? { id: String(s.id), data: { email: s.email_address, reason: "unsubscribed" } }
        : { id: String(s.id), updatedAt: s.created_at, data: { email: s.email_address, first_name: s.first_name, state: s.state, ...(s.fields ?? {}) } },
    );
    if (c.page < (d.total_pages ?? 1)) return { records, cursor: JSON.stringify({ ...c, page: c.page + 1 }), more: true };
    return { records, cursor: JSON.stringify({ page: 1, since: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10), max: "" }), more: false };
  },
  consent(r) {
    const s = String(r.data.state ?? "");
    return s === "active" ? "opt_in" : s === "cancelled" || s === "complained" ? "unsubscribed" : s === "bounced" ? "bounced" : null;
  },
  defaults: { contact: { email: "email", first_name: "first_name" } },
};

// MailerLite --------------------------------------------------------------------------------------------------

export const mailerlite: Connector = {
  kind: "mailerlite",
  objects: ["contacts"],
  gapMs: 600,
  async account(ctx) {
    await ctx.api("https://connect.mailerlite.com/api/subscribers?limit=1");
    return { id: `ml-${ctx.secret("api_key").slice(-6)}`, label: "MailerLite" };
  },
  async pull(ctx, _object, cursor): Promise<Page> {
    // MailerLite has no "changed since" on this list; each run reads it all and unchanged rows are skipped.
    const c = readCursor<{ next: string | null }>(cursor, { next: null });
    const d = await ctx.api<{ data: { id: string; email: string; status: string; fields: Record<string, unknown>; updated_at: string }[]; meta: { next_cursor: string | null } }>(
      `https://connect.mailerlite.com/api/subscribers?${qs({ limit: 1000, cursor: c.next })}`,
    );
    const records = (d.data ?? []).map((s) => ({ id: s.id, updatedAt: s.updated_at, data: { email: s.email, status: s.status, name: s.fields?.name ?? null, last_name: s.fields?.last_name ?? null, company: s.fields?.company ?? null, country: s.fields?.country ?? null, phone: s.fields?.phone ?? null } }));
    const next = d.meta?.next_cursor ?? null;
    return { records, cursor: next ? JSON.stringify({ next }) : null, more: !!next };
  },
  consent(r) {
    const s = String(r.data.status ?? "");
    return s === "active" ? "opt_in" : s === "unsubscribed" || s === "junk" ? "unsubscribed" : s === "bounced" ? "bounced" : null;
  },
  defaults: { contact: { email: "email", name: "first_name", last_name: "last_name", company: "company", country: "country", phone: "phone" } },
};
