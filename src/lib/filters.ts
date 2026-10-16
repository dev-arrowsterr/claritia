// The filter bar's filters (docs/conversion-parity.md Part 6): a field, a condition and values. Visitors and Accounts
// filter the rows they loaded with matches() here; Contacts filters in the database with contacts_where
// (supabase/migrations/033_contacts.sql), which gives every condition the same meaning.

export type FieldType = "text" | "enum" | "number" | "date" | "bool" | "multi" | "link";
export type Op = "is" | "is_not" | "contains" | "empty" | "not_empty" | "gte" | "lte" | "within" | "before";
export type Filter = { field: string; op: Op; values: string[] };
export type Choice = { value: string; label: string };

export type FilterField<R = never> = {
  key: string;
  label: string;
  type: FieldType;
  options?: Choice[];
  /** Read the field from a row, for screens that filter in the browser. */
  get?: (row: R) => unknown;
  /** Shown after a number, like "min". */
  unit?: string;
};

export const OPS: Record<FieldType, Op[]> = {
  text: ["contains", "is", "is_not", "empty", "not_empty"],
  enum: ["is", "is_not", "empty", "not_empty"],
  number: ["gte", "lte", "empty", "not_empty"],
  date: ["within", "before", "empty", "not_empty"],
  bool: ["is"],
  multi: ["is", "is_not", "empty", "not_empty"],
  link: ["is", "is_not", "empty", "not_empty"],
};

export const OP_LABEL: Record<Op, string> = {
  is: "is",
  is_not: "is not",
  contains: "contains",
  empty: "is empty",
  not_empty: "is not empty",
  gte: "at least",
  lte: "at most",
  within: "in the last",
  before: "more than",
};

export const needsValue = (op: Op) => op !== "empty" && op !== "not_empty";

const lower = (v: unknown) => String(v).toLowerCase();
const blank = (v: unknown) => v == null || v === "" || (Array.isArray(v) && v.length === 0);
const DAY = 86_400_000;

/** Whether one value passes one filter. Arrays (like a visit's pages) pass when any item does. */
export function matches(value: unknown, f: Filter, type: FieldType, now = Date.now()): boolean {
  if (f.op === "empty") return blank(value);
  if (f.op === "not_empty") return !blank(value);
  if (type === "multi" || type === "link") {
    const list = Array.isArray(value) ? value.map(String) : [];
    if (f.op === "is") return f.values.some((x) => list.includes(x));
    if (f.op === "is_not") return !f.values.some((x) => list.includes(x));
    return false;
  }
  if (Array.isArray(value) && type === "text") {
    if (f.op === "is_not") return value.every((v) => matches(v, f, type, now));
    return value.some((v) => matches(v, f, type, now));
  }
  const v0 = f.values[0] ?? "";
  switch (type) {
    case "text":
      if (f.op === "is") return value != null && f.values.some((x) => lower(value) === lower(x));
      if (f.op === "is_not") return value == null || f.values.every((x) => lower(value) !== lower(x));
      if (f.op === "contains") return value != null && f.values.some((x) => lower(value).includes(lower(x)));
      return false;
    case "enum":
      if (f.op === "is") return value != null && f.values.includes(String(value));
      if (f.op === "is_not") return value == null || !f.values.includes(String(value));
      return false;
    case "number": {
      if (value == null || value === "" || !/^-?\d+(\.\d+)?$/.test(v0)) return false;
      const n = Number(value);
      if (Number.isNaN(n)) return false;
      return f.op === "gte" ? n >= Number(v0) : f.op === "lte" ? n <= Number(v0) : false;
    }
    case "date": {
      if (value == null || value === "" || !/^\d{1,5}$/.test(v0)) return false;
      const t = new Date(value as string).getTime();
      if (Number.isNaN(t)) return false;
      const edge = now - Number(v0) * DAY;
      return f.op === "within" ? t >= edge : f.op === "before" ? t < edge : false;
    }
    case "bool":
      return f.op === "is" && !!value === (v0 === "true");
    default:
      return false;
  }
}

/** Rows that pass every filter. Filters on fields this screen doesn't have are ignored. */
export function applyFilters<R>(rows: R[], filters: Filter[], fields: FilterField<R>[], now = Date.now()): R[] {
  const active = filters.map((f) => ({ f, field: fields.find((x) => x.key === f.field) })).filter((x) => x.field?.get);
  if (!active.length) return rows;
  return rows.filter((r) => active.every(({ f, field }) => matches(field!.get!(r), f, field!.type, now)));
}

/** A filter as words, for its tag: "Lifecycle is Lead, Customer". */
export function describe(f: Filter, field: FilterField<never> | undefined): string {
  const label = field?.label ?? f.field;
  if (!needsValue(f.op)) return `${label} ${OP_LABEL[f.op]}`;
  if (field?.type === "bool") return `${label}: ${f.values[0] === "true" ? "Yes" : "No"}`;
  const shown = f.values.map((v) => field?.options?.find((o) => o.value === v)?.label ?? v).join(", ");
  if (f.op === "within" || f.op === "before") return `${label} ${OP_LABEL[f.op]} ${shown} days${f.op === "before" ? " ago" : ""}`;
  return `${label} ${OP_LABEL[f.op]} ${shown}${field?.unit ? ` ${field.unit}` : ""}`;
}

/** Filters read back from a saved view or the address, keeping only ones that fit these fields. */
export function cleanFilters(raw: unknown, fields: FilterField<never>[]): Filter[] {
  if (!Array.isArray(raw)) return [];
  const out: Filter[] = [];
  for (const x of raw.slice(0, 20)) {
    if (!x || typeof x !== "object") continue;
    const { field, op, values } = x as Record<string, unknown>;
    const def = fields.find((d) => d.key === field);
    if (!def || typeof op !== "string" || !OPS[def.type].includes(op as Op)) continue;
    const vals = Array.isArray(values) ? values.filter((v): v is string => typeof v === "string").slice(0, 50) : [];
    if (needsValue(op as Op) && !vals.length) continue;
    out.push({ field: def.key, op: op as Op, values: needsValue(op as Op) ? vals : [] });
  }
  return out;
}
