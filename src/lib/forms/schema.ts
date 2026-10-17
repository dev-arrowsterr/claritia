// A form's fields and settings, checked the same way in the builder, on the public page and in the submit route
// (supabase/migrations/041_forms.sql). Answers are checked against the fields; mapped answers become a contact
// row for the same cleaning a file import uses.

export type FieldType = "text" | "email" | "phone" | "textarea" | "number" | "select" | "multi" | "checkbox" | "hidden";
export type FormField = {
  key: string;
  label: string;
  type: FieldType;
  required?: boolean;
  options?: string[];
  placeholder?: string;
  /** A contact field (email, first_name, title, f.<key>, …) or "" to keep the answer on the submission only. */
  maps_to?: string;
  /** Hidden fields: the value, or "utm_source" style names filled from the page. */
  value?: string;
};
export type ConsentMode = "checkbox" | "notice";
export type FormSettings = {
  submit_label?: string;
  success_message?: string;
  redirect_url?: string;
  consent?: ConsentMode;
  consent_text?: string;
  topic_id?: string;
  captcha?: boolean;
  color?: string;
};
export type Form = { id: string; workspace_id: string; name: string; fields: FormField[]; settings: FormSettings; status: "draft" | "live"; topic?: string | null };

export const FIELD_TYPES: { value: FieldType; label: string }[] = [
  { value: "text", label: "Text" },
  { value: "email", label: "Email" },
  { value: "phone", label: "Phone" },
  { value: "textarea", label: "Long text" },
  { value: "number", label: "Number" },
  { value: "select", label: "Dropdown" },
  { value: "multi", label: "Checkboxes" },
  { value: "checkbox", label: "One checkbox" },
  { value: "hidden", label: "Hidden" },
];

// Contact fields a form answer can fill. Custom fields come as f.<key>.
export const MAPS_TO = ["email", "first_name", "last_name", "name", "title", "phone", "company", "website", "country", "region"] as const;
const KEY = /^[a-z][a-z0-9_]{0,39}$/;

export const DEFAULT_CONSENT = "I'd like to get emails. I can unsubscribe at any time.";

