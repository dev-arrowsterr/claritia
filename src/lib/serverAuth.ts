import "server-only";
import { createClient, type SupabaseClient, type User } from "@supabase/supabase-js";

export const supabaseUrl = () => process.env.SUPABASE_URL?.trim().replace(/\/+$/, "") ?? "";

/**
 * Check the caller is signed in. Returns a Supabase client that acts as the caller,
 * so row level security decides what they can reach, or a Response to send back.
 */
export async function requireUser(request: Request): Promise<{ sb: SupabaseClient; user: User } | { denied: Response }> {
  const url = supabaseUrl();
  const key = process.env.SUPABASE_PUBLISHABLE_KEY?.trim();
  const deny = (error: string, status: number) => ({ denied: Response.json({ error }, { status }) });
  if (!url || !key) return deny("Supabase is not set up on the server.", 500);
  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) return deny("Please sign in again.", 401);
  const sb = createClient(url, key, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data } = await sb.auth.getUser(token);
  if (!data?.user) return deny("Please sign in again.", 401);
  return { sb, user: data.user };
}
