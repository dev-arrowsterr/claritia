import { readState } from "@/lib/github";
import { getInstallation, userCanReach, userToken } from "@/lib/githubApp";
import { serviceClient } from "@/lib/serviceClient";
import { APP_URL } from "@/lib/site";

/**
 * Where GitHub sends people back after installing the app. The installation joins the workspace in the state,
 * once GitHub confirms (through the person's own sign-in) that the person who installed it can reach it.
 */
export async function GET(request: Request) {
  const q = new URL(request.url).searchParams;
  const back = (error?: string) => Response.redirect(`${APP_URL}/settings${error ? `?github_error=${encodeURIComponent(error)}` : ""}`, 303);
  const installationId = Number(q.get("installation_id"));
  // Changing which repositories the app can reach comes back here with no state. Nothing to save.
  if (q.get("setup_action") === "update" && !q.get("state")) return back();
  const state = readState(q.get("state"), process.env.SECRETS_KEY?.trim() ?? "");
  if (!state) return back("The GitHub link ran out. Connect again from Settings.");
  const code = q.get("code");
  if (!installationId || !code) return back("GitHub didn't finish the install. Connect again from Settings.");
  const sb = serviceClient();
  if (!sb) return back("GitHub isn't set up on the server.");

  try {
    const token = await userToken(code);
    if (!(await userCanReach(token, installationId))) return back("Your GitHub account can't reach that installation.");
    const { data: member, error: memberErr } = await sb.from("workspace_members").select("user_id").eq("workspace_id", state.workspaceId).eq("user_id", state.userId).maybeSingle();
    if (memberErr) return back(`The server can't reach the database: ${memberErr.message}. Check SUPABASE_SECRET_KEY.`);
    if (!member) return back("Workspace not found.");
    const { data: existing, error: existingErr } = await sb.from("github_installations").select("workspace_id").eq("id", installationId).maybeSingle<{ workspace_id: string }>();
    if (existingErr) return back(existingErr.message);
    if (existing && existing.workspace_id !== state.workspaceId) return back("That GitHub account is connected to another Claritia workspace.");
    const inst = await getInstallation(installationId);
    const { error } = await sb.from("github_installations").upsert({ id: installationId, workspace_id: state.workspaceId, account_login: inst.account.login, account_type: inst.account.type, created_by: state.userId });
    if (error) return back(error.message);
    return back();
  } catch (e) {
    return back(e instanceof Error ? e.message : String(e));
  }
}
