// Other CRMs, coming in on a schedule (docs/contact-sources.md Part 4): Pipedrive, Attio and Close. Endpoints and
// limits are from each tool's docs and are rechecked against a real account before launch (marked "check").

import { qs, readCursor } from "./ctx.ts";
import { dealRecord, day, num, type StageKind } from "./opportunities.ts";
import type { Connector, Ctx, Page, RawRecord } from "./types.ts";

const first = <T>(xs: T[] | undefined | null) => (Array.isArray(xs) && xs.length ? xs[0] : undefined);
const primary = (xs: { value?: string; primary?: boolean }[] | undefined) => (xs?.find((x) => x.primary) ?? first(xs))?.value ?? null;

// Pipedrive ---------------------------------------------------------------------------------------------------

const pdBase = (ctx: Ctx) => (ctx.creds.type === "oauth" ? `${ctx.secret("api_domain") || "https://api.pipedrive.com"}/api/v1` : "https://api.pipedrive.com/v1");
const pdGet = <T>(ctx: Ctx, path: string, q: Record<string, string | number | null>) =>
  ctx.creds.type === "oauth"
    ? ctx.api<T>(`${pdBase(ctx)}${path}?${qs(q)}`)
    : ctx.api<T>(`${pdBase(ctx)}${path}?${qs({ ...q, api_token: ctx.secret("api_key") })}`, { auth: false });

type PdPerson = { id: number; name: string; first_name: string; last_name: string; email: { value: string; primary: boolean }[]; phone: { value: string; primary: boolean }[]; org_name: string | null; job_title?: string; marketing_status?: string; update_time: string; active_flag: boolean };
type PdOrg = { id: number; name: string; address_country?: string; update_time: string; active_flag: boolean };
type PdList<T> = { data: T[] | null; additional_data?: { pagination?: { more_items_in_collection: boolean; next_start: number } } };

const pdPerson = (p: PdPerson): RawRecord => ({
  id: String(p.id),
  updatedAt: p.update_time,
  deleted: p.active_flag === false,
  data: { name: p.name, first_name: p.first_name, last_name: p.last_name, email: primary(p.email), phone: primary(p.phone), org_name: p.org_name, job_title: p.job_title ?? null, marketing_status: p.marketing_status ?? null },
});

async function pdPull(ctx: Ctx, object: "contacts" | "companies", cursor: string | null): Promise<Page> {
  // A full read the first time (oldest change first), then only what changed since, from the recents feed.
  const c = readCursor<{ start: number; since: string | null; max: string }>(cursor, { start: 0, since: null, max: "" });
  const item = object === "contacts" ? "person" : "organization";
  const d = c.since
    ? await pdGet<PdList<{ item: string; data: PdPerson & PdOrg }>>(ctx, "/recents", { since_timestamp: c.since, items: item, start: c.start, limit: 500 })
    : await pdGet<PdList<PdPerson & PdOrg>>(ctx, object === "contacts" ? "/persons" : "/organizations", { start: c.start, limit: 500, sort: "update_time ASC" });
  const rows = ((d.data ?? []) as unknown[]).map((x) => (c.since ? (x as { data: PdPerson & PdOrg }).data : (x as PdPerson & PdOrg))).filter(Boolean);
  const records = rows.map((r) => (object === "contacts" ? pdPerson(r) : { id: String(r.id), updatedAt: r.update_time, deleted: r.active_flag === false, data: { name: r.name, address_country: r.address_country ?? null } }));
  const max = records.reduce((m, r) => ((r.updatedAt ?? "") > m ? (r.updatedAt as string) : m), c.max);
  const page = d.additional_data?.pagination;
  if (page?.more_items_in_collection) return { records, cursor: JSON.stringify({ ...c, start: page.next_start, max }), more: true };
  // Pipedrive times are UTC "YYYY-MM-DD HH:MM:SS"; read again from 5 minutes before the newest.
  const since = max ? new Date(Date.parse(`${max.replace(" ", "T")}Z`) - 300_000).toISOString().slice(0, 19).replace("T", " ") : c.since;
  return { records, cursor: JSON.stringify({ start: 0, since, max: "" }), more: false };
}

// Deals: the same full read then recents feed, stage names from /stages (check).
type PdDeal = {
  id: number;
  title: string;
  value: number | null;
  status: "open" | "won" | "lost" | "deleted";
  stage_id: number;
  pipeline_id: number;
  expected_close_date: string | null;
  probability: number | null;
  owner_name?: string;
  org_id: number | { value: number } | null;
  person_id: number | { value: number } | null;
  update_time: string;
  active?: boolean;
};
const pdRef = (v: number | { value: number } | null) => (v == null ? null : String(typeof v === "object" ? v.value : v));

