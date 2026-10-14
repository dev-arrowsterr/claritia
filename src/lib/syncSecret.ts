import "server-only";
import { timingSafeEqual } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

/** Whether a call comes from the database (pg_net), which sends the shared secret kept in app_config. */
export async function fromDatabase(sb: SupabaseClient, request: Request): Promise<boolean> {
  const { data } = await sb.from("app_config").select("value").eq("key", "github_sync_secret").maybeSingle<{ value: string }>();
  const want = Buffer.from(data?.value ?? "");
  const got = Buffer.from(request.headers.get("x-claritia-sync") ?? "");
  return want.length > 0 && want.length === got.length && timingSafeEqual(want, got);
}
