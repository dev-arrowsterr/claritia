// Email consent for contacts (docs/marketing-platform.md 9.1). Every contact carries a basis for email. In strict
// regions (the EU, EEA, UK and the others in src/lib/web/policy.ts, and anywhere unknown) only opt-in or soft opt-in
// count; any other basis is kept as "none", and the contact can't be emailed. Runs in the browser and on the server.

import { regionOf } from "../web/policy.ts";

export type Basis = "opt_in" | "soft_opt_in" | "legitimate_interest" | "none";

export const BASES: { value: Basis; label: string }[] = [
  { value: "opt_in", label: "Opted in" },
  { value: "soft_opt_in", label: "Existing customers" },
  { value: "legitimate_interest", label: "Legitimate interest" },
  { value: "none", label: "No basis" },
];

export const BASIS_LABEL: Record<Basis, string> = Object.fromEntries(BASES.map((b) => [b.value, b.label])) as Record<Basis, string>;

// Where an imported list came from. Bought or rented lists are refused (9.2).
export type ImportSource = "event" | "signups" | "customers" | "crm_export" | "partner" | "bought";
export const IMPORT_SOURCES: { value: ImportSource; label: string }[] = [
  { value: "signups", label: "Website or product signups" },
  { value: "event", label: "Event or webinar" },
  { value: "customers", label: "Customers" },
  { value: "crm_export", label: "Export from a CRM or other tool" },
  { value: "partner", label: "Partner, with their consent" },
  { value: "bought", label: "Bought or rented list" },
];

export const sourceRefused = (s: ImportSource) => s === "bought";

const WORDS: Record<string, Basis> = {
  opt_in: "opt_in", "opt in": "opt_in", "opt-in": "opt_in", optin: "opt_in", "opted in": "opt_in", "double opt-in": "opt_in", "double opt in": "opt_in",
  subscribed: "opt_in", yes: "opt_in", y: "opt_in", true: "opt_in", "1": "opt_in", granted: "opt_in", consented: "opt_in",
  soft_opt_in: "soft_opt_in", "soft opt-in": "soft_opt_in", "soft opt in": "soft_opt_in", customer: "soft_opt_in", "existing customer": "soft_opt_in",
  legitimate_interest: "legitimate_interest", "legitimate interest": "legitimate_interest", li: "legitimate_interest",
  none: "none", no: "none", n: "none", false: "none", "0": "none", unsubscribed: "none", "opted out": "none", "opt out": "none", "no basis": "none",
};

/** A basis from a spreadsheet cell, or null when the cell doesn't say. */
export function parseBasis(raw: unknown): Basis | null {
  if (typeof raw !== "string") return null;
  return WORDS[raw.trim().toLowerCase()] ?? null;
}

/** The basis that stands for a contact in this country. */
export function basisFor(country: string | null | undefined, basis: Basis): Basis {
  if (basis === "none") return "none";
  if (regionOf(country ?? "", "") === "strict" && basis !== "opt_in" && basis !== "soft_opt_in") return "none";
  return basis;
}
