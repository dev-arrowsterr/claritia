// HubSpot, two-way (docs/contact-sources.md Part 4). Backfill and changes through contact search on
// lastmodifieddate (oldest first, 5 minutes of overlap, the window moved on before HubSpot's 10,000-result cap),
// changes within seconds through the app's webhooks, writes through batch create and update. Scopes are in oauth.ts.

import { createHmac, timingSafeEqual } from "node:crypto";
import { activityHtml, activityText } from "./activity.ts";
import { readCursor } from "./ctx.ts";
import type { ActivityItem, ActivityResult, Connector, Ctx, HookEvent, HookRequest, Page, PushChange, PushResult, RawRecord } from "./types.ts";

const BASE = "https://api.hubapi.com";
const OVERLAP_MS = 5 * 60_000;
const CAP = 9_900;

export const HUBSPOT_CONTACT_PROPS = [
  "email", "firstname", "lastname", "jobtitle", "phone", "mobilephone", "company", "website", "country", "state", "lifecyclestage", "hs_lead_status",
  "hs_email_optout", "hs_email_hard_bounce_reason_enum", "hs_legal_basis", "lastmodifieddate", "createdate", "hubspot_owner_id",
];
const COMPANY_PROPS = ["name", "domain", "industry", "numberofemployees", "country", "hs_lastmodifieddate"];

type Obj = { id: string; properties: Record<string, string | null>; updatedAt?: string; archived?: boolean };
type SearchOut = { total?: number; results: Obj[]; paging?: { next?: { after?: string } } };
type Cur = { since: number; after: string | null; max: number };

const rec = (o: Obj): RawRecord => ({ id: String(o.id), updatedAt: o.updatedAt ?? o.properties.lastmodifieddate ?? null, deleted: !!o.archived, data: { ...o.properties } });

async function search(ctx: Ctx, object: "contacts" | "companies", cursor: string | null): Promise<Page> {
  const c = readCursor<Cur>(cursor, { since: 0, after: null, max: 0 });
  const prop = object === "contacts" ? "lastmodifieddate" : "hs_lastmodifieddate";
  const body = {
    filterGroups: c.since ? [{ filters: [{ propertyName: prop, operator: "GTE", value: String(c.since) }] }] : [],
    sorts: [{ propertyName: prop, direction: "ASCENDING" }],
    properties: object === "contacts" ? HUBSPOT_CONTACT_PROPS : COMPANY_PROPS,
    limit: 100,
    ...(c.after ? { after: c.after } : {}),
  };
  const d = await ctx.api<SearchOut>(`${BASE}/crm/v3/objects/${object}/search`, { method: "POST", body: JSON.stringify(body) });
  const records = (d.results ?? []).map(rec);
  let max = c.max;
  for (const r of records) max = Math.max(max, Date.parse(r.updatedAt ?? "") || 0);
  const after = d.paging?.next?.after ?? null;
  if (after && Number(after) < CAP) return { records, cursor: JSON.stringify({ since: c.since, after, max }), more: true };
  // Out of pages, or near the cap: start a new window from the newest change seen, a little before it.
  const since = Math.max(c.since, max - OVERLAP_MS);
  return { records, cursor: JSON.stringify({ since, after: null, max }), more: !!after };
}

