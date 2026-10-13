import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export type SupaConfig = { url: string; key: string };

let client: SupabaseClient | null = null;

/** One Supabase client for the browser. Sessions are kept in this browser and refresh on their own. */
export function getSupabase({ url, key }: SupaConfig): SupabaseClient {
  client ??= createClient(url, key, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: "pkce" },
  });
  return client;
}
