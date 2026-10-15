// Contact fields: the built-in ones, the workspace's custom ones (the fields table), what a CSV column can map to,
// and how a custom value is checked. Runs in the browser and on the server.

import type { Choice, FieldType, FilterField } from "../filters.ts";

export type CustomField = { key: string; label: string; type: FieldType; options: Choice[] | string[] };

/** A row of the Contacts table (contacts_list). */
export type ContactRow = {
  id: string;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  title: string | null;
  phone: string | null;
  country: string | null;
  region: string | null;
  lifecycle: string | null;
  lead_status: string | null;
  source: string;
  score: number | null;
  score_band: string | null;
  person_id: string | null;
  fields: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  company_id: string | null;
  company_name: string | null;
  company_domain: string | null;
  account_id: string | null;
  fit: number | null;
  email_class?: string | null;
  industry?: string | null;
  size?: string | null;
};

export const LIFECYCLES: Choice[] = [
  { value: "subscriber", label: "Subscriber" },
  { value: "lead", label: "Lead" },
  { value: "mql", label: "MQL" },
  { value: "sql", label: "SQL" },
  { value: "opportunity", label: "Opportunity" },
  { value: "customer", label: "Customer" },
  { value: "evangelist", label: "Evangelist" },
  { value: "other", label: "Other" },
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

export const fullName = (c: { first_name: string | null; last_name: string | null }) => [c.first_name, c.last_name].filter(Boolean).join(" ").trim() || null;

/** Built-in contact fields. Keys match contacts_where in supabase/migrations/033_contacts.sql. */
export const CONTACT_FIELDS: FilterField<ContactRow>[] = [
  { key: "name", label: "Name", type: "text", get: fullName },
  { key: "email", label: "Email", type: "text", get: (c) => c.email },
  { key: "company", label: "Company", type: "text", get: (c) => c.company_name },
  { key: "company_domain", label: "Company domain", type: "text", get: (c) => c.company_domain },
  { key: "title", label: "Title", type: "text", get: (c) => c.title },
  { key: "lifecycle", label: "Lifecycle", type: "enum", options: LIFECYCLES, get: (c) => c.lifecycle },
  { key: "lead_status", label: "Lead status", type: "text", get: (c) => c.lead_status },
  { key: "country", label: "Country", type: "text", get: (c) => c.country },
  { key: "region", label: "State or region", type: "text", get: (c) => c.region },
  { key: "fit", label: "Fit", type: "number", get: (c) => c.fit },
  { key: "score", label: "Score", type: "number", get: (c) => c.score },
  { key: "known", label: "Seen on site", type: "bool", get: (c) => !!c.person_id },
  { key: "source", label: "Source", type: "enum", options: SOURCES, get: (c) => c.source },
  { key: "email_class", label: "Email type", type: "enum", options: EMAIL_CLASSES, get: (c) => c.email_class },
  { key: "industry", label: "Industry", type: "text", get: (c) => c.industry },
  { key: "size", label: "Company size", type: "text", get: (c) => c.size },
  { key: "phone", label: "Phone", type: "text", get: (c) => c.phone },
  { key: "first_name", label: "First name", type: "text", get: (c) => c.first_name },
  { key: "last_name", label: "Last name", type: "text", get: (c) => c.last_name },
  { key: "created_at", label: "Created", type: "date", get: (c) => c.created_at },
  { key: "updated_at", label: "Updated", type: "date", get: (c) => c.updated_at },
];

const optionsOf = (f: CustomField): Choice[] => (f.options ?? []).map((o) => (typeof o === "string" ? { value: o, label: o } : o));

/** Built-in fields plus the workspace's custom ones, keyed f.<key>. */
export function contactFilterFields(custom: CustomField[]): FilterField<ContactRow>[] {
  return [
    ...CONTACT_FIELDS,
    ...custom.map((f) => ({ key: `f.${f.key}`, label: f.label, type: f.type, options: f.type === "enum" ? optionsOf(f) : undefined, get: (c: ContactRow) => c.fields?.[f.key] })),
  ];
}

// What a CSV column can map to -------------------------------------------------------------------------------

export type Target =
  | "skip"
  | "email"
  | "name"
  | "first_name"
  | "last_name"
  | "title"
  | "phone"
  | "company"
  | "website"
  | "country"
  | "region"
  | "timezone"
  | "lifecycle"
  | "lead_status"
  | "basis"
  | `f.${string}`;

export const TARGETS: { value: Target; label: string }[] = [
  { value: "skip", label: "Skip" },
  { value: "email", label: "Email" },
  { value: "name", label: "Full name" },
  { value: "first_name", label: "First name" },
  { value: "last_name", label: "Last name" },
  { value: "title", label: "Title" },
  { value: "phone", label: "Phone" },
  { value: "company", label: "Company" },
  { value: "website", label: "Company website" },
  { value: "country", label: "Country" },
  { value: "region", label: "State or region" },
  { value: "timezone", label: "Time zone" },
  { value: "lifecycle", label: "Lifecycle" },
  { value: "lead_status", label: "Lead status" },
  { value: "basis", label: "Email consent" },
];

const ALIASES: Record<string, Target> = {
  email: "email", "e-mail": "email", "email address": "email", "e-mail address": "email", "work email": "email", "business email": "email", mail: "email",
  name: "name", "full name": "name", "contact name": "name", contact: "name",
  "first name": "first_name", firstname: "first_name", first: "first_name", "given name": "first_name", "first_name": "first_name",
  "last name": "last_name", lastname: "last_name", last: "last_name", surname: "last_name", "family name": "last_name", "last_name": "last_name",
  title: "title", "job title": "title", position: "title", role: "title", "job role": "title",
  phone: "phone", "phone number": "phone", mobile: "phone", "mobile phone": "phone", telephone: "phone", "work phone": "phone",
  company: "company", "company name": "company", organization: "company", organisation: "company", account: "company", "account name": "company", employer: "company",
  website: "website", "company website": "website", domain: "website", "company domain": "website", "website url": "website", url: "website",
  country: "country", "country/region": "country", "country code": "country",
  state: "region", province: "region", region: "region", "state/region": "region", "state/province": "region",
  timezone: "timezone", "time zone": "timezone",
  lifecycle: "lifecycle", "lifecycle stage": "lifecycle", stage: "lifecycle",
  "lead status": "lead_status", status: "lead_status",
  consent: "basis", "email consent": "basis", basis: "basis", "lawful basis": "basis", "consent basis": "basis", "opt in": "basis", "opt-in": "basis",
  "marketing consent": "basis", "email opt in": "basis", "email opt-in": "basis", subscribed: "basis",
};

const norm = (s: string) => s.trim().toLowerCase().replace(/[_\s]+/g, " ").replace(/[^a-z0-9/ -]/g, "").trim();

/** The likely target for a column header, from common names and the workspace's custom fields. */
export function guessTarget(header: string, custom: CustomField[]): Target {
  const h = norm(header);
  const hit = ALIASES[h];
  if (hit) return hit;
  const field = custom.find((f) => norm(f.label) === h || f.key === h.replace(/[ -/]+/g, "_"));
  return field ? `f.${field.key}` : "skip";
}

// Values ------------------------------------------------------------------------------------------------------

const YES = new Set(["yes", "y", "true", "1"]);
const NO = new Set(["no", "n", "false", "0"]);

/** A custom field's value as stored, or undefined when the cell is blank or doesn't fit the type. */
export function customValue(f: CustomField, raw: string): string | number | boolean | undefined {
  const s = raw.trim();
  if (!s) return undefined;
  switch (f.type) {
    case "number": {
      const n = s.replace(/[,\s]/g, "");
      return /^-?\d+(\.\d+)?$/.test(n) ? Number(n) : undefined;
    }
    case "date": {
      const iso = /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
      const t = iso ? Date.parse(`${iso}T00:00:00Z`) : NaN;
      return Number.isNaN(t) ? undefined : iso!;
    }
    case "bool":
      return YES.has(s.toLowerCase()) ? true : NO.has(s.toLowerCase()) ? false : undefined;
    case "enum": {
      const o = optionsOf(f).find((x) => x.value.toLowerCase() === s.toLowerCase() || x.label.toLowerCase() === s.toLowerCase());
      return o?.value;
    }
    default:
      return s.slice(0, 500);
  }
}

const LIFECYCLE_WORDS: Record<string, string> = {
  subscriber: "subscriber", lead: "lead", mql: "mql", "marketing qualified lead": "mql", "marketingqualifiedlead": "mql", sql: "sql",
  "sales qualified lead": "sql", "salesqualifiedlead": "sql", opportunity: "opportunity", customer: "customer", evangelist: "evangelist", other: "other",
};

export const lifecycleOf = (raw: string): string | undefined => LIFECYCLE_WORDS[raw.trim().toLowerCase()];

// Country names in English, and the codes themselves, to ISO 3166-1 alpha-2.
const COUNTRY_ALIASES: Record<string, string> = {
  usa: "US", "u.s.": "US", "u.s.a.": "US", "united states of america": "US", america: "US", uk: "GB", "u.k.": "GB", england: "GB", scotland: "GB",
  wales: "GB", "great britain": "GB", "northern ireland": "GB", holland: "NL", "south korea": "KR", korea: "KR", russia: "RU", "czech republic": "CZ",
  deutschland: "DE", "españa": "ES", "the netherlands": "NL", uae: "AE", "hong kong": "HK", taiwan: "TW", vietnam: "VN",
};
// Codes Intl names that aren't countries today (old codes, groups, test codes).
const NOT_COUNTRIES = new Set("AA AN BU CS DD EU EZ FX NT QO QU SU TP UK UN XA XB YD YU ZR ZZ".split(" "));
let names: Map<string, string> | null = null;
function countryNames() {
  if (names) return names;
  names = new Map();
  const dn = new Intl.DisplayNames(["en"], { type: "region" });
  for (let a = 65; a <= 90; a++)
    for (let b = 65; b <= 90; b++) {
      const code = String.fromCharCode(a, b);
      const name = dn.of(code);
      if (name && name !== code && !NOT_COUNTRIES.has(code) && !/^Unknown/.test(name) && !names.has(name.toLowerCase())) names.set(name.toLowerCase(), code);
    }
  return names;
}

/** An ISO country code from a code or an English name, or undefined. */
export function countryCode(raw: string): string | undefined {
  const s = raw.trim();
  if (!s) return undefined;
  if (/^[A-Za-z]{2}$/.test(s)) {
    const code = s.toUpperCase();
    if (code === "UK") return "GB";
    return [...countryNames().values()].includes(code) ? code : undefined;
  }
  const k = s.toLowerCase();
  return COUNTRY_ALIASES[k] ?? countryNames().get(k);
}
