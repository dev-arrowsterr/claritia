// The pipeline every source runs through (docs/contact-sources.md Parts 1 and 2), the same for a scheduled pull,
// a webhook and a push. In: map, clean, block suppressed addresses first, skip what didn't change, upsert by
// field order, link by the tool's id, log each change. Out: contacts that changed here since the push cursor,
// minus those whose values the tool already has, in batches, each result logged.
//
// No echo loops: a link remembers the values both sides last agreed on. A change coming back with those values
// is skipped, and a contact whose values match what the tool has is never pushed.

import { countryCode } from "../contacts/fields.ts";
import { prepareImport, type Ctx as CleanCtx, type ContactInput } from "../contacts/import.ts";
import { writeContacts } from "../contacts/contacts.ts";
import type { Rpc } from "../jobs.ts";
import { agreed, changedKeys, compared, effectiveMapping, pushable, recordsToCompanies, recordsToRows, toRemote, type Col, type SavedMapping } from "./map.ts";
import type { Connector, Ctx, HookEvent, ObjectKind, PushChange, RawRecord } from "./types.ts";

export type Deps = { rpc: Rpc; connector: Connector; ctx: Ctx; clean: CleanCtx; saved: SavedMapping[]; now?: () => number };
export type Counts = { pulled: number; written: number; skipped: number; errors: number };
type Link = { local_id: string; values: Record<string, unknown> | null; deleted: boolean; email_clean: string | null };
type LogRow = { direction: "in" | "out"; object: string; local_id?: string | null; external_id?: string | null; action: string; fields?: string[]; error?: string };

export async function call<T>(rpc: Rpc, fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data as T;
}

const zero = (): Counts => ({ pulled: 0, written: 0, skipped: 0, errors: 0 });
const enabled = (d: Deps, o: ObjectKind) => (d.ctx.source.settings.objects?.[o] ?? (o === "companies" ? "off" : "in")) !== "off";

async function log(d: Deps, rows: LogRow[]) {
  for (let i = 0; i < rows.length; i += 1000) await call(d.rpc, "sync_log_add", { p_source: d.ctx.source.id, p_rows: rows.slice(i, i + 1000) });
}

async function seen(d: Deps, object: "contact" | "company", records: RawRecord[]) {
  const cols: Record<string, string> = {};
  for (const r of records.slice(0, 50))
    for (const [k, v] of Object.entries(r.data)) if (!(k in cols) && v != null && typeof v !== "object") cols[k] = String(v).slice(0, 80);
  if (Object.keys(cols).length) await call(d.rpc, "source_columns_save", { p_id: d.ctx.source.id, p_object: object, p_cols: cols });
  return Object.keys(cols);
}

// In ----------------------------------------------------------------------------------------------------------

/** A column the record doesn't carry at all (a Salesforce Contact has no lead status) keeps the value last agreed. */
function withMissing(cols: Col[], values: Record<string, unknown>, r: RawRecord | undefined, last: Record<string, unknown> | null | undefined) {
  if (!r || !last) return values;
  const out = { ...values };
  for (const m of cols) {
    if (m.col in r.data) continue;
    for (const t of m.target === "name" ? ["first_name", "last_name"] : [m.target]) if (last[t] !== undefined && out[t] === undefined) out[t] = last[t];
  }
  return out;
}

