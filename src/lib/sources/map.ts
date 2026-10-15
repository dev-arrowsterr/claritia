// From a tool's columns to our fields and back. A source's saved mapping wins; without one, the connector's
// defaults apply, and form tools guess from the question. Records become rows for the same cleaning the file
// import uses, so a phone, a name or a consent answer means the same thing from any source.

import type { ContactInput } from "../contacts/import.ts";
import { guessTarget, type CustomField, type Target } from "../contacts/fields.ts";
import type { CompanyTarget, Connector, RawRecord } from "./types.ts";

export type Col = { col: string; target: string; valueMap: Record<string, string> };
export type SavedMapping = { object: "contact" | "company"; col: string; target: string; value_map: Record<string, string> };

/** The columns that map, for one object. */
export function effectiveMapping(c: Connector, object: "contact" | "company", saved: SavedMapping[], seen: string[], custom: CustomField[]): Col[] {
  const mine = saved.filter((m) => m.object === object);
  const vm = c.defaults.valueMaps ?? {};
  if (mine.length) return mine.map((m) => ({ col: m.col, target: m.target, valueMap: { ...(vm[m.col] ?? {}), ...m.value_map } }));
  const defaults = (object === "contact" ? c.defaults.contact : (c.defaults.company ?? {})) as Record<string, string>;
  const out: Col[] = Object.entries(defaults).map(([col, target]) => ({ col, target, valueMap: vm[col] ?? {} }));
  if (c.guess && object === "contact") {
    const taken = new Set(out.map((m) => m.target));
    for (const col of seen) {
      if (out.some((m) => m.col === col)) continue;
      const t = guessTarget(col, custom);
      if (t !== "skip" && !taken.has(t)) {
        out.push({ col, target: t, valueMap: {} });
        taken.add(t);
      }
    }
  }
  return out.filter((m) => m.target !== "skip");
}

export const cellOf = (v: unknown): string => {
  if (v == null) return "";
  if (Array.isArray(v)) return v.map(cellOf).filter(Boolean).join(";");
  if (typeof v === "object") return "";
  return String(v).trim();
};

const mapValue = (v: string, m: Record<string, string>) => (v && Object.keys(m).length ? (m[v] ?? m[v.toLowerCase()] ?? v) : v);

/** Records as rows for prepareImport: mapped columns, then the record's consent cell and its id. */
export function recordsToRows(records: RawRecord[], cols: Col[], consent: Connector["consent"]): { targets: Target[]; rows: string[][] } {
  const hasBasis = cols.some((c) => c.target === "basis");
  // A mapped consent column and the connector's own answer can't both be "basis".
  const targets = [...cols.map((c) => c.target as Target), (hasBasis ? "skip" : "basis") as Target, "source_id" as Target];
  const rows = records.map((r) => [...cols.map((c) => mapValue(cellOf(r.data[c.col]), c.valueMap)), hasBasis ? "" : (consent?.(r) ?? ""), r.id]);
  return { targets, rows };
}

// Values both sides agree on ----------------------------------------------------------------------------------
// The fields a link remembers, in our own shape, so a value the tool spells differently ("United States" and
// "US") still counts as the same.

type Local = Partial<Pick<ContactInput, "email_clean" | "first_name" | "last_name" | "title" | "phone" | "country" | "region" | "timezone" | "lifecycle" | "lead_status" | "company_name" | "company_domain">> & {
  fields?: Record<string, unknown> | null;
};

// Company and website stay as the tool has them: a contact's company on our side is a shared record.
const PUSHABLE = new Set(["email", "first_name", "last_name", "title", "phone", "country", "region", "timezone", "lifecycle", "lead_status"]);
export const pushable = (t: string) => PUSHABLE.has(t) || t.startsWith("f.");

function norm(v: unknown): unknown {
  if (v == null || v === "") return undefined;
  if (Array.isArray(v)) return v.length ? [...v].map(String).sort() : undefined;
  if (typeof v === "string") return v.trim() || undefined;
  return v;
}

export function localValue(t: string, c: Local): unknown {
  if (t === "email") return norm(c.email_clean);
  if (t === "company") return norm(c.company_name);
  if (t === "website") return norm(c.company_domain);
  if (t.startsWith("f.")) return norm(c.fields?.[t.slice(2)]);
  return norm((c as Record<string, unknown>)[t]);
}

/** The targets a mapping compares: everything mapped, with a full name standing for first and last name. */
export function compared(cols: Col[]): string[] {
  const out = new Set<string>();
  for (const m of cols) {
    if (m.target === "name") {
      out.add("first_name");
      out.add("last_name");
    } else if (m.target !== "basis" && m.target !== "skip" && m.target !== "source_id") out.add(m.target);
  }
  return [...out];
}

/** The mapped values of a contact, keyed by target. */
export function agreed(cols: Col[], c: Local): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const t of compared(cols)) {
    const v = localValue(t, c);
    if (v !== undefined) out[t] = v;
  }
  return out;
}

/** Only the keys a push may send. */
export const pushPart = (v: Record<string, unknown> | null | undefined) => Object.fromEntries(Object.entries(v ?? {}).filter(([k]) => pushable(k)));

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Targets whose values differ. */
export function changedKeys(before: Record<string, unknown> | null | undefined, after: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after)]);
  return [...keys].filter((k) => !same(before?.[k], after[k])).sort();
}

/** A contact in the tool's columns, for a push. Value maps run backwards. */
export function toRemote(cols: Col[], c: Local & { email?: string | null }): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const m of cols) {
    let v: unknown;
    if (m.target === "name") v = [c.first_name, c.last_name].filter(Boolean).join(" ") || undefined;
    else if (!pushable(m.target)) continue;
    else v = m.target === "email" ? (c.email ?? c.email_clean) : localValue(m.target, c);
    if (v === undefined || v === null) continue;
    if (typeof v === "string" && Object.keys(m.valueMap).length) {
      const back = Object.entries(m.valueMap).find(([, ours]) => ours === v);
      if (back) v = back[0];
    }
    out[m.col] = Array.isArray(v) ? v.join(";") : v;
  }
  return out;
}

// Companies ---------------------------------------------------------------------------------------------------

export type CompanyInput = { domain?: string; name?: string; industry?: string; size?: string; country?: string; fields: Record<string, unknown>; source_id: string };

export function recordsToCompanies(records: RawRecord[], cols: Col[], custom: CustomField[], countryCode: (s: string) => string | undefined): CompanyInput[] {
  const keys = new Set(custom.map((f) => f.key));
  return records.map((r) => {
    const out: CompanyInput = { fields: {}, source_id: r.id };
    for (const m of cols) {
      const v = mapValue(cellOf(r.data[m.col]), m.valueMap);
      if (!v) continue;
      const t = m.target as CompanyTarget;
      if (t === "domain") out.domain = v.replace(/^(https?:\/\/)?(www\.)?/i, "").replace(/[/?#].*$/, "").toLowerCase();
      else if (t === "country") out.country = countryCode(v);
      else if (t === "name" || t === "industry" || t === "size") out[t] = v;
      else if (t.startsWith("f.") && keys.has(t.slice(2))) out.fields[t.slice(2)] = v;
    }
    return out;
  });
}
