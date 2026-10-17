import { deps } from "@/lib/sources/run";
import { requireUser } from "@/lib/serverAuth";
import { serviceClient } from "@/lib/serviceClient";

// The CRM's users who can own a contact, for lead routing: GET ?workspaceId=. Every connected CRM that can list
// them, as [{ source, kind, owners: [{ id, label }] }].
export async function GET(request: Request) {
  const auth = await requireUser(request);
  if ("denied" in auth) return auth.denied;
  const ws = new URL(request.url).searchParams.get("workspaceId") ?? "";
  const { data: member } = await auth.sb.from("workspace_members").select("role").eq("workspace_id", ws).eq("user_id", auth.user.id).maybeSingle();
  if (!member) return Response.json({ error: "Workspace not found." }, { status: 404 });
  const db = serviceClient();
  if (!db) return Response.json({ error: "The server is not set up for this." }, { status: 500 });
  const { data: sources } = await db.from("sources").select("id, kind, name").eq("workspace_id", ws).in("kind", ["hubspot", "salesforce"]).neq("status", "disconnected");
  const out: { source: string; kind: string; owners: { id: string; label: string }[]; error?: string }[] = [];
  for (const s of sources ?? []) {
    try {
      const d = await deps({ rpc: (fn, args) => db.rpc(fn, args), clean: async () => ({ custom: [] }) }, s.id);
      if (!d?.connector.owners) continue;
      out.push({ source: s.name, kind: s.kind, owners: await d.connector.owners(d.ctx) });
    } catch (e) {
      out.push({ source: s.name, kind: s.kind, owners: [], error: /403|scope|permission/i.test(String((e as Error).message)) ? `Reconnect ${s.name} to list its owners.` : String((e as Error).message).slice(0, 200) });
    }
  }
  return Response.json({ crms: out });
}
