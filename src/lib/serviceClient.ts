import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { supabaseUrl } from "./serverAuth";

/** A Supabase client with the secret key, for webhooks that no signed-in person makes. Null when it isn't set up. */
export function serviceClient(): SupabaseClient | null {
  const url = supabaseUrl();
  // SUPABASE_SERVICE_ROLE_KEY is the older name for the same key.
  const key = (process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY)?.trim();
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}
