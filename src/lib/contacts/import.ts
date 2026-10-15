// CSV import (docs/conversion-parity.md week 1, docs/marketing-platform.md M2). Each row becomes a contact keyed by
// its cleaned email (docs/identity.md Part 6), so "Jane.Doe+news@gmail.com" and "janedoe@gmail.com" are one
// contact. Rows with the same email in one file merge, later cells winning. A bad cell is dropped, never the
// whole row; a row with no usable email is skipped and counted. Server only (email cleaning reads the lists).

import { cleanDomain } from "../company/domains.ts";
import { cleanEmail, isRejected } from "../identity/clean.ts";
import { basisFor, parseBasis, sourceRefused, type Basis, type ImportSource } from "./consent.ts";
import { countryCode, customValue, lifecycleOf, type CustomField, type Target } from "./fields.ts";

/** One contact as contacts_upsert takes it (supabase/migrations/033_contacts.sql). */
export type ContactInput = {
  email: string;
  email_clean: string;
  email_class: string | null;
  first_name?: string;
  last_name?: string;
  title?: string;
  phone?: string;
  country?: string;
  region?: string;
  timezone?: string;
  lifecycle?: string;
  lead_status?: string;
  company_domain?: string;
  company_name?: string;
  fields: Record<string, string | number | boolean>;
  basis?: Basis;
};

export type Mapping = { columns: Target[]; source: ImportSource; basis: Basis | null };
export type Skipped = { missing_email: number; invalid_email: number; disposable: number };
export type Prepared = { contacts: ContactInput[]; counts: { rows: number; merged: number; no_basis: number; skipped: Skipped } };
export type Ctx = { custom: CustomField[]; own_domains?: string[]; partner_domains?: string[] };

export { MAX_BYTES, MAX_ROWS } from "./csv.ts";

/** What's wrong with a mapping, or null when it can run. */
export function mappingError(m: Mapping, columns: number, custom: CustomField[]): string | null {
  if (!Array.isArray(m.columns) || m.columns.length !== columns) return "Map every column.";
  if (sourceRefused(m.source)) return "Bought or rented lists can't be imported.";
  if (!m.source) return "Choose where this list came from.";
  if (!m.columns.includes("email")) return "Map a column to Email.";
  const used = m.columns.filter((t) => t !== "skip");
  if (new Set(used).size !== used.length) return "Each field can take one column.";
  const keys = new Set(custom.map((f) => f.key));
  if (used.some((t) => t.startsWith("f.") && !keys.has(t.slice(2)))) return "A mapped field no longer exists.";
  if (!m.columns.includes("basis") && !m.basis) return "Choose the email consent for this list.";
  return null;
}

const cut = (s: string | undefined, n: number) => {
  const t = s?.trim();
  return t ? t.slice(0, n) : undefined;
};

/** Merge a later row into an earlier one with the same email: later non-blank values win. */
function merge(a: ContactInput, b: ContactInput): ContactInput {
  const out: ContactInput = { ...a, fields: { ...a.fields, ...b.fields } };
  for (const [k, v] of Object.entries(b) as [keyof ContactInput, unknown][]) {
    if (k === "fields" || v === undefined || v === null || v === "") continue;
    (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

/** Rows (without the header) to contacts, with counts of what was merged or skipped. */
export function prepareImport(rows: string[][], m: Mapping, ctx: Ctx): Prepared {
  const counts = { rows: rows.length, merged: 0, no_basis: 0, skipped: { missing_email: 0, invalid_email: 0, disposable: 0 } };
  const at = new Map<Target, number>();
  m.columns.forEach((t, i) => t !== "skip" && at.set(t, i));
  const custom = new Map(ctx.custom.map((f) => [f.key, f]));
  const byEmail = new Map<string, ContactInput>();

  for (const row of rows) {
    const cell = (t: Target) => {
      const i = at.get(t);
      return i === undefined ? undefined : (row[i] ?? "").trim() || undefined;
    };
    const raw = cell("email");
    if (!raw) {
      counts.skipped.missing_email++;
      continue;
    }
    const e = cleanEmail(raw, ctx);
    if (isRejected(e)) {
      if (e.rejected === "disposable") counts.skipped.disposable++;
      else counts.skipped.invalid_email++;
      continue;
    }
    let first = cell("first_name");
    let last = cell("last_name");
    const full = cell("name");
    if (full && !first && !last) {
      const [f, ...rest] = full.split(/\s+/);
      first = f;
      last = rest.join(" ") || undefined;
    }
    const site = cell("website");
    const domain = (site && cleanDomain(site)?.domain) || (e.class === "work" || e.class === "role" ? cleanDomain(e.domain ?? "")?.domain : undefined);
    const country = cell("country") ? countryCode(cell("country")!) : undefined;
    const lifecycle = cell("lifecycle") ? lifecycleOf(cell("lifecycle")!) : undefined;
    const fields: ContactInput["fields"] = {};
    for (const [t, i] of at) {
      if (!t.startsWith("f.")) continue;
      const f = custom.get(t.slice(2));
      const v = f ? customValue(f, row[i] ?? "") : undefined;
      if (f && v !== undefined) fields[f.key] = v;
    }
    // Only a basis the row states; the list's basis fills in after merging, so it never overrides a stated one.
    const stated = parseBasis(cell("basis")) ?? undefined;

    const input: ContactInput = {
      email: raw.slice(0, 320),
      email_clean: e.clean,
      email_class: e.class,
      first_name: cut(first, 100),
      last_name: cut(last, 100),
      title: cut(cell("title"), 200),
      phone: cut(cell("phone"), 50),
      country,
      region: cut(cell("region"), 100),
      timezone: cut(cell("timezone"), 60),
      lifecycle,
      lead_status: cut(cell("lead_status"), 60),
      company_domain: domain || undefined,
      company_name: cut(cell("company"), 200),
      fields,
      basis: stated,
    };
    const prev = byEmail.get(e.clean);
    if (prev) counts.merged++;
    byEmail.set(e.clean, prev ? merge(prev, input) : input);
  }

  // The basis that stands depends on the final country.
  const contacts = [...byEmail.values()].map((c) => ({ ...c, basis: basisFor(c.country, c.basis ?? m.basis ?? "none") }));
  counts.no_basis = contacts.filter((c) => c.basis === "none").length;
  return { contacts, counts };
}