export const hubspot: Connector = {
  kind: "hubspot",
  objects: ["companies", "contacts", "lists"],
  twoWay: true,
  // 110 calls per 10 seconds per account; search 5 a second. Half of that.
  gapMs: 400,
  async account(ctx) {
    const d = await ctx.api<{ portalId?: number; uiDomain?: string }>(`${BASE}/account-info/v3/details`);
    return { id: String(d.portalId ?? ""), label: d.uiDomain ? `${d.uiDomain} · ${d.portalId}` : `Portal ${d.portalId}` };
  },
  pull: (ctx, object, cursor) => search(ctx, object === "companies" ? "companies" : "contacts", cursor),
  async lists(ctx, cursor) {
    // Static lists come over as static segments; active lists are rebuilt as segments by the migration agent.
    const c = readCursor<{ offset: number }>(cursor, { offset: 0 });
    const d = await ctx.api<{ lists: { listId: string; name: string; processingType: string; objectTypeId: string }[]; hasMore: boolean; offset: number }>(
      `${BASE}/crm/v3/lists/search`,
      { method: "POST", body: JSON.stringify({ offset: c.offset, count: 50, processingTypes: ["MANUAL", "SNAPSHOT"] }) },
    );
    const lists = [];
    for (const l of (d.lists ?? []).filter((x) => x.objectTypeId === "0-1")) {
      const ids: string[] = [];
      let after: string | undefined;
      do {
        const m = await ctx.api<{ results: { recordId: string }[]; paging?: { next?: { after?: string } } }>(
          `${BASE}/crm/v3/lists/${l.listId}/memberships?limit=250${after ? `&after=${after}` : ""}`,
        );
        ids.push(...(m.results ?? []).map((r) => String(r.recordId)));
        after = m.paging?.next?.after;
      } while (after && ids.length < 100_000);
      lists.push({ id: String(l.listId), name: l.name, contactIds: ids, replace: true });
    }
    return { lists, cursor: d.hasMore ? JSON.stringify({ offset: d.offset }) : null, more: !!d.hasMore };
  },
  async fetch(ctx, object, ids) {
    const d = await ctx.api<{ results: Obj[] }>(`${BASE}/crm/v3/objects/${object}/batch/read`, {
      method: "POST",
      body: JSON.stringify({ properties: object === "contacts" ? HUBSPOT_CONTACT_PROPS : COMPANY_PROPS, inputs: ids.map((id) => ({ id })) }),
    });
    const found = new Map((d.results ?? []).map((o) => [String(o.id), rec(o)]));
    // A record that's gone (deleted or merged away) reads as deleted.
    return ids.map((id) => found.get(id) ?? { id, deleted: true, data: {} });
  },
  verify(req: HookRequest, secret: string) {
    // v3: base64 HMAC-SHA256 of method + url + body + timestamp, with the app's client secret; 5 minutes' grace.
    const sig = req.headers.get("x-hubspot-signature-v3");
    const ts = Number(req.headers.get("x-hubspot-request-timestamp"));
    if (!sig || !secret || !Number.isFinite(ts) || Math.abs(Date.now() - ts) > 300_000) return false;
    const want = Buffer.from(createHmac("sha256", secret).update(`${req.method}${req.url}${req.body}${ts}`).digest("base64"));
    const got = Buffer.from(sig);
    return want.length === got.length && timingSafeEqual(want, got);
  },
  hookAccount: (body) => (Array.isArray(body) && body[0] && typeof body[0] === "object" ? String((body[0] as { portalId?: number }).portalId ?? "") || null : null),
  parse(body) {
    const out: (HookEvent & { account?: string })[] = [];
    for (const e of Array.isArray(body) ? (body as Record<string, unknown>[]) : []) {
      const type = String(e.subscriptionType ?? "");
      const object = type.startsWith("company.") ? "companies" : type.startsWith("contact.") ? "contacts" : null;
      if (!object) continue;
      const base = { dedupe: `${e.eventId ?? ""}:${e.objectId}:${e.occurredAt ?? ""}`, object, account: String(e.portalId ?? "") } as const;
      if (type.endsWith(".deletion") || type.endsWith(".privacyDeletion")) out.push({ ...base, id: String(e.objectId), deleted: true });
      else if (type.endsWith(".merge")) {
        // The merged-away records are gone; the one that stays is read fresh.
        for (const id of (e.mergedObjectIds as number[] | undefined) ?? []) if (String(id) !== String(e.primaryObjectId)) out.push({ ...base, dedupe: `${base.dedupe}:${id}`, id: String(id), deleted: true });
        out.push({ ...base, id: String(e.primaryObjectId ?? e.objectId) });
      } else out.push({ ...base, id: String(e.objectId) });
    }
    return out;
  },
  async push(ctx, changes) {
    const out: PushResult[] = [];
    for (let i = 0; i < changes.length; i += 100) {
      const part = changes.slice(i, i + 100);
      const update = part.filter((c) => c.externalId);
      const create = part.filter((c) => !c.externalId);
      if (update.length) out.push(...(await batch(ctx, "update", update)));
      if (create.length) out.push(...(await batch(ctx, "upsert", create)));
    }
    return out;
  },
  async owners(ctx) {
    const out: { id: string; label: string }[] = [];
    let after: string | undefined;
    do {
      const d = await ctx.api<{ results: { id: string; email?: string; firstName?: string; lastName?: string; archived?: boolean }[]; paging?: { next?: { after?: string } } }>(
        `${BASE}/crm/v3/owners?limit=500${after ? `&after=${after}` : ""}`,
      );
      for (const o of d.results ?? []) if (!o.archived) out.push({ id: String(o.id), label: [o.firstName, o.lastName].filter(Boolean).join(" ") || o.email || String(o.id) });
      after = d.paging?.next?.after;
    } while (after && out.length < 5000);
    return out;
  },
  activity: (ctx, items) => (process.env.HUBSPOT_TIMELINE_TEMPLATE?.trim() ? timeline(ctx, items, process.env.HUBSPOT_TIMELINE_TEMPLATE.trim()) : notes(ctx, items)),
  async setup(ctx) {
    // Our own properties on HubSpot contacts, so reps see the score where they work.
    const props = [
      { name: "claritia_score", label: "Claritia score", type: "number", fieldType: "number" },
      { name: "claritia_band", label: "Claritia band", type: "string", fieldType: "text" },
      { name: "claritia_source", label: "Claritia source", type: "string", fieldType: "text" },
    ];
    for (const p of props) {
      try {
        await ctx.api(`${BASE}/crm/v3/properties/contacts`, { method: "POST", body: JSON.stringify({ ...p, groupName: "contactinformation" }) });
      } catch (e) {
        if (!/already exists|PROPERTY_EXISTS|409/i.test(String((e as Error).message))) throw e;
      }
    }
  },
  consent(r) {
    const d = r.data;
    if (String(d.hs_email_hard_bounce_reason_enum ?? "")) return "bounced";
    if (String(d.hs_email_optout ?? "") === "true") return "unsubscribed";
    const basis = String(d.hs_legal_basis ?? "").toLowerCase();
    if (basis.includes("freely given consent")) return "opt_in";
    if (basis.includes("legitimate interest")) return "legitimate_interest";
    if (basis.includes("performance of a contract")) return "soft_opt_in";
    return null;
  },
  defaults: {
    contact: { email: "email", firstname: "first_name", lastname: "last_name", jobtitle: "title", phone: "phone", company: "company", website: "website", country: "country", state: "region", lifecyclestage: "lifecycle", hs_lead_status: "lead_status", claritia_score: "score", claritia_band: "score_band", hubspot_owner_id: "owner_crm" },
    company: { name: "name", domain: "domain", industry: "industry", numberofemployees: "size", country: "country" },
    valueMaps: {
      lifecyclestage: { subscriber: "subscriber", lead: "lead", marketingqualifiedlead: "mql", salesqualifiedlead: "sql", opportunity: "opportunity", customer: "customer", evangelist: "evangelist", other: "other" },
      hs_lead_status: { NEW: "new", ATTEMPTED_TO_CONTACT: "attempting", CONNECTED: "connected", OPEN_DEAL: "qualified", UNQUALIFIED: "disqualified", IN_PROGRESS: "connected", OPEN: "new", BAD_TIMING: "disqualified" },
    },
  },
};