async function pdDeals(ctx: Ctx, cursor: string | null): Promise<Page> {
  const c = readCursor<{ start: number; since: string | null; max: string }>(cursor, { start: 0, since: null, max: "" });
  const d = c.since
    ? await pdGet<PdList<{ item: string; data: PdDeal }>>(ctx, "/recents", { since_timestamp: c.since, items: "deal", start: c.start, limit: 500 })
    : await pdGet<PdList<PdDeal>>(ctx, "/deals", { start: c.start, limit: 500, sort: "update_time ASC", status: "all_not_deleted" });
  const rows = ((d.data ?? []) as unknown[]).map((x) => (c.since ? (x as { data: PdDeal }).data : (x as PdDeal))).filter(Boolean);
  const stages = new Map<number, { name: string; pipeline: string }>();
  if (rows.length) {
    const [st, pl] = await Promise.all([
      pdGet<{ data: { id: number; name: string; pipeline_id: number }[] | null }>(ctx, "/stages", {}),
      pdGet<{ data: { id: number; name: string }[] | null }>(ctx, "/pipelines", {}),
    ]);
    const pipes = new Map((pl.data ?? []).map((p) => [p.id, p.name]));
    for (const x of st.data ?? []) stages.set(x.id, { name: x.name, pipeline: pipes.get(x.pipeline_id) ?? "" });
  }
  const domain = ctx.creds.type === "oauth" ? ctx.secret("api_domain") : "";
  const records = rows.map((r) => {
    const st = stages.get(r.stage_id);
    const person = pdRef(r.person_id);
    return dealRecord(String(r.id), r.update_time, r.status === "deleted" || r.active === false, {
      name: r.title ?? null,
      amount: num(r.value),
      stage: st?.name ?? null,
      stageKind: r.status === "won" || r.status === "lost" ? r.status : "open",
      closeDate: day(r.expected_close_date),
      probability: num(r.probability),
      owner: r.owner_name ?? null,
      pipeline: st?.pipeline || null,
      nextStep: null,
      url: /^https:\/\//.test(domain) ? `${domain}/deal/${r.id}` : null,
      company: pdRef(r.org_id),
      contacts: person ? [person] : [],
    });
  });
  const max = records.reduce((m, r) => ((r.updatedAt ?? "") > m ? (r.updatedAt as string) : m), c.max);
  const page = d.additional_data?.pagination;
  if (page?.more_items_in_collection) return { records, cursor: JSON.stringify({ ...c, start: page.next_start, max }), more: true };
  const since = max ? new Date(Date.parse(`${max.replace(" ", "T")}Z`) - 300_000).toISOString().slice(0, 19).replace("T", " ") : c.since;
  return { records, cursor: JSON.stringify({ start: 0, since, max: "" }), more: false };
}

export const pipedrive: Connector = {
  kind: "pipedrive",
  objects: ["companies", "contacts", "opportunities"],
  gapMs: 250,
  async account(ctx) {
    const d = await pdGet<{ data: { company_id: number; company_name: string; company_domain: string } }>(ctx, "/users/me", {});
    return { id: String(d.data.company_id), label: d.data.company_name || d.data.company_domain };
  },
  pull: (ctx, object, cursor) => (object === "opportunities" ? pdDeals(ctx, cursor) : pdPull(ctx, object === "companies" ? "companies" : "contacts", cursor)),
  consent(r) {
    const s = String(r.data.marketing_status ?? "");
    return s === "subscribed" ? "opt_in" : s === "unsubscribed" ? "unsubscribed" : s === "no_consent" ? "none" : null;
  },
  defaults: {
    contact: { email: "email", first_name: "first_name", last_name: "last_name", job_title: "title", phone: "phone", org_name: "company" },
    company: { name: "name", address_country: "country" },
  },
};

// Attio -------------------------------------------------------------------------------------------------------

type AttioRecord = { id: { record_id: string }; created_at: string; values: Record<string, Record<string, unknown>[]> };
const av = (r: AttioRecord, key: string, field: string) => {
  const v = first(r.values?.[key]);
  return v ? ((v[field] as string | undefined) ?? null) : null;
};

async function attioQuery(ctx: Ctx, object: "people" | "companies", cursor: string | null): Promise<Page> {
  // Attio has no "changed since" on query; each run reads it all, oldest first, and unchanged rows are skipped.
  const c = readCursor<{ offset: number }>(cursor, { offset: 0 });
  const d = await ctx.api<{ data: AttioRecord[] }>(`https://api.attio.com/v2/objects/${object}/records/query`, {
    method: "POST",
    body: JSON.stringify({ limit: 500, offset: c.offset, sorts: [{ attribute: "created_at", direction: "asc" }] }),
  });
  const records = (d.data ?? []).map((r) =>
    object === "people"
      ? {
          id: r.id.record_id,
          data: {
            email: av(r, "email_addresses", "email_address"),
            first_name: av(r, "name", "first_name"),
            last_name: av(r, "name", "last_name"),
            job_title: av(r, "job_title", "value"),
            phone: av(r, "phone_numbers", "original_phone_number"),
            country: av(r, "primary_location", "country_code"),
          },
        }
      : { id: r.id.record_id, data: { name: av(r, "name", "value"), domain: av(r, "domains", "domain") } },
  );
  const more = records.length === 500;
  return { records, cursor: more ? JSON.stringify({ offset: c.offset + 500 }) : null, more };
}

