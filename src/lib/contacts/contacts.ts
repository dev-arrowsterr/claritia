// Writing contacts (docs/conversion-parity.md Part 3): cleaning one contact typed into the app, and sending batches
// to contacts_upsert. A batch is safe to send twice (it upserts by cleaned email), so a batch whose answer was lost
// is sent again, never skipped. Server only.

import { cleanDomain } from "../company/domains.ts";
import { cleanEmail, isRejected } from "../identity/clean.ts";
import type { Rpc } from "../jobs.ts";
import { basisFor, BASES, type Basis } from "./consent.ts";
import { countryCode, customValue, LIFECYCLES, type CustomField } from "./fields.ts";
import type { ContactInput } from "./import.ts";

export type Source = "manual" | "import" | "hubspot" | "salesforce" | "omniscient" | "form" | "api";
export type Written = { created: number; updated: number; ids: string[] };

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Send contacts in batches. Each batch is tried up to `tries` times. */
export async function writeContacts(
  rpc: Rpc,
  ws: string,
  source: Source,
  contacts: ContactInput[],
  opts: { importId?: string; batch?: number; tries?: number; backoffMs?: number; onBatch?: (done: number) => void } = {},
): Promise<Written> {
  const size = Math.min(opts.batch ?? 1000, 2000);
  const tries = opts.tries ?? 3;
  const out: Written = { created: 0, updated: 0, ids: [] };
  for (let i = 0; i < contacts.length; i += size) {
    const rows = contacts.slice(i, i + size);
    for (let attempt = 1; ; attempt++) {
      const { data, error } = await rpc("contacts_upsert", { p_ws: ws, p_source: source, p_rows: rows, p_import: opts.importId ?? null });
      if (!error) {
        const r = data as Written;
        out.created += r.created;
        out.updated += r.updated;
        out.ids.push(...r.ids);
        break;
      }
      if (attempt >= tries) throw new Error(error.message);
      await wait((opts.backoffMs ?? 500) * 2 ** (attempt - 1));
    }
    opts.onBatch?.(Math.min(i + size, contacts.length));
  }
  return out;
}

/** What someone typed into the add or edit form. Every key is optional; for an edit, only changed keys are sent. */
export type ContactForm = Partial<Record<"email" | "first_name" | "last_name" | "title" | "phone" | "company" | "website" | "country" | "region" | "lifecycle" | "lead_status", string>> & {
  fields?: Record<string, string>;
  /** New contacts only. */
  basis?: string;
};

const LIMITS: Record<string, number> = { first_name: 100, last_name: 100, title: 200, phone: 50, region: 100, lead_status: 60, company: 200 };
const LIFECYCLE_SET = new Set(LIFECYCLES.map((l) => l.value));

/**
 * The form as contact_update's values: blank clears, email comes cleaned, website becomes a company domain.
 * Returns an error to show when something doesn't fit.
 */
export function formValues(form: ContactForm, custom: CustomField[], ctx: { own_domains?: string[]; partner_domains?: string[] } = {}): { values: Record<string, unknown> } | { error: string } {
  const values: Record<string, unknown> = {};
  for (const [k, raw] of Object.entries(form)) {
    if (k === "fields" || typeof raw !== "string") continue;
    const v = raw.trim();
    if (k === "email") {
      const e = cleanEmail(v, ctx);
      if (isRejected(e)) return { error: e.rejected === "disposable" ? "Disposable emails can't be added." : "Enter a valid email." };
      Object.assign(values, { email: v.slice(0, 320), email_clean: e.clean, email_class: e.class });
    } else if (k === "country") {
      if (v && !countryCode(v)) return { error: "Enter a country name or its 2-letter code." };
      values.country = v ? countryCode(v) : null;
    } else if (k === "lifecycle") {
      if (v && !LIFECYCLE_SET.has(v)) return { error: "Pick a lifecycle stage." };
      values.lifecycle = v || null;
    } else if (k === "website") {
      const d = v ? cleanDomain(v)?.domain : null;
      if (v && !d) return { error: "Enter a website like acme.com." };
      values.company_domain = d ?? null;
    } else if (k === "company") {
      values.company_name = v.slice(0, LIMITS.company) || null;
    } else if (k in LIMITS) {
      values[k] = v.slice(0, LIMITS[k]) || null;
    }
  }
  if (form.fields) {
    const fields: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(form.fields)) {
      const f = custom.find((x) => x.key === key);
      if (!f) return { error: "A field no longer exists. Reload the page." };
      if (!String(raw).trim()) {
        fields[key] = null;
        continue;
      }
      const v = customValue(f, String(raw));
      if (v === undefined) return { error: `${f.label}: ${f.type === "number" ? "enter a number" : f.type === "date" ? "enter a date like 2026-03-31" : f.type === "bool" ? "enter yes or no" : "pick one of its values"}.` };
      fields[key] = v;
    }
    values.fields = fields;
  }
  return { values };
}

/** A new contact from the add form, as one contacts_upsert row. */
export function newContact(form: ContactForm, custom: CustomField[], ctx: { own_domains?: string[]; partner_domains?: string[] } = {}): { contact: ContactInput } | { error: string } {
  if (!form.email?.trim()) return { error: "Enter an email." };
  if (form.basis && !BASES.some((b) => b.value === form.basis)) return { error: "Pick the email consent." };
  const r = formValues(form, custom, ctx);
  if ("error" in r) return r;
  const v = r.values as Record<string, string | null | Record<string, unknown>>;
  const str = (k: string) => (typeof v[k] === "string" ? (v[k] as string) : undefined);
  const e = cleanEmail(form.email.trim(), ctx);
  const domain = str("company_domain") ?? (!isRejected(e) && (e.class === "work" || e.class === "role") ? cleanDomain(e.domain ?? "")?.domain : undefined);
  return {
    contact: {
      email: str("email")!,
      email_clean: str("email_clean")!,
      email_class: str("email_class") ?? null,
      first_name: str("first_name"),
      last_name: str("last_name"),
      title: str("title"),
      phone: str("phone"),
      country: str("country"),
      region: str("region"),
      lifecycle: str("lifecycle"),
      lead_status: str("lead_status"),
      company_name: str("company_name"),
      company_domain: domain,
      fields: Object.fromEntries(Object.entries((v.fields as Record<string, string | number | boolean | null>) ?? {}).filter(([, x]) => x !== null)) as ContactInput["fields"],
      basis: basisFor(str("country"), (form.basis as Basis) || "none"),
    },
  };
}