async function batch(ctx: Ctx, mode: "update" | "upsert", part: PushChange[]): Promise<PushResult[]> {
  const inputs =
    mode === "update"
      ? part.map((c) => ({ id: c.externalId, properties: c.values }))
      : part.map((c) => ({ id: String(c.values.email ?? ""), idProperty: "email", properties: c.values }));
  try {
    const d = await ctx.api<{ results: Obj[]; errors?: { message: string; context?: { ids?: string[] } }[] }>(`${BASE}/crm/v3/objects/contacts/batch/${mode}`, {
      method: "POST",
      body: JSON.stringify({ inputs }),
    });
    const byEmail = new Map((d.results ?? []).map((o) => [String(o.properties.email ?? "").toLowerCase(), String(o.id)]));
    const byId = new Set((d.results ?? []).map((o) => String(o.id)));
    return part.map((c) => {
      const ext = mode === "update" ? (byId.has(String(c.externalId)) ? String(c.externalId) : undefined) : byEmail.get(String(c.values.email ?? "").toLowerCase());
      if (ext) return { localId: c.localId, externalId: ext };
      const err = d.errors?.find((e) => e.context?.ids?.includes(String(c.externalId)) || e.message.includes(String(c.externalId))) ?? d.errors?.[0];
      if (mode === "update" && /not found|does not exist/i.test(err?.message ?? "")) return { localId: c.localId, gone: true };
      return { localId: c.localId, error: err?.message ?? "HubSpot didn't take this contact." };
    });
  } catch (e) {
    // One bad value fails the whole batch; send them one by one to find it.
    if (part.length === 1 || /rate limit|Stopped|Sign in again/i.test(String((e as Error).message))) {
      if (part.length === 1 && !/rate limit|Stopped|Sign in again/i.test(String((e as Error).message))) return [{ localId: part[0].localId, error: String((e as Error).message).slice(0, 300) }];
      throw e;
    }
    const out: PushResult[] = [];
    for (const c of part) out.push(...(await batch(ctx, mode, [c])));
    return out;
  }
}

