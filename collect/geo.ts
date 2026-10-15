// Country (and region and city when the file has them) from a local MaxMind-format file, plus the network the
// visitor is on. The full IP stays in memory for this request only.

import { isIP } from "node:net";
import { existsSync, renameSync, statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import maxmind, { type Reader } from "maxmind";

export type Geo = { country: string; subdivision: string; city: string; asn: number | null };
export const NO_GEO: Geo = { country: "", subdivision: "", city: "", asn: null };

/** Strips the IPv4-mapped prefix. Returns "" for anything that isn't an IP. */
export function cleanIp(ip: string | null | undefined): string {
  const s = (ip ?? "").trim().replace(/^::ffff:(?=\d+\.)/i, "");
  return isIP(s) ? s : "";
}

/** The /24 (IPv4) or /48 (IPv6) network, as Postgres cidr text. */
export function ipNet(ip: string): string | null {
  const v = isIP(ip);
  if (v === 4) return ip.split(".").slice(0, 3).join(".") + ".0/24";
  if (v !== 6) return null;
  // Expand :: to get the first three groups.
  const [head, tail = ""] = ip.toLowerCase().split("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const groups = ip.includes("::") ? [...h, ...Array(8 - h.length - t.length).fill("0"), ...t] : h;
  if (groups.length !== 8) return null;
  return groups.slice(0, 3).map((g) => parseInt(g || "0", 16).toString(16)).join(":") + "::/48";
}

/* eslint-disable @typescript-eslint/no-explicit-any */
/** Works with MaxMind GeoLite2/GeoIP2 files and IPinfo's mmdb files. */
export function readRecord(r: any): Geo {
  if (!r) return NO_GEO;
  // MaxMind: country.iso_code. IPinfo Lite: country_code (country is the name). Older IPinfo files: country is the code.
  const country = r.country_code ?? r.country?.iso_code ?? (typeof r.country === "string" && r.country.length === 2 ? r.country : "");
  const subdivision = r.subdivisions?.[0]?.iso_code ?? r.region_code ?? "";
  const city = r.city?.names?.en ?? (typeof r.city === "string" ? r.city : "");
  const asnRaw = r.autonomous_system_number ?? r.asn;
  const asn = typeof asnRaw === "number" ? asnRaw : typeof asnRaw === "string" ? parseInt(asnRaw.replace(/^AS/i, ""), 10) || null : null;
  return { country: String(country).toUpperCase().slice(0, 2), subdivision: String(subdivision).toUpperCase(), city: String(city).slice(0, 100), asn };
}

export type GeoLookup = (ip: string) => Geo;

/** Opens the geo file. With no file every lookup is empty, which the policy treats as strict. */
export async function openGeo(path?: string): Promise<GeoLookup> {
  if (!path || !existsSync(path)) return () => NO_GEO;
  const reader: Reader<any> = await maxmind.open(path);
  return (ip) => {
    try {
      return ip ? readRecord(reader.get(ip)) : NO_GEO;
    } catch {
      return NO_GEO;
    }
  };
}

/**
 * IPinfo Lite (country and network, CC BY-SA 4.0, credit IPinfo), downloaded with the account token and refreshed
 * daily. Lookups use the newest file; until the first download lands, they're empty (strict).
 */
export async function ipinfoGeo(opts: { token: string; path: string; refreshMs?: number; log?: (msg: string, extra?: Record<string, unknown>) => void; fetcher?: typeof fetch }): Promise<GeoLookup> {
  const log = opts.log ?? (() => {});
  let current: GeoLookup = () => NO_GEO;
  const load = async () => {
    try {
      const fresh = existsSync(opts.path) && Date.now() - statSync(opts.path).mtimeMs < (opts.refreshMs ?? 86400_000);
      if (!fresh) {
        const res = await (opts.fetcher ?? fetch)(`https://ipinfo.io/data/ipinfo_lite.mmdb?token=${encodeURIComponent(opts.token)}`, { signal: AbortSignal.timeout(120_000) });
        if (!res.ok) throw new Error(`download failed: ${res.status}`);
        const tmp = `${opts.path}.part`;
        await writeFile(tmp, Buffer.from(await res.arrayBuffer()));
        renameSync(tmp, opts.path);
      }
      current = await openGeo(opts.path);
      log("geo loaded", { bytes: statSync(opts.path).size });
    } catch (e) {
      // Keep the last good file. A bad download never empties the lookup.
      log("geo load failed", { error: String((e as Error).message ?? e) });
    }
  };
  // Don't hold up startup for long: until the file is in, visitors count as strict.
  await Promise.race([load(), new Promise((r) => setTimeout(r, 15_000))]);
  setInterval(() => void load(), opts.refreshMs ?? 86400_000).unref();
  return (ip) => current(ip);
}
