import { signState } from "@/lib/github";
import { appSlug, githubConfig } from "@/lib/githubApp";
import { requireUser } from "@/lib/serverAuth";

/** The link that installs the Claritia GitHub App, carrying who's connecting which workspace. */
export async function POST(request: Request) {
  const auth = await requireUser(request);
  if ("denied" in auth) return auth.denied;
  const key = process.env.SECRETS_KEY?.trim() ?? "";
  if (!githubConfig() || !key) return Response.json({ error: "GitHub isn't set up on the server." }, { status: 500 });
  const body = (await request.json().catch(() => ({}))) as { workspaceId?: unknown };
  if (typeof body.workspaceId !== "string") return Response.json({ error: "Missing workspace." }, { status: 400 });
  const { data: member } = await auth.sb.from("workspace_members").select("user_id").eq("workspace_id", body.workspaceId).eq("user_id", auth.user.id).maybeSingle();
  if (!member) return Response.json({ error: "Workspace not found." }, { status: 404 });
  try {
    const state = signState({ workspaceId: body.workspaceId, userId: auth.user.id }, key);
    return Response.json({ url: `https://github.com/apps/${await appSlug()}/installations/new?state=${encodeURIComponent(state)}` });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
