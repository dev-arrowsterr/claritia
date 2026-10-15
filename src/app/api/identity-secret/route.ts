import { randomBytes } from "node:crypto";
import { seal, unseal } from "@/lib/seal";
import { requireUser } from "@/lib/serverAuth";
import { serviceClient } from "@/lib/serviceClient";

// The identify secret signs claritia("identify", ...) calls (docs/identity.md 5.2). It is sealed in
// identity_settings.identify_secrets_sealed as {current, next}; the stitch job accepts both, so a rotation keeps
// yesterday's tokens working until the owner drops the old one.

const bad = (error: string, status = 400) => Response.json({ error }, { status });
type Secrets = { current?: string; next?: string };

async function owner(auth: Exclude<Awaited<ReturnType<typeof requireUser>>, { denied: Response }>, workspaceId: unknown) {
  if (typeof workspaceId !== "string" || !/^[0-9a-f-]{36}$/.test(workspaceId)) return false;
  const { data } = await auth.sb.from("workspace_members").select("role").eq("workspace_id", workspaceId).eq("user_id", auth.user.id).maybeSingle();
  return data?.role === "owner";
}

async function read(sb: NonNullable<ReturnType<typeof serviceClient>>, ws: string): Promise<Secrets> {
  const { data } = await sb.from("identity_settings").select("identify_secrets_sealed").eq("workspace_id", ws).maybeSingle();
  if (!data?.identify_secrets_sealed) return {};
  return JSON.parse(unseal(data.identify_secrets_sealed)) as Secrets;
}

/** ?workspaceId= shows the owner the current secret, and whether an old one still works. */
export async function GET(request: Request) {
  const auth = await requireUser(request);
  if ("denied" in auth) return auth.denied;
  const ws = new URL(request.url).searchParams.get("workspaceId");
  if (!(await owner(auth, ws))) return bad("Only the workspace owner can see this.", 403);
  const sb = serviceClient();
  if (!sb) return bad("The server is not set up for this.", 500);
  try {
    const s = await read(sb, ws!);
    return Response.json({ secret: s.current ?? null, old: !!s.next });
  } catch (e) {
    return bad(e instanceof Error ? e.message : String(e), 500);
  }
}

/** { workspaceId, action: "rotate" } makes a new secret and keeps the old one working. { action: "drop_old" } stops the old one. */
export async function POST(request: Request) {
  const auth = await requireUser(request);
  if ("denied" in auth) return auth.denied;
  const body = (await request.json().catch(() => ({}))) as { workspaceId?: unknown; action?: unknown };
  if (!(await owner(auth, body.workspaceId))) return bad("Only the workspace owner can change this.", 403);
  if (body.action !== "rotate" && body.action !== "drop_old") return bad("Unknown action.");
  const ws = body.workspaceId as string;
  const sb = serviceClient();
  if (!sb) return bad("The server is not set up for this.", 500);
  let sealed: string;
  let next: Secrets;
  try {
    const s = await read(sb, ws);
    next = body.action === "rotate" ? { current: randomBytes(36).toString("base64url"), next: s.current } : { current: s.current };
    sealed = seal(JSON.stringify(next));
  } catch (e) {
    return bad(e instanceof Error ? e.message : String(e), 500);
  }
  const { error } = await sb.from("identity_settings").upsert({ workspace_id: ws, identify_secrets_sealed: sealed, updated_at: new Date().toISOString() }, { onConflict: "workspace_id" });
  if (error) return bad(error.message);
  await sb.from("audit_log").insert({ workspace_id: ws, actor: auth.user.id, action: `identity.secret_${body.action}`, target: ws });
  return Response.json({ secret: next.current ?? null, old: !!next.next });
}
