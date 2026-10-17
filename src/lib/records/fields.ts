// Fields for every record type: contacts, companies and custom objects (supabase/migrations/034_records.sql).
// Built-in fields are defined here; custom fields come from the fields table. Runs in the browser and on the server.

import type { Choice, FieldType, FilterField } from "../filters.ts";

export type FieldKind =
  | "text"
  | "long_text"
  | "number"
  | "currency"
  | "percent"
  | "date"
  | "datetime"
  | "select"
  | "multi_select"
  | "checkbox"
  | "url"
  | "email"
  | "phone"
  | "user"
  | "relation";

export const FIELD_KINDS: { value: FieldKind; label: string }[] = [
  { value: "text", label: "Text" },
  { value: "long_text", label: "Long text" },
  { value: "number", label: "Number" },
  { value: "currency", label: "Currency" },
  { value: "percent", label: "Percent" },
  { value: "date", label: "Date" },
  { value: "datetime", label: "Date and time" },
  { value: "select", label: "Pick one" },
  { value: "multi_select", label: "Pick many" },
  { value: "checkbox", label: "Yes or no" },
  { value: "url", label: "Link" },
  { value: "email", label: "Email" },
  { value: "phone", label: "Phone" },
  { value: "user", label: "Teammate" },
  { value: "relation", label: "Linked record" },
];

/** A pick list option. Stages carry a kind, so boards can tell open, won and lost apart. */
export type Option = { value: string; label: string; color?: string; kind?: "open" | "won" | "lost" };

export type FieldConfig = { target?: string; multiple?: boolean; currency?: string; decimals?: number };

export type CustomField = {
  key: string;
  label: string;
  type: FieldKind;
  options: (Option | string)[];
  config?: FieldConfig;
  required?: boolean;
  group?: string | null;
  group_name?: string | null;
  position?: number;
  /** Built in (an opportunity's amount or stage): it can be changed but not deleted. */
  system?: boolean;
};

export type ObjectDef = { id?: string; key: string; label: string; plural: string; icon: string };

export type Person = { id: string; email: string; role?: string };

export const optionsOf = (f: { options?: (Option | string)[] | null }): Option[] =>
  (f.options ?? []).map((o) => (typeof o === "string" ? { value: o, label: o } : { ...o, label: o.label ?? o.value }));

/** How a field filters. */
export function filterKind(t: FieldKind): FieldType {
  switch (t) {
    case "number":
    case "currency":
    case "percent":
      return "number";
    case "date":
    case "datetime":
      return "date";
    case "checkbox":
      return "bool";
    case "select":
    case "user":
      return "enum";
    case "multi_select":
      return "multi";
    case "relation":
      return "link";
    default:
      return "text";
  }
}

export const LIFECYCLES: Option[] = [
  { value: "subscriber", label: "Subscriber" },
  { value: "lead", label: "Lead" },
  { value: "mql", label: "MQL" },
  { value: "sql", label: "SQL" },
  { value: "opportunity", label: "Opportunity" },
  { value: "customer", label: "Customer", kind: "won" },
  { value: "evangelist", label: "Evangelist", kind: "won" },
  { value: "other", label: "Other" },
];

/** Lead stages until a workspace sets its own (Settings › Fields). Same as Omniscient's. */
export const LEAD_STAGES: Option[] = [
  { value: "new", label: "New", kind: "open" },
  { value: "attempting", label: "Attempting", kind: "open" },
  { value: "connected", label: "Connected", kind: "open" },
  { value: "qualified", label: "Qualified", kind: "won" },
  { value: "disqualified", label: "Disqualified", kind: "lost" },
];

export const SOURCES: Choice[] = [
  { value: "manual", label: "App" },
  { value: "import", label: "Import" },
  { value: "hubspot", label: "HubSpot" },
  { value: "salesforce", label: "Salesforce" },
  { value: "omniscient", label: "Omniscient" },
  { value: "form", label: "Form" },
  { value: "api", label: "API" },
];

export const EMAIL_CLASSES: Choice[] = [
  { value: "work", label: "Work" },
  { value: "free", label: "Free mail" },
  { value: "role", label: "Shared inbox" },
  { value: "own", label: "Own team" },
  { value: "partner", label: "Partner" },
];

