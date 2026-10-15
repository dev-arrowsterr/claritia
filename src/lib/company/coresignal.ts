// Coresignal company data by domain (Clean Company API, docs/m1-website-intelligence.md 7.3). Company data only.

export type Firmo = {
  name: string | null;
  employees: number | null;
  size: string | null;
  industry: string | null;
  country: string | null;
  founded: number | null;
  type: string | null;
};

const BANDS: [number, string][] = [[10, "1-10"], [50, "11-50"], [200, "51-200"], [500, "201-500"], [1000, "501-1,000"], [5000, "1,001-5,000"], [10000, "5,001-10,000"]];
export const sizeBand = (n: number | null): string | null => (n === null ? null : (BANDS.find(([max]) => n <= max)?.[1] ?? "10,001+"));

/* eslint-disable @typescript-eslint/no-explicit-any */
export function readCoresignal(d: any): Firmo {
  const employees = typeof d?.size_employees_count === "number" ? d.size_employees_count : typeof d?.size_employees_count_inferred === "number" ? d.size_employees_count_inferred : null;
  const founded = d?.founded ? parseInt(String(d.founded), 10) : NaN;
  return {
    name: typeof d?.name === "string" ? d.name.slice(0, 200) : null,
    employees,
    size: typeof d?.size_range === "string" && d.size_range ? d.size_range : sizeBand(employees),
    industry: typeof d?.industry === "string" ? d.industry.slice(0, 200) : null,
    country: typeof d?.location_hq_country_iso_2 === "string" ? d.location_hq_country_iso_2.toUpperCase() : null,
    founded: Number.isFinite(founded) && founded > 1600 && founded < 2100 ? founded : null,
    type: typeof d?.type === "string" ? d.type.slice(0, 60) : null,
  };
}

/** The company at a domain, or null when Coresignal doesn't know it. Throws on errors worth retrying. */
export async function enrichDomain(domain: string, opts: { apiKey?: string; fetcher?: typeof fetch }): Promise<Firmo | null> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (opts.apiKey) headers.apikey = opts.apiKey;
  const res = await (opts.fetcher ?? fetch)(`https://api.coresignal.com/cdapi/v2/company_clean/enrich?website=${encodeURIComponent(domain)}`, { headers, signal: AbortSignal.timeout(20_000) });
  if (res.status === 404) return null;
  if (res.status === 429 || res.status === 402) throw Object.assign(new Error(`Coresignal ${res.status}`), { retryAfterS: 3600 });
  if (!res.ok) throw new Error(`Coresignal ${res.status}`);
  return readCoresignal(await res.json());
}