/** Problems with a form's definition, for the builder. Empty means it can be saved. */
export function formProblems(name: string, fields: FormField[], s: FormSettings): string[] {
  const out: string[] = [];
  if (!name.trim()) out.push("Name the form.");
  if (!fields.length) out.push("Add a field.");
  if (fields.length > 50) out.push("Up to 50 fields.");
  const keys = new Set<string>();
  const maps = new Set<string>();
  for (const f of fields) {
    if (!KEY.test(f.key)) out.push(`"${f.label || f.key}" needs a key of lowercase letters, numbers and _.`);
    if (keys.has(f.key)) out.push(`Two fields use the key ${f.key}.`);
    keys.add(f.key);
    if (f.type !== "hidden" && !f.label.trim()) out.push(`Label the ${f.key} field.`);
    if ((f.type === "select" || f.type === "multi") && !(f.options ?? []).filter((o) => o.trim()).length) out.push(`Give ${f.label || f.key} some choices.`);
    if (f.maps_to) {
      if (maps.has(f.maps_to)) out.push(`Two fields fill ${f.maps_to}.`);
      maps.add(f.maps_to);
    }
  }
  const email = fields.filter((f) => f.maps_to === "email");
  if (email.length !== 1 || email[0].type !== "email") out.push("Add one Email field that fills the contact's email.");
  if (s.redirect_url && !/^https:\/\/[^\s]+$/i.test(s.redirect_url)) out.push("The redirect must start with https://.");
  if (s.color && !/^#[0-9a-f]{6}$/i.test(s.color)) out.push("Pick a color like #266DF0.");
  return [...new Set(out)];
}

/** The fields as stored, minus anything malformed (the public page and the submit route read through this). */
export function cleanFields(raw: unknown): FormField[] {
  if (!Array.isArray(raw)) return [];
  const types = new Set(FIELD_TYPES.map((t) => t.value));
  return raw
    .filter((f): f is FormField => !!f && typeof f === "object" && typeof f.key === "string" && KEY.test(f.key) && types.has(f.type))
    .slice(0, 50)
    .map((f) => ({
      key: f.key,
      label: String(f.label ?? "").slice(0, 200),
      type: f.type,
      required: !!f.required,
      options: Array.isArray(f.options) ? f.options.map((o) => String(o).slice(0, 200)).filter(Boolean).slice(0, 100) : undefined,
      placeholder: f.placeholder ? String(f.placeholder).slice(0, 200) : undefined,
      maps_to: typeof f.maps_to === "string" && f.maps_to ? f.maps_to : undefined,
      value: f.value ? String(f.value).slice(0, 500) : undefined,
    }));
}

export type Answers = Record<string, string | string[] | boolean>;

/** Check answers against the fields. Returns the clean answers, or an error per field key. */
export function checkAnswers(fields: FormField[], input: Record<string, unknown>): { answers: Answers; errors: Record<string, string> } {
  const answers: Answers = {};
  const errors: Record<string, string> = {};
  for (const f of fields) {
    const v = input[f.key];
    if (f.type === "checkbox") {
      const on = v === true || v === "on" || v === "true" || v === "1";
      if (f.required && !on) errors[f.key] = "Required";
      answers[f.key] = on;
      continue;
    }
    if (f.type === "multi") {
      const picked = (Array.isArray(v) ? v : typeof v === "string" && v ? [v] : []).map(String).filter((x) => (f.options ?? []).includes(x));
      if (f.required && !picked.length) errors[f.key] = "Pick at least one";
      if (picked.length) answers[f.key] = picked;
      continue;
    }
    const s = typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "";
    if (!s) {
      if (f.required) errors[f.key] = "Required";
      continue;
    }
    const max = f.type === "textarea" ? 5000 : 500;
    if (s.length > max) {
      errors[f.key] = "Too long";
      continue;
    }
    if (f.type === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s)) errors[f.key] = "Enter a valid email";
    else if (f.type === "number" && !Number.isFinite(Number(s))) errors[f.key] = "Enter a number";
    else if (f.type === "phone" && !/^[+\d][\d\s().-]{5,30}$/.test(s)) errors[f.key] = "Enter a valid phone number";
    else if (f.type === "select" && !(f.options ?? []).includes(s)) errors[f.key] = "Pick one of the choices";
    else answers[f.key] = s;
  }
  return { answers, errors };
}

/** Mapped answers as one row for prepareImport: [targets, cells]. The consent basis rides as its own column. */
export function contactRow(fields: FormField[], answers: Answers, basis: "opt_in" | "legitimate_interest" | "none"): { targets: string[]; cells: string[] } {
  const targets: string[] = [];
  const cells: string[] = [];
  for (const f of fields) {
    if (!f.maps_to) continue;
    const v = answers[f.key];
    if (v === undefined || v === "") continue;
    targets.push(f.maps_to);
    cells.push(Array.isArray(v) ? v.join(";") : String(v));
  }
  targets.push("basis");
  cells.push(basis);
  return { targets, cells };
}

const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "gclid", "fbclid", "li_fat_id", "msclkid"];

/** The page context the embed sends: UTMs (latest and first touch), the page and the referrer, cleaned. */
export function cleanContext(raw: unknown): { utm: Record<string, string>; page_url: string | null; referrer: string | null } {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const utm: Record<string, string> = {};
  for (const src of [o.utm, o.first] as unknown[]) {
    if (!src || typeof src !== "object") continue;
    const first = src === o.first;
    for (const k of UTM_KEYS) {
      const v = (src as Record<string, unknown>)[k];
      if (typeof v === "string" && v.trim()) utm[first ? `first_${k}` : k] = v.trim().slice(0, 300);
    }
  }
  const url = (v: unknown) => (typeof v === "string" && /^https?:\/\//i.test(v) ? v.slice(0, 2000) : null);
  return { utm, page_url: url(o.page), referrer: url(o.referrer) };
}
