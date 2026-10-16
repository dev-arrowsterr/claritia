import { formValues, newContact, writeContacts, type ContactForm } from "@/lib/contacts/contacts";
import { cleaningCtx, isMember } from "@/lib/contacts/server";
import { requireUser } from "@/lib/serverAuth";
import { serviceClient } from "@/lib/serviceClient";

// Add or edit one contact: POST { workspaceId, form } adds; POST { workspaceId, id, form } changes the keys in form.
// Emails are cleaned here, so the database functions stay server only.

const bad = (error: string, status = 400) => Response.json({ error }, { status });

export async function POST(request: Request) {
  const auth = await requireUser(request);
  if ("denied" in auth) return auth.denied;
  const body = (await request.json().catch(() => ({}))) as { workspaceId?: unknown; id?: unknown; form?: ContactForm };
  if (!(await isMember(auth, body.workspaceId))) return bad("Workspace not found.", 404);
  const ws = body.workspaceId as string;
  if (!body.form || typeof body.form !== "object") return bad("Nothing to save.");
  const sb = serviceClient();
  if (!sb) return bad("The server is not set up for this.", 500);
  const ctx = await cleaningCtx(sb, ws);

  if (body.id === undefined) {
    const made = newContact(body.form, ctx.custom, ctx);
    if ("error" in made) return bad(made.error);
    const taken = await sb.from("contacts").select("id").eq("workspace_id", ws).eq("email_clean", made.contact.email_clean).is("deleted_at", null).maybeSingle();
    if (taken.data) return bad("A contact with this email already exists.");
    try {
      const r = await writeContacts((fn, args) => sb.rpc(fn, args), ws, "manual", [made.contact]);
      return Response.json({ id: r.ids[0] });
    } catch (e) {
      return bad(e instanceof Error ? e.message : String(e), 500);
    }
  }

  if (typeof body.id !== "string" || !/^[0-9a-f-]{36}$/.test(body.id)) return bad("Contact not found.", 404);
  const owned = await sb.from("contacts").select("id").eq("id", body.id).eq("workspace_id", ws).is("deleted_at", null).maybeSingle();
  if (!owned.data) return bad("Contact not found.", 404);
  const r = formValues(body.form, ctx.custom, ctx);
  if ("error" in r) return bad(r.error);
  const { error } = await sb.rpc("contact_update", { p_id: body.id, p_source: "manual", p_values: r.values });
  if (error) return bad(error.message);
  return Response.json({ id: body.id });
}
