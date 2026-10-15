import "server-only";
import { timingSafeEqual } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { unseal } from "../seal.ts";
import { appSecret } from "./oauth.ts";
import { connectorFor } from "./registry.ts";
import type { HookEvent, HookRequest } from "./types.ts";

// Webhooks in. Each delivery is checked (the URL's token, and the tool's signature when it signs), turned into
// events, and staged; the source_hook job applies them. Staging is all a hook does, so it answers fast and a
// delivery sent twice is kept once.

const MAX_BODY = 1_000_000;
const sameText = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

async function stage(db: SupabaseClient, source: string, events: HookEvent[]) {
  let n = 0;
  for (const e of events) {
    const { data, error } = await db.rpc("hook_stage", { p_source: source, p_dedupe: e.dedupe, p_body: e });
    if (error) throw new Error(error.message);
    if (data) n++;
  }
  return n;
}

export async function readHook(request: Request, publicUrl: string): Promise<HookRequest | Response> {
  const body = await request.text();
  if (body.length > MAX_BODY) return Response.json({ error: "Too large." }, { status: 413 });
  return { headers: request.headers, body, url: publicUrl, method: request.method.toUpperCase() };
}

const parseJson = (body: string): unknown => {
  try {
    return JSON.parse(body);
  } catch {
    // Forms that post url-encoded bodies.
    return Object.fromEntries(new URLSearchParams(body));
  }
};

/** A hook for one source: /api/hooks/<kind>/<source id>?t=<token>. */
export async function sourceHook(db: SupabaseClient, kind: string, id: string, req: HookRequest): Promise<Response> {
  const c = connectorFor(kind);
  if (!c?.parse || !/^[0-9a-f-]{36}$/.test(id)) return Response.json({ error: "Not found." }, { status: 404 });
  const { data: src } = await db.from("sources").select("kind, status").eq("id", id).maybeSingle();
  if (!src || src.kind !== kind || src.status === "disconnected") return Response.json({ error: "Not found." }, { status: 404 });
  const { data: sec } = await db.from("source_secrets").select("hook_sealed").eq("source_id", id).maybeSingle();
  if (!sec?.hook_sealed) return Response.json({ error: "Not found." }, { status: 404 });
  const { token, secret } = JSON.parse(unseal(sec.hook_sealed)) as { token: string; secret: string | null };
  const given = new URL(req.url).searchParams.get("t") ?? "";
  // The token in the URL, and the tool's signature too when it signs and a secret was given.
  if (!sameText(given, token) || (secret && c.verify && !c.verify(req, secret))) return Response.json({ error: "Not allowed." }, { status: 401 });
  const events = c.parse(parseJson(req.body), req.headers);
  const n = await stage(db, id, events);
  return Response.json({ ok: true, staged: n });
}

/** One hook for every account of a tool (HubSpot's app webhooks): /api/hooks/<kind>. */
export async function appHook(db: SupabaseClient, kind: string, req: HookRequest): Promise<Response> {
  const c = connectorFor(kind);
  if (!c?.parse || !c.verify) return Response.json({ error: "Not found." }, { status: 404 });
  if (!c.verify(req, appSecret(kind))) return Response.json({ error: "Not allowed." }, { status: 401 });
  const events = c.parse(parseJson(req.body), req.headers) as (HookEvent & { account?: string })[];
  const byAccount = new Map<string, HookEvent[]>();
  for (const e of events) byAccount.set(e.account ?? "", [...(byAccount.get(e.account ?? "") ?? []), e]);
  let n = 0;
  for (const [account, list] of byAccount) {
    if (!account) continue;
    const { data: ids } = await db.rpc("source_by_account", { p_kind: kind, p_account: account });
    for (const sid of (ids as string[] | null) ?? []) n += await stage(db, sid, list);
  }
  return Response.json({ ok: true, staged: n });
}