/**
 * A built-in field. `kind` says how it shows and edits; `edit` says whether the table and record page can change it
 * inline (email and company website change through the edit form, since the server cleans them).
 */
export type BuiltIn = { key: string; label: string; kind: FieldKind; filter: FieldType; edit: boolean; sort?: string; options?: Option[]; hideable?: boolean };

const b = (key: string, label: string, kind: FieldKind, edit: boolean, extra: Partial<BuiltIn> = {}): BuiltIn => ({
  key,
  label,
  kind,
  filter: filterKind(kind),
  edit,
  hideable: true,
  ...extra,
});

export const CONTACT_BUILTINS: BuiltIn[] = [
  b("name", "Name", "text", false, { sort: "name", hideable: false }),
  b("email", "Email", "email", false, { sort: "email", hideable: false, filter: "text" }),
  b("first_name", "First name", "text", true),
  b("last_name", "Last name", "text", true),
  b("company", "Company", "text", true, { sort: "company" }),
  b("title", "Title", "text", true, { sort: "title" }),
  b("lifecycle", "Lifecycle", "select", true, { sort: "lifecycle", options: LIFECYCLES }),
  b("lead_status", "Lead status", "select", true, { sort: "lead_status", options: LEAD_STAGES }),
  b("owner", "Owner", "user", true),
  b("phone", "Phone", "phone", true, { filter: "text" }),
  b("country", "Country", "text", true, { sort: "country" }),
  b("region", "State or region", "text", true),
  b("score", "Score", "number", false, { sort: "score" }),
  b("fit", "Fit", "number", false, { sort: "fit" }),
  b("intent", "Intent", "number", false),
  b("known", "Seen on site", "checkbox", false),
  b("segment", "List", "relation", false),
  b("source", "Source", "select", false, { options: SOURCES as Option[] }),
  b("email_class", "Email type", "select", false, { options: EMAIL_CLASSES as Option[] }),
  b("company_domain", "Company domain", "text", false),
  b("industry", "Industry", "text", false),
  b("size", "Company size", "text", false),
  b("created_at", "Created", "datetime", false, { sort: "created_at" }),
  b("updated_at", "Updated", "datetime", false, { sort: "updated_at" }),
];

export const COMPANY_BUILTINS: BuiltIn[] = [
  b("name", "Name", "text", true, { sort: "name", hideable: false }),
  b("domain", "Domain", "url", false, { sort: "domain", filter: "text" }),
  b("industry", "Industry", "text", true),
  b("size", "Size", "text", true),
  b("country", "Country", "text", true),
  b("owner", "Owner", "user", true),
  b("fit", "Fit", "number", false, { sort: "fit" }),
  b("intent", "Intent", "number", false, { sort: "intent" }),
  b("stage", "Stage", "select", false, {
    options: ["evaluating", "researching", "engaged", "unknown"].map((v) => ({ value: v, label: v[0].toUpperCase() + v.slice(1) })),
  }),
  b("contacts", "Contacts", "number", false, { sort: "contacts" }),
  b("created_at", "Created", "datetime", false, { sort: "created_at" }),
  b("updated_at", "Updated", "datetime", false, { sort: "updated_at" }),
];

export const RECORD_BUILTINS: BuiltIn[] = [
  b("name", "Name", "text", true, { sort: "name", hideable: false }),
  b("created_at", "Created", "datetime", false, { sort: "created_at" }),
  b("updated_at", "Updated", "datetime", false, { sort: "updated_at" }),
];

export const builtinsFor = (object: string) => (object === "contact" ? CONTACT_BUILTINS : object === "company" ? COMPANY_BUILTINS : RECORD_BUILTINS);

export type FieldSetting = { key: string; label: string | null; hidden: boolean; options: Option[] | null };

/** One field as screens use it: built-in or custom, with the workspace's labels and options applied. */
export type AnyField = {
  key: string; // built-in key, or "f.<custom key>"
  label: string;
  kind: FieldKind;
  filter: FieldType;
  edit: boolean;
  sort?: string;
  options: Option[];
  custom: boolean;
  hidden: boolean;
  required: boolean;
  group: string | null;
  config: FieldConfig;
};

