import { readRecipient, verifyMailgun } from "@/lib/mailgun";
import { serviceClient } from "@/lib/serviceClient";

const MAX_TEXT = 100_000;
const MAX_HTML = 300_000;
const KEEP_DAYS = 7;

/**
 * Mail for test inboxes, forwarded by a Mailgun route. Saves it to the project the address belongs to,
 * where the runner reads it. 406 tells Mailgun not to try again; anything else but 200 makes it retry.
 */
export async function POST(request: Request) {
  const key = process.env.MAILGUN_SIGNING_KEY?.trim() ?? "";
  const admin = serviceClient();
  if (!key || !admin) return Response.json({ error: "Inboxes aren't set up." }, { status: 503 });

  const form = await request.formData().catch(() => null);
  const field = (k: string) => {
    const v = form?.get(k);
    return typeof v === "string" ? v : "";
  };
  if (!form || !verifyMailgun(key, field("timestamp"), field("token"), field("signature"))) return Response.json({ error: "Bad signature." }, { status: 401 });

  const to = readRecipient(field("recipient"), process.env.INBOX_DOMAIN?.trim() || "inbox.tryclaritia.com");
  if (!to) return Response.json({ error: "Not a Claritia inbox." }, { status: 406 });
  const { data: project, error } = await admin.from("projects").select("id, workspace_id").eq("inbox_id", to.inboxId).maybeSingle();
  if (error) return Response.json({ error: error.message }, { status: 500 });
  if (!project) return Response.json({ error: "No such inbox." }, { status: 406 });

  const { error: saveErr } = await admin.from("inbox_messages").insert({
    workspace_id: project.workspace_id,
    project_id: project.id,
    to_address: to.address,
    from_address: (field("from") || field("sender")).slice(0, 300),
    subject: field("subject").slice(0, 500),
    text_body: field("body-plain").slice(0, MAX_TEXT),
    html_body: field("body-html").slice(0, MAX_HTML),
  });
  if (saveErr) return Response.json({ error: saveErr.message }, { status: 500 });

  // Test mail is only needed while a run waits for it. Keep a week, for the run pages.
  await admin
    .from("inbox_messages")
    .delete()
    .eq("project_id", project.id)
    .lt("received_at", new Date(Date.now() - KEEP_DAYS * 86_400_000).toISOString());
  return Response.json({ ok: true });
}
