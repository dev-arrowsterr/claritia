// The region policy (docs/account-intelligence.md 3.2). Collect decides it for every request; the app shows it.
// Unknown places are treated as strict, so a missing geo file can only make Claritia collect less.

export type Region = "strict" | "notice" | "off";
export type ConsentState = "granted" | "denied" | "unknown";
export type Overrides = { strict?: string[]; off?: string[] };

export type Decision = {
  region: Region;
  /** full: device cookie and identity. cookieless: page counts only. off: nothing at all. */
  mode: "full" | "cookieless" | "off";
  /** Company match by IP. */
  lookup: boolean;
  /** What goes in sessions.policy. */
  label: "strict" | "notice" | "off" | "cookieless";
};

// EU, EEA, UK and Switzerland. Brazil's LGPD is treated the same (check).
const STRICT = new Set(
  "AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE IS LI NO GB CH BR".split(" "),
);
const STRICT_SUBDIVISIONS = new Set(["CA-QC"]);

/** `country` is ISO 3166-1 alpha-2, `subdivision` the ISO 3166-2 part after the dash (QC, CA). */
export function regionOf(country: string, subdivision: string, overrides: Overrides = {}): Region {
  const c = (country || "").toUpperCase();
  const cs = c && subdivision ? `${c}-${subdivision.toUpperCase()}` : "";
  const has = (list?: string[]) => !!list?.some((x) => x.toUpperCase() === c || (cs && x.toUpperCase() === cs));
  if (has(overrides.off)) return "off";
  // Canada without a province could be Quebec.
  if (!c || STRICT.has(c) || STRICT_SUBDIVISIONS.has(cs) || (c === "CA" && !subdivision) || has(overrides.strict)) return "strict";
  return "notice";
}

export function decide(input: {
  region: Region;
  consent: ConsentState;
  gpc: boolean;
  optedOut: boolean;
  dnt?: boolean;
  honorDnt?: boolean;
}): Decision {
  const { region, consent, gpc, optedOut } = input;
  if (region === "off" || optedOut) return { region, mode: "off", lookup: false, label: "off" };
  const dnt = !!input.dnt && !!input.honorDnt;
  if (region === "strict") {
    return consent === "granted" && !gpc && !dnt
      ? { region, mode: "full", lookup: true, label: "strict" }
      : { region, mode: "cookieless", lookup: false, label: "cookieless" };
  }
  if (consent === "denied" || dnt) return { region, mode: "cookieless", lookup: false, label: "cookieless" };
  // GPC in notice regions: no person, but the company can still count in the customer's own stats.
  if (gpc) return { region, mode: "cookieless", lookup: true, label: "cookieless" };
  return { region, mode: "full", lookup: true, label: "notice" };
}
