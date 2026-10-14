import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { hashKey, keyFromHeader } from "./apiKeys";
import { serviceClient } from "./serviceClient";

export type ApiCaller = { sb: SupabaseClient; keyId: string; workspaceId: string };

/**
 * Check a request carries a working API key. Returns a server client and the key's workspace; every query a route
 * makes with it must filter by that workspace. Or a Response to send back.
 */
export async function requireKey(request: Request): Promise<ApiCaller | { denied: Response }> {
  const deny = (error: string, status: number) => ({ denied: Response.json({ error }, { status }) });
  const key = keyFromHeader(request.headers.get("authorization"));
  if (!key) return deny("Send an API key as 'Authorization: Bearer clr_...'. Make one in Settings.", 401);
  const sb = serviceClient();
  if (!sb) return deny("The server is not set up for API keys.", 500);
  const { data, error } = await sb.rpc("api_key_auth", { p_hash: hashKey(key) });
  if (error) return deny(error.message, 500);
  const row = (data as { key_id: string; workspace_id: string }[] | null)?.[0];
  if (!row) return deny("This API key is wrong or was revoked.", 401);
  return { sb, keyId: row.key_id, workspaceId: row.workspace_id };
}

export const isUuid = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

export type ApiProject = { id: string; name: string };

/** A project of the caller's workspace, by id or name. With no ref, the workspace's only project. */
export async function findProject(caller: ApiCaller, ref: unknown): Promise<ApiProject | { denied: Response }> {
  const deny = (error: string, status: number) => ({ denied: Response.json({ error }, { status }) });
  const { data, error } = await caller.sb.from("projects").select("id, name").eq("workspace_id", caller.workspaceId).order("created_at");
  if (error) return deny(error.message, 500);
  const projects = (data ?? []) as ApiProject[];
  if (ref === undefined || ref === null || ref === "") {
    if (projects.length === 1) return projects[0]!;
    return deny(projects.length ? `Pick a project: ${projects.map((p) => p.name).join(", ")}.` : "This workspace has no projects yet.", 400);
  }
  if (typeof ref !== "string") return deny("The project must be an id or a name.", 400);
  const want = ref.trim().toLowerCase();
  const found = projects.find((p) => p.id === ref.trim()) ?? projects.find((p) => p.name.toLowerCase() === want);
  return found ?? deny(`Project ${ref} not found.`, 404);
}