// Deals: Attio's standard deals object (check). Stages are statuses; won and lost are read from their titles.
const attioKind = (title: string | null): StageKind => (!title ? "open" : /\bwon\b/i.test(title) ? "won" : /\blost\b/i.test(title) ? "lost" : "open");
const refs = (r: AttioRecord, key: string) => (r.values?.[key] ?? []).map((v) => v.target_record_id as string | undefined).filter((x): x is string => !!x);

async function attioDeals(ctx: Ctx, cursor: string | null): Promise<Page> {
  const c = readCursor<{ offset: number }>(cursor, { offset: 0 });
  const d = await ctx.api<{ data: AttioRecord[] }>("https://api.attio.com/v2/objects/deals/records/query", {
    method: "POST",
    body: JSON.stringify({ limit: 500, offset: c.offset, sorts: [{ attribute: "created_at", direction: "asc" }] }),
  });
  const records = (d.data ?? []).map((r) => {
    const status = first(r.values?.stage) as { status?: { title?: string } } | undefined;
    const title = status?.status?.title ?? null;
    return dealRecord(r.id.record_id, null, false, {
      name: av(r, "name", "value"),
      amount: num(av(r, "value", "currency_value")),
      stage: title,
      stageKind: attioKind(title),
      closeDate: null,
      probability: null,
      owner: null,
      pipeline: null,
      nextStep: null,
      url: null,
      company: refs(r, "associated_company")[0] ?? null,
      contacts: refs(r, "associated_people"),
    });
  });
  const more = records.length === 500;
  return { records, cursor: more ? JSON.stringify({ offset: c.offset + 500 }) : null, more };
}

export const attio: Connector = {
  kind: "attio",
  objects: ["companies", "contacts", "opportunities"],
  gapMs: 250,
  async account(ctx) {
    const d = await ctx.api<{ workspace_id: string; workspace_name: string }>("https://api.attio.com/v2/self");
    return { id: d.workspace_id, label: d.workspace_name };
  },
  pull: (ctx, object, cursor) => (object === "opportunities" ? attioDeals(ctx, cursor) : attioQuery(ctx, object === "companies" ? "companies" : "people", cursor)),
  defaults: {
    contact: { email: "email", first_name: "first_name", last_name: "last_name", job_title: "title", phone: "phone", country: "country" },
    company: { name: "name", domain: "domain" },
  },
};

// Close -------------------------------------------------------------------------------------------------------

type CloseContact = { id: string; name: string; title: string; emails: { email: string }[]; phones: { phone: string }[]; lead_id: string; date_updated: string };
const closeAuth = (ctx: Ctx) => ({ authorization: `Basic ${Buffer.from(`${ctx.secret("api_key")}:`).toString("base64")}` });

export const close: Connector = {
  kind: "close",
  objects: ["contacts"],
  gapMs: 300,
  async account(ctx) {
    const d = await ctx.api<{ organizations: { id: string; name: string }[] }>("https://api.close.com/api/v1/me/", { headers: closeAuth(ctx), auth: false });
    const o = first(d.organizations);
    return { id: o?.id ?? "", label: o?.name ?? "Close" };
  },
  async pull(ctx, _object, cursor) {
    const c = readCursor<{ skip: number; since: string | null; max: string }>(cursor, { skip: 0, since: null, max: "" });
    const d = await ctx.api<{ data: CloseContact[]; has_more: boolean }>(
      `https://api.close.com/api/v1/contact/?${qs({ _skip: c.skip, _limit: 100, _order_by: "date_updated", date_updated__gt: c.since })}`,
      { headers: closeAuth(ctx), auth: false },
    );
    const records = (d.data ?? []).map((x) => ({ id: x.id, updatedAt: x.date_updated, data: { name: x.name, title: x.title, email: first(x.emails)?.email ?? null, phone: first(x.phones)?.phone ?? null } }));
    const max = records.reduce((m, r) => (r.updatedAt > m ? r.updatedAt : m), c.max);
    if (d.has_more) return { records, cursor: JSON.stringify({ ...c, skip: c.skip + 100, max }), more: true };
    const since = max ? new Date(Date.parse(max) - 300_000).toISOString() : c.since;
    return { records, cursor: JSON.stringify({ skip: 0, since, max: "" }), more: false };
  },
  defaults: { contact: { email: "email", name: "name", title: "title", phone: "phone" } },
};
