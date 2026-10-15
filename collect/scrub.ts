// URL, text and prop scrubbing. claritia.js runs it in the browser and collect runs it again on the server,
// so an email, token or ID in a URL never reaches the database (docs/account-intelligence.md 3.3).

export const REMOVED = "[removed]";

const JWT = /eyJ[\w-]{4,}\.[\w-]{4,}\.[\w-]*/g;
const EMAIL = /[\w.+%'-]+@[\w-]+(\.[\w-]+)+/g;
const UUID = /[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}/gi;
// A run of letters and digits that mixes both, like a session id or a reset code. Slugs split on dashes, so
// "how-to-set-up-2026" stays.
const TOKEN = /[A-Za-z0-9]{16,}|[\w-]{32,}/g;
// Phone numbers and long numeric ids: 9 or more digits, with the usual separators.
const DIGITS = /\+?\d[\d\s().-]{6,}\d/g;
// Query keys that never leave, even when a site allows them.
const SECRET_KEY = /pass|secret|token|auth|session|sig|key|code|otp|email|phone|ssn|card/i;
// Params Claritia itself reads and strips (hop token, email link token).
const OWN = ["_clr_x", "clr"];

function tokenLike(s: string): boolean {
  const digits = (s.match(/\d/g) || []).length;
  // Dashed runs: random base64url mixes cases; slugs are lower case.
  if (/[-_]/.test(s)) return /[a-z]/.test(s) && /[A-Z]/.test(s) && digits >= 2;
  // Upper-case keys like AKIA... carry a single digit.
  return (digits >= 2 && (s.match(/[a-z]/gi) || []).length >= 2) || (digits >= 1 && s === s.toUpperCase());
}

/** Replaces anything that looks like an email, JWT, UUID, token or phone number. */
export function scrubText(s: string): string {
  return s
    .replace(JWT, REMOVED)
    .replace(EMAIL, REMOVED)
    .replace(UUID, REMOVED)
    .replace(TOKEN, (m) => (tokenLike(m) ? REMOVED : m))
    .replace(DIGITS, (m) => (m.replace(/\D/g, "").length >= 9 ? REMOVED : m));
}

function decode(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, " "));
  } catch {
    return s;
  }
}

/**
 * Cleans a URL. Drops the fragment and any user:password, replaces path segments that hold an email, token or ID,
 * keeps only allowed query keys (all non-secret keys when `allow` is null) and scrubs their values.
 * Returns path and query, or the full URL with `origin: true`. Returns "" for a URL that can't be read.
 */
export function scrubUrl(raw: string, opts: { base?: string; allow?: readonly string[] | null; origin?: boolean } = {}): string {
  let u: URL;
  try {
    u = new URL(raw, opts.base);
  } catch {
    return "";
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return "";
  const path = u.pathname
    .split("/")
    .map((seg) => (seg && scrubText(decode(seg)) !== decode(seg) ? REMOVED : seg))
    .join("/");
  const allow = opts.allow ? opts.allow.map((k) => k.toLowerCase()) : null;
  const kept: string[] = [];
  u.searchParams.forEach((v, k) => {
    const key = k.toLowerCase();
    if (OWN.includes(key) || SECRET_KEY.test(key) || (allow && !allow.includes(key)) || scrubText(key) !== key) return;
    const clean = scrubText(v).slice(0, 200);
    if (clean !== REMOVED) kept.push(encodeURIComponent(k) + "=" + encodeURIComponent(clean));
  });
  const out = (opts.origin ? u.origin : "") + path + (kept.length ? "?" + kept.join("&") : "");
  return out.slice(0, 2000);
}

/** True when a path falls under one of the patterns. `/account` covers `/account/x`; `*` matches anything. */
export function pathMatches(path: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => {
    if (!p) return false;
    const re = p
      .replace(/\/\*$/, "")
      .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*");
    return new RegExp("^" + re + "(/.*)?$", "i").test(path);
  });
}

/** Cleans `claritia.track()` props: flat strings, numbers and booleans, no secret keys, 2 KB at most. */
export function scrubProps(props: unknown): Record<string, string | number | boolean> | null {
  if (!props || typeof props !== "object" || Array.isArray(props)) return null;
  const out: Record<string, string | number | boolean> = {};
  let n = 0;
  for (const [k, v] of Object.entries(props as Record<string, unknown>)) {
    if (n >= 20 || SECRET_KEY.test(k) || scrubText(k) !== k || k.length > 40) continue;
    if (typeof v === "string") out[k] = scrubText(v).slice(0, 300);
    else if (typeof v === "boolean" || (typeof v === "number" && isFinite(v))) out[k] = v;
    else continue;
    n++;
  }
  return JSON.stringify(out).length <= 2048 ? out : null;
}
