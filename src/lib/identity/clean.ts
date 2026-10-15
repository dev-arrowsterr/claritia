// Identifier cleaning (docs/identity.md Part 6). The clean value is what matches; the raw value is kept as typed;
// the hash is for erasure and lookups.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { domainToASCII } from "node:url";
import FREE from "free-email-domains";

export type EmailClass = "work" | "free" | "role" | "own" | "partner";
export type Cleaned = { kind: "email" | "user" | "hubspot"; raw: string; clean: string; hash: Buffer; class: EmailClass | null; domain: string | null };
export type Rejected = { rejected: "invalid" | "disposable" | "blocked" };

const FREE_SET = new Set<string>(FREE as string[]);
// disposable-email-domains (CC0), refreshed by scripts/refresh-lists.
const DISPOSABLE = new Set(
  readFileSync(new URL("./lists/disposable.txt", import.meta.url), "utf8")
    .split("\n")
    .map((l) => l.trim().toLowerCase())
    .filter((l) => l && !l.startsWith("#")),
);
const ROLE = new Set(
  "sales info hello contact team support admin billing marketing office hr jobs careers press noreply no-reply accounts finance".split(" "),
);
const BLOCKED_IDS = new Set(["", "null", "undefined", "anonymous", "0", "none", "unknown", "nil", "guest", "[object object]"]);

// Provider rules (6.1): remove +tag everywhere but Yahoo, remove dots for Gmail, map alias domains.
const DOMAIN_MAP: Record<string, string> = { "googlemail.com": "gmail.com", "me.com": "icloud.com", "mac.com": "icloud.com", "protonmail.com": "proton.me" };
const NO_PLUS = new Set(["yahoo.com", "yahoo.co.uk", "yahoo.co.jp", "ymail.com", "rocketmail.com"]);
const NO_DOTS = new Set(["gmail.com"]);

export const hashOf = (clean: string) => createHash("sha256").update(clean).digest();

export function cleanEmail(raw: unknown, ws: { own_domains?: string[]; partner_domains?: string[] } = {}): Cleaned | Rejected {
  if (typeof raw !== "string") return { rejected: "invalid" };
  let s = raw.trim().replace(/^mailto:/i, "").replace(/^[<"']+|[>"']+$/g, "").trim().toLowerCase();
  if (s.length > 254 || /\s/.test(s)) return { rejected: "invalid" };
  const at = s.lastIndexOf("@");
  if (at < 1 || s.indexOf("@") !== at) return { rejected: "invalid" };
  let local = s.slice(0, at);
  let domain = domainToASCII(s.slice(at + 1).replace(/\.$/, ""));
  if (!domain || !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain) || local.length > 64 || !/^[^@\s]+$/.test(local)) return { rejected: "invalid" };
  domain = DOMAIN_MAP[domain] ?? domain;
  if (!NO_PLUS.has(domain)) local = local.split("+")[0];
  if (NO_DOTS.has(domain)) local = local.replace(/\./g, "");
  if (!local) return { rejected: "invalid" };
  if (DISPOSABLE.has(domain)) return { rejected: "disposable" };
  s = `${local}@${domain}`;
  const under = (list?: string[]) => !!list?.some((d) => domain === d.toLowerCase() || domain.endsWith("." + d.toLowerCase()));
  const cls: EmailClass = under(ws.own_domains)
    ? "own"
    : ROLE.has(local)
      ? "role"
      : under(ws.partner_domains)
        ? "partner"
        : FREE_SET.has(domain)
          ? "free"
          : "work";
  return { kind: "email", raw: raw.trim().slice(0, 320), clean: s, hash: hashOf(s), class: cls, domain };
}

export function cleanUser(raw: unknown): Cleaned | Rejected {
  const s = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw.trim() : "";
  if (BLOCKED_IDS.has(s.toLowerCase())) return { rejected: "blocked" };
  if (s.length > 128) return { rejected: "invalid" };
  return { kind: "user", raw: s, clean: s, hash: hashOf("user:" + s), class: null, domain: null };
}

export function cleanHubspot(raw: unknown): Cleaned | Rejected {
  const s = typeof raw === "string" || typeof raw === "number" ? String(raw).trim() : "";
  if (!/^\d{1,20}$/.test(s) || /^0+$/.test(s)) return { rejected: "invalid" };
  return { kind: "hubspot", raw: s, clean: s, hash: hashOf("hubspot:" + s), class: null, domain: null };
}

export function cleanIdentifier(kind: string, raw: unknown, ws: { own_domains?: string[]; partner_domains?: string[] } = {}): Cleaned | Rejected {
  if (kind === "email") return cleanEmail(raw, ws);
  if (kind === "user") return cleanUser(raw);
  if (kind === "hubspot") return cleanHubspot(raw);
  return { rejected: "invalid" };
}

export const isRejected = (c: Cleaned | Rejected): c is Rejected => "rejected" in c;