export async function applyContacts(d: Deps, records: RawRecord[]): Promise<Counts> {
  const c = zero();
  const src = d.ctx.source;
  c.pulled = records.length;
  const gone = records.filter((r) => r.deleted).map((r) => r.id);
  if (gone.length) {
    await call(d.rpc, "source_links_delete", { p_source: src.id, p_object: "contact", p_external: gone });
    await log(d, gone.map((id) => ({ direction: "in", object: "contact", external_id: id, action: "delete" })));
  }
  const live = records.filter((r) => !r.deleted);
  if (!live.length) return c;

  const cols = effectiveMapping(d.connector, "contact", d.saved, await seen(d, "contact", live), d.clean.custom);
  if (!cols.some((m) => m.target === "email")) throw new Error("Map a column to Email for this source.");
  const { targets, rows } = recordsToRows(live, cols, d.connector.consent);
  const p = prepareImport(rows, { columns: targets, source: "crm_export", basis: src.settings.basis ?? null, list: "contacts" }, d.clean);
  c.skipped += rows.length - p.contacts.length;

  // Unsubscribes and bounces first, so a contact never lands sendable.
  if (p.suppress.length) {
    await call(d.rpc, "suppress", { p_ws: src.workspace_id, p_source: src.kind, p_rows: p.suppress });
    await log(d, p.suppress.map((s) => ({ direction: "in", object: "contact", external_id: p.contacts.find((x) => x.email_clean === s.email_clean)?.source_id, action: "suppress", fields: [s.reason] })));
  }

  const links = await call<Record<string, Link>>(d.rpc, "source_links_get", { p_source: src.id, p_object: "contact", p_external: p.contacts.map((x) => x.source_id) });
  const write: ContactInput[] = [];
  const meta: { x: ContactInput; values: Record<string, unknown>; before: Link | undefined }[] = [];
  const raw = new Map(live.map((r) => [r.id, r]));
  for (const x of p.contacts) {
    const link = links[x.source_id ?? ""];
    const held = link && !link.deleted ? link : undefined;
    const values = withMissing(cols, agreed(cols, x), raw.get(x.source_id ?? ""), held?.values);
    if (held && held.email_clean === x.email_clean && changedKeys(held.values, values).length === 0) {
      c.skipped++;
      continue;
    }
    // The email changed on their side: move it on ours, so the same person stays one contact.
    if (held?.email_clean && held.email_clean !== x.email_clean) {
      const { error } = await d.rpc("contact_update", { p_id: held.local_id, p_source: src.kind, p_values: { email: x.email, email_clean: x.email_clean, email_class: x.email_class } });
      if (error && !/Another contact has this email/.test(error.message)) throw new Error(error.message);
    }
    write.push(x);
    meta.push({ x, values, before: held });
  }
  if (!write.length) return c;
  await writeContacts(d.rpc, src.workspace_id, src.kind, write);
  const ids = await call<Record<string, string>>(d.rpc, "contact_ids_by_email", { p_ws: src.workspace_id, p_emails: write.map((x) => x.email_clean) });
  const put = meta.filter((m) => ids[m.x.email_clean]).map((m) => ({ external_id: m.x.source_id, local_id: ids[m.x.email_clean], values: m.values }));
  await call(d.rpc, "source_links_put", { p_source: src.id, p_object: "contact", p_rows: put });
  await log(
    d,
    meta.map((m) => ({ direction: "in", object: "contact", local_id: ids[m.x.email_clean] ?? null, external_id: m.x.source_id, action: m.before ? "update" : "create", fields: changedKeys(m.before?.values, m.values) })),
  );
  c.written += write.length;

  // A value that lost to one set here (a person's edit beats the CRM by default) goes back out, so both sides end
  // equal; the contact itself didn't change, so the push cursor would never bring it up.
  if (d.connector.push && (src.settings.objects?.contacts ?? "in") === "both") {
    const linked = put.map((x) => x.local_id);
    if (linked.length) await push(d, { ids: linked });
  }

  // Lists that came with their members.
  const lists = new Map<string, { name: string; emails: string[] }>();
  const byId = new Map(live.map((r) => [r.id, r]));
  for (const x of p.contacts)
    for (const l of byId.get(x.source_id ?? "")?.lists ?? []) {
      const e = lists.get(l.id) ?? { name: l.name, emails: [] };
      e.emails.push(x.email_clean);
      lists.set(l.id, e);
    }
  for (const [id, l] of lists) await call(d.rpc, "source_list_sync", { p_source: src.id, p_external: id, p_name: l.name, p_emails: l.emails, p_replace: false });
  return c;
}

