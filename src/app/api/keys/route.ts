import { makeKey } from "@/lib/apiKeys";
import { requireUser } from "@/lib/serverAuth";

/** Make an API key for a workspace. The key comes back once; only its hash is kept. */
export async function POST(request: Request) {
  const auth = await requireUser(request);
  if ("denied" in auth) return auth.denied;
  const body = (await request.json().catch(() => ({}))) as { workspaceId?: unknown; name?: unknown };
  if (typeof body.workspaceId !== "string") return Response.json({ error: "Missing workspace." }, { status: 400 });
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name || name.length > 60) return Response.json({ error: "Name the key (up to 60 characters)." }, { status: 400 });

  const { key, hash, prefix } = makeKey();
  const { data: id, error } = await auth.sb.rpc("create_api_key", { p_workspace: body.workspaceId, p_name: name, p_prefix: prefix, p_hash: hash });
  if (error) return Response.json({ error: error.message }, { status: 400 });
  return Response.json({ id, key });
}
