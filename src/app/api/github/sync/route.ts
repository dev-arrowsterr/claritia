import { timingSafeEqual } from "node:crypto";
import { githubConfig } from "@/lib/githubApp";
import { syncChecks } from "@/lib/githubChecks";
import { serviceClient } from "@/lib/serviceClient";

/** The database calls this when a check's run finishes, and every minute while checks are open. */
export async function POST(request: Request) {
  const sb = serviceClient();
  if (!sb || !githubConfig()) return Response.json({ error: "GitHub isn't set up on the server." }, { status: 500 });
  const { data } = await sb.from("app_config").select("value").eq("key", "github_sync_secret").maybeSingle<{ value: string }>();
  const want = Buffer.from(data?.value ?? "");
  const got = Buffer.from(request.headers.get("x-claritia-sync") ?? "");
  if (!want.length || want.length !== got.length || !timingSafeEqual(want, got)) return Response.json({ error: "Not allowed." }, { status: 401 });
  const result = await syncChecks(sb);
  if (result.errors.length) console.error(`GitHub sync: ${result.errors.join(" | ")}`);
  return Response.json(result);
}