export async function applyCompanies(d: Deps, records: RawRecord[]): Promise<Counts> {
  const c = zero();
  const src = d.ctx.source;
  c.pulled = records.length;
  const gone = records.filter((r) => r.deleted).map((r) => r.id);
  if (gone.length) await call(d.rpc, "source_links_delete", { p_source: src.id, p_object: "company", p_external: gone });
  const live = records.filter((r) => !r.deleted);
  if (!live.length) return c;
  const cols = effectiveMapping(d.connector, "company", d.saved, await seen(d, "company", live), d.clean.custom);
  const rows = recordsToCompanies(live, cols, [], countryCode);
  const links = await call<Record<string, Link>>(d.rpc, "source_links_get", { p_source: src.id, p_object: "company", p_external: rows.map((r) => r.source_id) });
  const changed = rows.filter((r) => {
    const v = { ...r, source_id: undefined };
    const l = links[r.source_id];
    return !l || l.deleted || changedKeys(l.values, JSON.parse(JSON.stringify(v))).length > 0;
  });
  c.skipped += rows.length - changed.length;
  if (!changed.length) return c;
  const out = await call<{ ids: (string | null)[] }>(d.rpc, "companies_upsert", { p_ws: src.workspace_id, p_source: src.kind, p_rows: changed });
  const put = changed.map((r, i) => ({ external_id: r.source_id, local_id: out.ids[i], values: JSON.parse(JSON.stringify({ ...r, source_id: undefined })) })).filter((r) => r.local_id);
  await call(d.rpc, "source_links_put", { p_source: src.id, p_object: "company", p_rows: put });
  await log(d, put.map((r) => ({ direction: "in", object: "company", local_id: r.local_id, external_id: r.external_id, action: links[r.external_id] ? "update" : "create", fields: changedKeys(links[r.external_id]?.values, r.values) })));
  c.written += put.length;
  return c;
}

export async function applySuppressions(d: Deps, records: RawRecord[]): Promise<Counts> {
  const c = zero();
  c.pulled = records.length;
  const rows = records
    .map((r) => ({ email_clean: String(r.data.email ?? "").trim().toLowerCase(), reason: String(r.data.reason ?? "unsubscribed") }))
    .filter((r) => r.email_clean.includes("@"));
  // Cleaned the same way contacts are, so "Jane.Doe@Gmail.com" blocks janedoe@gmail.com.
  const p = prepareImport(
    rows.map((r) => [r.email_clean, r.reason]),
    { columns: ["email", "skip"], source: "crm_export", basis: null, list: "unsubscribed" },
    d.clean,
  );
  const reasons = new Map(rows.map((r) => [r.email_clean, r.reason]));
  const out = p.contacts.map((x) => ({ email_clean: x.email_clean, reason: ["bounced", "complained", "cleaned"].includes(reasons.get(x.email.toLowerCase()) ?? "") ? reasons.get(x.email.toLowerCase()) : "unsubscribed" }));
  if (out.length) await call(d.rpc, "suppress", { p_ws: d.ctx.source.workspace_id, p_source: d.ctx.source.kind, p_rows: out });
  c.written = out.length;
  return c;
}

async function applyLists(d: Deps, cursor: string | null) {
  const page = await d.connector.lists!(d.ctx, cursor);
  for (const l of page.lists) {
    let emails = l.emails ?? [];
    if (l.contactIds?.length) {
      const links = await call<Record<string, Link>>(d.rpc, "source_links_get", { p_source: d.ctx.source.id, p_object: "contact", p_external: l.contactIds });
      emails = [...emails, ...Object.values(links).flatMap((x) => (x.email_clean && !x.deleted ? [x.email_clean] : []))];
    }
    await call(d.rpc, "source_list_sync", { p_source: d.ctx.source.id, p_external: l.id, p_name: l.name, p_emails: emails.map((e) => e.toLowerCase()), p_replace: l.replace });
  }
  return page;
}

