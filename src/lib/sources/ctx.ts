// What a connector gets to talk to its tool: JSON calls with retries, one call at a time with a gap between
// calls (half the tool's limit), a token refreshed before it expires and once more on a 401, and a stop when
// the job loses its lease.

import { oauthRefresh } from "./oauth.ts";
import { AuthError, RateLimited, type Creds, type Ctx, type SourceRow } from "./types.ts";

export type CtxOpts = {
  source: SourceRow;
  creds: Creds;
  /** Save refreshed tokens (sealed by the caller). */
  saveCreds?: (c: Creds) => Promise<void>;
  fetcher?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
  gapMs?: number;
  /** Tests only: reach local databases without TLS. */
  local?: boolean;
  /** Refresh a token; defaults to the tool's OAuth app. */
  refresh?: (refresh: string) => Promise<{ access: string; refresh: string | null; expiresAt: number }>;
};

const BACKOFF_S = [1, 5, 30];
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function makeCtx(o: CtxOpts): Ctx {
  const fetcher = o.fetcher ?? fetch;
  const sleep = o.sleep ?? wait;
  let creds = o.creds;
  let last = 0;

  async function refreshNow() {
    if (creds.type !== "oauth" || !creds.refresh) throw new AuthError("Sign in again: the tool turned the connection down.");
    const t = o.refresh ? await o.refresh(creds.refresh) : await oauthRefresh(o.source.kind, creds.refresh, fetcher);
    creds = { ...creds, access: t.access, refresh: t.refresh ?? creds.refresh, expiresAt: t.expiresAt };
    await o.saveCreds?.(creds);
  }

  async function token() {
    if (creds.type === "oauth") {
      if (creds.refresh && creds.expiresAt - 60_000 < Date.now()) await refreshNow();
      return (creds as { access: string }).access;
    }
    if (creds.type === "key") return creds.values.api_key ?? creds.values.token ?? "";
    return "";
  }

  async function api<T>(url: string, init: RequestInit & { auth?: boolean } = {}): Promise<T> {
    const { auth = true, ...rest } = init;
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      if (o.signal?.aborted) throw new Error("Stopped");
      const gap = (o.gapMs ?? 0) - (Date.now() - last);
      if (gap > 0) await sleep(gap);
      last = Date.now();
      const headers = new Headers(rest.headers);
      if (auth && !headers.has("authorization")) headers.set("authorization", `Bearer ${await token()}`);
      if (rest.body && typeof rest.body === "string" && !headers.has("content-type")) headers.set("content-type", "application/json");
      headers.set("accept", headers.get("accept") ?? "application/json");
      let res: Response;
      try {
        res = await fetcher(url, { ...rest, headers, signal: o.signal });
      } catch (e) {
        if (o.signal?.aborted) throw new Error("Stopped");
        if (attempt >= BACKOFF_S.length) throw e;
        await sleep(BACKOFF_S[attempt] * 1000);
        continue;
      }
      if (res.status === 401 && auth && creds.type === "oauth" && !refreshed) {
        refreshed = true;
        await refreshNow();
        continue;
      }
      if (res.status === 429 || res.status >= 500) {
        const after = Number(res.headers.get("retry-after"));
        if (attempt >= BACKOFF_S.length) {
          if (res.status === 429) throw new RateLimited("The tool's rate limit was hit; trying again later.", Number.isFinite(after) && after > 0 ? after : 60);
          throw new Error(`The tool answered ${res.status}; trying again later.`);
        }
        await sleep((Number.isFinite(after) && after > 0 ? Math.min(after, 60) : BACKOFF_S[attempt]) * 1000);
        continue;
      }
      const text = await res.text();
      let data: unknown = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = text;
      }
      if (res.status === 401 || res.status === 403) throw new AuthError(messageOf(data) ?? "Sign in again: the tool turned the connection down.");
      if (!res.ok) throw new Error(messageOf(data) ?? `The tool answered ${res.status}.`);
      return data as T;
    }
  }

  return {
    source: o.source,
    get creds() {
      return creds;
    },
    api,
    token,
    secret: (name) => (creds.type === "key" ? (creds.values[name] ?? "") : creds.type === "oauth" ? (creds.extra?.[name] ?? "") : ""),
    signal: o.signal,
    local: o.local,
  };
}

function messageOf(d: unknown): string | null {
  if (!d || typeof d !== "object") return typeof d === "string" && d.length < 300 ? d : null;
  if (Array.isArray(d)) return messageOf(d[0]);
  const o = d as Record<string, unknown>;
  for (const k of ["message", "detail", "error_description", "title", "error"]) {
    const v = o[k];
    if (typeof v === "string" && v) return v.slice(0, 300);
    if (v && typeof v === "object") {
      const m = messageOf(v);
      if (m) return m;
    }
  }
  if (Array.isArray(o.errors)) return messageOf(o.errors[0]);
  return null;
}

/** Query string from an object, dropping empty values. */
export const qs = (o: Record<string, string | number | boolean | null | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v != null && v !== "") p.set(k, String(v));
  return p.toString();
};

/** A cursor saved as JSON. */
export const readCursor = <T>(c: string | null, empty: T): T => {
  if (!c) return empty;
  try {
    return { ...empty, ...(JSON.parse(c) as T) };
  } catch {
    return empty;
  }
};
