import { unseal } from "@/lib/seal";
import { hookUrl, isOwner } from "@/lib/sources/server";
import { requireUser } from "@/lib/serverAuth";
import { serviceClient } from "@/lib/serviceClient";

// A webhook source's URL, to paste into the tool: GET ?id=<source id>. Owners only (the URL carries its token).
export async function GET(request: Request) {
  const auth = await requireUser(request);
  if ("denied" in auth) return auth.denied;
  const id = new URL(request.url).searchParams.get("id") ?? "";
  if (!/^[0-9a-f-]{36}$/.test(id)) return Response.json({ error: "Source not found." }, { status: 404 });
  const { data: src } = await auth.sb.from("sources").select("workspace_id, kind").eq("id", id).maybeSingle();
  if (!src || !(await isOwner(auth.sb, auth.user.id, src.workspace_id))) return Response.json({ error: "Source not found." }, { status: 404 });
  const db = serviceClient();
  if (!db) return Response.json({ error: "The server is not set up for this." }, { status: 500 });
  const { data } = await db.from("source_secrets").select("hook_sealed").eq("source_id", id).maybeSingle();
  if (!data?.hook_sealed) return Response.json({ error: "Connect it again first." }, { status: 409 });
  const { token } = JSON.parse(unseal(data.hook_sealed)) as { token: string };
  return Response.json({ url: hookUrl(src.kind, id, token) });
}