/** Pull every object that's on, page by page, saving the cursor after each. Stops when caught up or out of time. */
export async function pull(d: Deps, budgetMs = 240_000): Promise<{ more: boolean; counts: Record<string, Counts> }> {
  const start = (d.now ?? Date.now)();
  const counts: Record<string, Counts> = {};
  const order: ObjectKind[] = ["suppressions", "companies", "contacts", "lists"];
  for (const object of order) {
    if (!d.connector.objects.includes(object) || !enabled(d, object)) continue;
    const total = (counts[object] = zero());
    for (;;) {
      if (d.ctx.signal?.aborted) throw new Error("Stopped");
      const cursor = d.ctx.source.cursors[object] ?? null;
      let next: string | null;
      let more: boolean;
      if (object === "lists") {
        const page = await applyLists(d, cursor);
        next = page.cursor;
        more = page.more;
        total.pulled += page.lists.length;
      } else {
        const page = await d.connector.pull!(d.ctx, object, cursor);
        const got = object === "contacts" ? await applyContacts(d, page.records) : object === "companies" ? await applyCompanies(d, page.records) : await applySuppressions(d, page.records);
        for (const k of ["pulled", "written", "skipped", "errors"] as const) total[k] += got[k];
        next = page.cursor;
        more = page.more;
      }
      if (next !== cursor) {
        await call(d.rpc, "source_cursor_save", { p_id: d.ctx.source.id, p_object: object, p_cursor: next == null ? null : JSON.stringify(next) });
        d.ctx.source.cursors[object] = next as string;
      }
      if (!more) break;
      if ((d.now ?? Date.now)() - start > budgetMs) return { more: true, counts };
    }
  }
  return { more: false, counts };
}

/** Apply staged webhook events: deletes, records that came whole, and ids to fetch. */
export async function applyHooks(d: Deps, events: HookEvent[]): Promise<Counts> {
  const c = zero();
  for (const object of ["companies", "contacts"] as const) {
    const mine = events.filter((e) => e.object === object);
    if (!mine.length) continue;
    // The last event for a record wins.
    const last = new Map<string, HookEvent>();
    for (const e of mine) last.set(e.id, e);
    const deleted = [...last.values()].filter((e) => e.deleted).map((e) => ({ id: e.id, deleted: true, data: {} }) as RawRecord);
    const whole = [...last.values()].filter((e) => !e.deleted && e.record).map((e) => e.record!);
    const ids = [...last.values()].filter((e) => !e.deleted && !e.record).map((e) => e.id);
    const fetched: RawRecord[] = [];
    for (let i = 0; i < ids.length; i += 100) fetched.push(...((await d.connector.fetch?.(d.ctx, object, ids.slice(i, i + 100))) ?? []));
    const all = [...deleted, ...whole, ...fetched];
    const got = object === "contacts" ? await applyContacts(d, all) : await applyCompanies(d, all);
    for (const k of ["pulled", "written", "skipped", "errors"] as const) c[k] += got[k];
  }
  return c;
}

// Out ---------------------------------------------------------------------------------------------------------

type Candidate = {
  id: string;
  updated_at: string;
  email: string;
  email_clean: string;
  first_name: string | null;
  last_name: string | null;
  title: string | null;
  phone: string | null;
  country: string | null;
  region: string | null;
  timezone: string | null;
  lifecycle: string | null;
  lead_status: string | null;
  fields: Record<string, unknown>;
  company_name: string | null;
  company_domain: string | null;
  external_id: string | null;
  last: Record<string, unknown> | null;
  suppressed: boolean;
};

const plain = (c: Candidate) => ({ ...c, first_name: c.first_name ?? undefined, last_name: c.last_name ?? undefined, title: c.title ?? undefined, phone: c.phone ?? undefined, country: c.country ?? undefined, region: c.region ?? undefined, timezone: c.timezone ?? undefined, lifecycle: c.lifecycle ?? undefined, lead_status: c.lead_status ?? undefined, company_name: c.company_name ?? undefined, company_domain: c.company_domain ?? undefined });

