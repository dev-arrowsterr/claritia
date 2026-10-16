import "server-only";
import { randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { appBase } from "../billing.ts";
import { seal } from "../seal.ts";
import { entryOf } from "./catalog.ts";
import { makeCtx } from "./ctx.ts";
import { connectorFor } from "./registry.ts";
import type { Creds, Settings, SourceRow } from "./types.ts";

// What the sources routes share: the owner check, and connecting a tool once its credentials are in hand.

export async function isOwner(sb: SupabaseClient, userId: string, ws: unknown): Promise<boolean> {
  if (typeof ws !== "string" || !/^[0-9a-f-]{36}$/.test(ws)) return false;
  const { data } = await sb.from("workspace_members").select("role").eq("workspace_id", ws).eq("user_id", userId).maybeSingle();
  return data?.role === "owner";
}

export const hookUrl = (kind: string, id: string, token?: string) => `${appBase()}/api/hooks/${kind}/${id}${token ? `?t=${token}` : ""}`;

/** Default settings for a new source of this kind. */
export function defaultSettings(kind: string): Settings {
  const e = entryOf(kind);
  const objects: Settings["objects"] = {};
  for (const o of e?.objects ?? []) objects[o] = o === "contacts" && e?.twoWay ? "both" : "in";
  return { objects, every_min: e?.group === "crm" ? 15 : 60, push_new: "lifecycle", basis: e?.group === "form" || e?.group === "event" ? "opt_in" : kind === "stripe" ? "soft_opt_in" : "legitimate_interest" };
}

const fakeRow = (ws: string, kind: string): SourceRow => ({ id: "", workspace_id: ws, kind, name: kind, account: null, status: "active", settings: {}, cursors: {}, push_cursor: null });

/**
 * Check the credentials work, save the source, and run the tool's one-time setup. Returns the source id.
 * `hookSecret` is a signing secret the person pasted (forms) or the tool gave back (Omniscient).
 */
export async function connectSource(db: SupabaseClient, o: { ws: string; user: string; kind: string; creds: Creds; settings?: Settings; hookSecret?: string | null }) {
  const c = connectorFor(o.kind);
  const e = entryOf(o.kind);
  if (!c || !e) throw new Error("Unknown tool.");
  let account = { id: "", label: e.label };
  const token = randomBytes(18).toString("base64url");
  if (o.creds.type !== "hook") account = await c.account(makeCtx({ source: fakeRow(o.ws, o.kind), creds: o.creds }));
  const settings = { ...defaultSettings(o.kind), ...(o.settings ?? {}) };
  const { data: id, error } = await db.rpc("source_connect", {
    p_ws: o.ws,
    p_user: o.user,
    p_kind: o.kind,
    p_name: e.label,
    p_account: account.id || account.label,
    p_sealed: seal(JSON.stringify(o.creds)),
    p_settings: settings,
    p_hook_sealed: seal(JSON.stringify({ token, secret: o.hookSecret ?? null })),
  });
  if (error) throw new Error(error.message);
  if (c.setup && o.creds.type !== "hook") {
    const extra = await c.setup(makeCtx({ source: { ...fakeRow(o.ws, o.kind), id: id as string }, creds: o.creds }), hookUrl(o.kind, id as string, token));
    // A tool that hands back a signing secret for the hooks it sends (Omniscient).
    if (extra?.hook_secret) await db.rpc("source_connect", { p_ws: o.ws, p_user: o.user, p_kind: o.kind, p_name: e.label, p_account: account.id || account.label, p_sealed: seal(JSON.stringify(o.creds)), p_settings: {}, p_hook_sealed: seal(JSON.stringify({ token, secret: extra.hook_secret })) });
  }
  return { id: id as string, token, label: account.label };
}