// Activity: timeline events when Claritia's event template is set up (HUBSPOT_TIMELINE_TEMPLATE, made once by
// scripts/hubspot-timeline.mjs), else a note on the contact. A timeline event carries our event id, so HubSpot
// refuses a second copy.
async function timeline(ctx: Ctx, items: ActivityItem[], template: string): Promise<ActivityResult[]> {
  const out: ActivityResult[] = [];
  for (let i = 0; i < items.length; i += 100) {
    const part = items.slice(i, i + 100);
    const inputs = part.map((x) => {
      const t = activityText(x);
      return { eventTemplateId: template, objectId: x.external_id, id: x.id, timestamp: x.at, tokens: { action: t.action, title: t.title.slice(0, 250), detail: t.detail.slice(0, 1000) } };
    });
    try {
      const d = await ctx.api<{ results?: { id: string }[]; errors?: { message: string; context?: { id?: string[] } }[] }>(`${BASE}/crm/v3/timeline/events/batch/create`, { method: "POST", body: JSON.stringify({ inputs }) });
      const ok = new Set((d.results ?? []).map((r) => String(r.id)));
      for (const x of part) {
        if (ok.has(x.id)) {
          out.push({ id: x.id, status: "sent", external_id: x.id });
          continue;
        }
        const err = d.errors?.find((e) => e.context?.id?.includes(x.id) || e.message.includes(x.id));
        // Already there from an earlier try: that's the one copy.
        if (err && /already exists|duplicate|conflict/i.test(err.message)) out.push({ id: x.id, status: "sent", external_id: x.id });
        else out.push({ id: x.id, status: err ? "failed" : "unknown", error: err?.message ?? "HubSpot didn't answer for this event." });
      }
    } catch (e) {
      if (/rate limit|Stopped|Sign in again/i.test(String((e as Error).message))) throw e;
      for (const x of part) out.push({ id: x.id, status: "failed", error: String((e as Error).message).slice(0, 300) });
    }
  }
  return out;
}

async function notes(ctx: Ctx, items: ActivityItem[]): Promise<ActivityResult[]> {
  const out: ActivityResult[] = [];
  for (const x of items) {
    try {
      const d = await ctx.api<{ id: string }>(`${BASE}/crm/v3/objects/notes`, {
        method: "POST",
        body: JSON.stringify({
          properties: { hs_timestamp: x.at, hs_note_body: activityHtml(x) },
          associations: [{ to: { id: x.external_id }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 202 }] }],
        }),
      });
      out.push({ id: x.id, status: "sent", external_id: String(d.id) });
    } catch (e) {
      const msg = String((e as Error).message);
      if (/rate limit|Stopped|Sign in again/i.test(msg)) {
        // What was written stays written; this one and the rest are left as unknown by the caller.
        out.push({ id: x.id, status: "unknown", error: msg.slice(0, 300) });
        for (const y of items.slice(items.indexOf(x) + 1)) out.push({ id: y.id, status: "unknown", error: "Stopped before this event." });
        return out;
      }
      out.push({ id: x.id, status: "failed", error: msg.slice(0, 300) });
    }
  }
  return out;
}
