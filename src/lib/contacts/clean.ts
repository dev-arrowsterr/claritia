// Cleaning on the way in (docs/conversion-parity.md 4.7): phones to one format, names in Name Case, "Doe, Jane"
// split right, and a title's seniority and department by rules. Runs in the browser and on the server.

import { parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js";

/** A phone in E.164 (+15551234567) when it parses, with the contact's country as the hint; else as typed. */
export function cleanPhone(raw: string | undefined, country?: string): string | undefined {
  const s = raw?.trim();
  if (!s) return undefined;
  try {
    const p = parsePhoneNumberFromString(s, (country as CountryCode) || undefined);
    if (p?.isValid()) return p.number;
  } catch {}
  return s.slice(0, 50);
}

const SMALL = new Set(["van", "von", "de", "der", "den", "da", "di", "del", "la", "le", "du", "dos", "das", "bin", "ibn", "al"]);

/** "JANE" and "jane" become "Jane"; mixed case is kept as typed ("McDonald", "DeShawn"). */
export function nameCase(raw: string | undefined): string | undefined {
  const s = raw?.trim().replace(/\s+/g, " ");
  if (!s) return undefined;
  if (s !== s.toUpperCase() && s !== s.toLowerCase()) return s;
  return s
    .toLowerCase()
    .split(" ")
    .map((w, i) =>
      i > 0 && SMALL.has(w)
        ? w
        : w
            .split(/([-'’])/)
            .map((p) => (p.length > 1 || /[a-z]/.test(p) ? p[0].toUpperCase() + p.slice(1) : p))
            .join("")
            .replace(/^(Mc|O’|O')([a-z])/, (_, a: string, b: string) => a + b.toUpperCase()),
    )
    .join(" ");
}

/** A full name in one cell: "Jane Doe" or "Doe, Jane". */
export function splitName(full: string): { first?: string; last?: string } {
  const s = full.trim();
  if (!s) return {};
  const comma = /^([^,]+),\s*(.+)$/.exec(s);
  if (comma) return { first: comma[2].trim(), last: comma[1].trim() };
  const [first, ...rest] = s.split(/\s+/);
  return { first, last: rest.join(" ") || undefined };
}

export type Seniority = "C-level" | "VP" | "Director" | "Manager" | "Individual";
export type Department = "Marketing" | "Sales" | "Engineering" | "Product" | "Finance" | "HR" | "Operations" | "Other";

const SENIORITY: [RegExp, Seniority][] = [
  [/\b(ceo|cto|cfo|coo|cmo|cro|cio|ciso|cpo|chief|founder|co-?founder|owner|president|partner)\b/i, "C-level"],
  [/\b(vp|svp|evp|vice president|head of|gm|general manager)\b/i, "VP"],
  [/\b(director|dir\.)\b/i, "Director"],
  [/\b(manager|mgr|lead|team lead|supervisor)\b/i, "Manager"],
];
const DEPARTMENT: [RegExp, Department][] = [
  [/\b(marketing|growth|brand|demand|content|seo|cmo|communications|pr|social)\b/i, "Marketing"],
  [/\b(sales|account executive|ae|sdr|bdr|business development|revenue|cro|partnerships)\b/i, "Sales"],
  [/\b(engineer|engineering|developer|cto|devops|software|it|security|ciso|data|architect)\b/i, "Engineering"],
  [/\b(product|cpo|design|ux|ui)\b/i, "Product"],
  [/\b(finance|cfo|accounting|controller|procurement)\b/i, "Finance"],
  [/\b(hr|people|talent|recruit)/i, "HR"],
  [/\b(operations|ops|coo|customer success|support)\b/i, "Operations"],
];

/** Seniority and department from a title, or nothing when the rules don't know it. */
export function titleRole(title: string | undefined): { seniority?: Seniority; department?: Department } {
  const t = title?.trim();
  if (!t) return {};
  const seniority = SENIORITY.find(([re]) => re.test(t))?.[1] ?? "Individual";
  const department = DEPARTMENT.find(([re]) => re.test(t))?.[1];
  return { seniority, department };
}