/** Push contacts that changed here. `ids` pushes just those (a retry from the sync log). */
export async function push(d: Deps, opts: { ids?: string[]; budgetMs?: number; batch?: number } = {}): Promise<Counts & { more: boolean }> {
  const c = { ...zero(), more: false };
  const src = d.ctx.source;
  if (!d.connector.push || (src.settings.objects?.contacts ?? "in") !== "both") return c;
  const now = d.now ?? Date.now;
  const start = now();
  const all = effectiveMapping(d.connector, "contact", d.saved, [], d.clean.custom);
  const cols = d.connector.writable ? all.filter((m) => d.connector.writable!.includes(m.col)) : all;
  const keys = new Set(compared(cols).filter(pushable));
  const pushPart = (v: Record<string, unknown> | null | undefined) => Object.fromEntries(Object.entries(v ?? {}).filter(([k]) => keys.has(k)));
  const pushNew = src.settings.push_new ?? "lifecycle";
  let cursor = opts.ids ? null : src.push_cursor;
  for (;;) {
    if (d.ctx.signal?.aborted) throw new Error("Stopped");
    const cands = await call<Candidate[]>(d.rpc, "push_candidates", { p_source: src.id, p_after: cursor, p_limit: opts.batch ?? 200, p_ids: opts.ids ?? null });
    if (!cands.length) break;
    const changes: (PushChange & { values: Record<string, unknown>; ours: Record<string, unknown>; last: Record<string, unknown> | null })[] = [];
    for (const k of cands) {
      const x = plain(k);
      const ours = agreed(cols, x);
      if (!k.external_id) {
        const allowed = pushNew === "all" || (pushNew === "lifecycle" && !!k.lifecycle && k.lifecycle !== "subscriber");
        if (!allowed) continue;
      } else if (changedKeys(pushPart(k.last), pushPart(ours)).length === 0) {
        c.skipped++;
        continue;
      }
      changes.push({ localId: k.id, externalId: k.external_id, values: toRemote(cols, x), ours, last: k.last });
    }
    if (changes.length) {
      const results = await d.connector.push(d.ctx, changes);
      const byId = new Map(results.map((r) => [r.localId, r]));
      const put: { external_id: string; local_id: string; values: Record<string, unknown> }[] = [];
      const rows: LogRow[] = [];
      const gone: string[] = [];
      for (const ch of changes) {
        const r = byId.get(ch.localId);
        if (r?.gone && ch.externalId) {
          gone.push(ch.externalId);
          rows.push({ direction: "in", object: "contact", local_id: ch.localId, external_id: ch.externalId, action: "delete" });
          continue;
        }
        if (!r || r.error || !r.externalId) {
          c.errors++;
          rows.push({ direction: "out", object: "contact", local_id: ch.localId, external_id: ch.externalId, action: "error", error: r?.error ?? "The tool didn't answer for this contact." });
          continue;
        }
        // What the tool now holds: what it had, with what we sent.
        put.push({ external_id: r.externalId, local_id: ch.localId, values: { ...(ch.last ?? {}), ...pushPart(ch.ours) } });
        rows.push({ direction: "out", object: "contact", local_id: ch.localId, external_id: r.externalId, action: ch.externalId ? "update" : "create", fields: changedKeys(pushPart(ch.last), pushPart(ch.ours)) });
        c.written++;
      }
      if (put.length) await call(d.rpc, "source_links_put", { p_source: src.id, p_object: "contact", p_rows: put });
      if (gone.length) await call(d.rpc, "source_links_delete", { p_source: src.id, p_object: "contact", p_external: gone });
      await log(d, rows);
    }
    if (opts.ids) break;
    // Read on from the last row. The saved cursor stays 30 seconds back: rows written just now may still be
    // committing elsewhere, and the next push reads them again (skipped if nothing changed).
    const lastRow = cands[cands.length - 1];
    cursor = `${lastRow.updated_at}|${lastRow.id}`;
    const safe = new Date(now() - 30_000).toISOString();
    const saved = lastRow.updated_at < safe ? cursor : `${safe}|`;
    if (saved !== src.push_cursor) {
      await call(d.rpc, "source_push_cursor_save", { p_id: src.id, p_cursor: saved });
      src.push_cursor = saved;
    }
    if (cands.length < (opts.batch ?? 200)) break;
    if (now() - start > (opts.budgetMs ?? 240_000)) {
      c.more = true;
      break;
    }
  }
  return c;
}