export function allFields(object: string, custom: CustomField[], settings: FieldSetting[] = [], extra: { people?: Person[]; lists?: Option[] } = {}): AnyField[] {
  const set = new Map(settings.map((s) => [s.key, s]));
  const people = (extra.people ?? []).map((p) => ({ value: p.id, label: p.email }));
  const builtins = builtinsFor(object).map((x): AnyField => {
    const s = set.get(x.key);
    const options = x.kind === "user" ? people : x.key === "segment" ? (extra.lists ?? []) : (s?.options ?? x.options ?? []);
    return {
      key: x.key,
      label: s?.label ?? x.label,
      kind: x.kind,
      filter: x.filter,
      edit: x.edit,
      sort: x.sort,
      options,
      custom: false,
      hidden: (x.hideable !== false && s?.hidden) || false,
      required: x.key === "name" || x.key === "email",
      group: null,
      config: {},
    };
  });
  const customs = [...custom]
    .sort((a, z) => (a.position ?? 0) - (z.position ?? 0))
    .map(
      (f): AnyField => ({
        key: `f.${f.key}`,
        label: f.label,
        kind: f.type,
        filter: filterKind(f.type),
        edit: true,
        sort: f.type === "relation" || f.type === "multi_select" ? undefined : `f.${f.key}`,
        options: f.type === "user" ? people : optionsOf(f),
        custom: true,
        hidden: false,
        required: !!f.required,
        group: f.group ?? f.group_name ?? null,
        config: f.config ?? {},
      }),
    );
  return [...builtins, ...customs];
}

/** A record's value for a field key, from a list row or a detail record. */
export function valueOf(row: Record<string, unknown>, key: string): unknown {
  if (key.startsWith("f.")) {
    const k = key.slice(2);
    const links = row.links as Record<string, { id: string }[]> | undefined;
    if (links && k in links) return links[k].map((l) => l.id);
    return (row.fields as Record<string, unknown> | undefined)?.[k];
  }
  switch (key) {
    case "name":
      return row.name ?? ([row.first_name, row.last_name].filter(Boolean).join(" ").trim() || null);
    case "company":
      return row.company_name ?? row.company ?? null;
    case "known":
      return !!row.person_id;
    case "owner":
      return row.owner ?? row.owner_user_id ?? null;
    default:
      return row[key];
  }
}

/** Fields as the filter bar takes them. */
export function filterFields(fields: AnyField[]): FilterField<Record<string, unknown>>[] {
  return fields.map((f) => ({ key: f.key, label: f.label, type: f.filter, options: f.options.length ? f.options : undefined, get: (r) => valueOf(r, f.key) }));
}

// Values ------------------------------------------------------------------------------------------------------------

const YES = new Set(["yes", "y", "true", "1"]);
const NO = new Set(["no", "n", "false", "0"]);

/** A custom field's value from text (a CSV cell or a form box), or undefined when blank or it doesn't fit. */
export function customValue(f: Pick<CustomField, "type" | "options">, raw: string): string | number | boolean | string[] | undefined {
  const s = raw.trim();
  if (!s) return undefined;
  switch (f.type as string) {
    case "number":
    case "currency":
    case "percent": {
      const n = s.replace(/[,\s$€£¥%]/g, "");
      return /^-?\d+(\.\d+)?$/.test(n) ? Number(n) : undefined;
    }
    case "date": {
      const iso = /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
      const t = iso ? Date.parse(`${iso}T00:00:00Z`) : NaN;
      return Number.isNaN(t) ? undefined : iso!;
    }
    case "datetime": {
      const t = Date.parse(s);
      return Number.isNaN(t) ? undefined : new Date(t).toISOString();
    }
    case "checkbox":
    case "bool":
      return YES.has(s.toLowerCase()) ? true : NO.has(s.toLowerCase()) ? false : undefined;
    case "select":
    case "enum": {
      const o = optionsOf(f).find((x) => x.value.toLowerCase() === s.toLowerCase() || x.label.toLowerCase() === s.toLowerCase());
      return o?.value;
    }
    case "multi_select": {
      const opts = optionsOf(f);
      const picked = s
        .split(/[;,|]/)
        .map((p) => p.trim().toLowerCase())
        .filter(Boolean)
        .map((p) => opts.find((x) => x.value.toLowerCase() === p || x.label.toLowerCase() === p)?.value)
        .filter((v): v is string => !!v);
      return picked.length ? [...new Set(picked)] : undefined;
    }
    case "url":
      return /^https?:\/\/\S+$/i.test(s) ? s.slice(0, 2000) : /^[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i.test(s) ? `https://${s}`.slice(0, 2000) : undefined;
    case "email":
      return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s) ? s.toLowerCase().slice(0, 320) : undefined;
    case "phone":
      return s.slice(0, 50);
    case "long_text":
      return s.slice(0, 20000);
    case "user":
    case "relation":
      return undefined;
    default:
      return s.slice(0, 500);
  }
}

/** A value as text for a cell, a CSV export or a tag. */
export function shown(f: Pick<AnyField, "kind" | "options" | "config">, v: unknown): string {
  if (v == null || v === "") return "";
  const label = (x: unknown) => f.options.find((o) => o.value === String(x))?.label ?? String(x);
  switch (f.kind) {
    case "checkbox":
      return v ? "Yes" : "No";
    case "select":
    case "user":
      return label(v);
    case "multi_select":
      return Array.isArray(v) ? v.map(label).join(", ") : label(v);
    case "currency":
      return typeof v === "number" ? v.toLocaleString("en-US", { style: "currency", currency: f.config.currency || "USD", maximumFractionDigits: f.config.decimals ?? 0 }) : String(v);
    case "percent":
      return `${v}%`;
    case "number":
      return typeof v === "number" ? v.toLocaleString("en-US") : String(v);
    case "datetime":
      return new Date(String(v)).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
    case "date":
      return new Date(`${String(v).slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
    default:
      return Array.isArray(v) ? v.join(", ") : String(v);
  }
}

/** Ready-made field sets, like Omniscient's packs. */
export const PACKS: { key: string; label: string; object: "contact" | "company"; fields: { label: string; type: FieldKind; options?: string[] }[] }[] = [
  {
    key: "bant",
    label: "BANT",
    object: "contact",
    fields: [
      { label: "Budget", type: "currency" },
      { label: "Authority", type: "select", options: ["Decision maker", "Influencer", "User", "Unknown"] },
      { label: "Need", type: "long_text" },
      { label: "Timeline", type: "select", options: ["This quarter", "Next quarter", "This year", "Later"] },
    ],
  },
  {
    key: "inbound",
    label: "Inbound",
    object: "contact",
    fields: [
      { label: "First touch", type: "select", options: ["Search", "AI answer", "Social", "Referral", "Event", "Ads", "Direct"] },
      { label: "First conversion", type: "text" },
      { label: "Interests", type: "multi_select", options: ["Product", "Pricing", "Security", "Integrations", "Case studies"] },
    ],
  },
  {
    key: "meddic",
    label: "MEDDIC",
    object: "contact",
    fields: [
      { label: "Metrics", type: "long_text" },
      { label: "Economic buyer", type: "text" },
      { label: "Decision criteria", type: "long_text" },
      { label: "Decision process", type: "long_text" },
      { label: "Identified pain", type: "long_text" },
      { label: "Champion", type: "checkbox" },
    ],
  },
  {
    key: "buying_group",
    label: "Buying group",
    object: "contact",
    fields: [
      { label: "Buying role", type: "select", options: ["Decision maker", "Champion", "Influencer", "User", "Finance", "Blocker"] },
      { label: "Seniority", type: "select", options: ["C-level", "VP", "Director", "Manager", "Individual"] },
      { label: "Department", type: "select", options: ["Marketing", "Sales", "Engineering", "Product", "Finance", "HR", "Operations", "Other"] },
    ],
  },
  {
    key: "saas_account",
    label: "SaaS account",
    object: "company",
    fields: [
      { label: "Plan", type: "select", options: ["Free", "Starter", "Growth", "Enterprise"] },
      { label: "ARR", type: "currency" },
      { label: "Seats", type: "number" },
      { label: "Renewal date", type: "date" },
      { label: "Health", type: "select", options: ["Good", "At risk", "Churning"] },
    ],
  },
];
