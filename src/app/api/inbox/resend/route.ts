import { fetchReceived, firstInbox } from "@/lib/inbound";
import { serviceClient } from "@/lib/serviceClient";

const MAX_TEXT = 100_000;
const MAX_HTML = 300_000;
const KEEP_DAYS = 7;

/**
 * Resend's email.received webhook, for test inboxes. Anyone can post here, so only the email's id is read from
 * the body. The email itself is fetched from Resend with our key, then saved to the project its address belongs to.
 * A 200 tells Resend not to send it again, so mail that isn't ours also gets a 200.
 */
export async function POST(request: Request) {
  const apiKey = process.env.RESEND_API_KEY?.trim() ?? "";
  const admin = serviceClient();
  if (!apiKey || !admin) return Response.json({ error: "Inboxes aren't set up." }, { status: 503 });

  const event = (await request.json().catch(() => null)) as { type?: unknown; data?: { email_id?: unknown } } | null;
  const id = event?.data?.email_id;
  if (event?.type !== "email.received" || typeof id !== "string" || !/^[A-Za-z0-9-]{8,64}$/.test(id)) return Response.json({ ignored: true });

  let email;
  try {
    email = await fetchReceived(apiKey, id);
  } catch {
    return Response.json({ error: "Unknown email." }, { status: 400 });
  }
  const to = firstInbox(email.to, process.env.INBOX_DOMAIN?.trim() || "inbox.tryclaritia.com");
  if (!to) return Response.json({ ignored: true });
  const { data: project, error } = await admin.from("projects").select("id, workspace_id").eq("inbox_id", to.inboxId).maybeSingle();
  if (error) return Response.json({ error: error.message }, { status: 500 });
  if (!project) return Response.json({ ignored: true });

  // The same email posted twice is saved once.
  const { error: saveErr } = await admin.from("inbox_messages").upsert(
    {
      workspace_id: project.workspace_id,
      project_id: project.id,
      external_id: email.id,
      to_address: to.address,
      from_address: email.from.slice(0, 300),
      subject: email.subject.slice(0, 500),
      text_body: email.text.slice(0, MAX_TEXT),
      html_body: email.html.slice(0, MAX_HTML),
    },
    { onConflict: "external_id", ignoreDuplicates: true },
  );
  if (saveErr) return Response.json({ error: saveErr.message }, { status: 500 });

  // Test mail is only needed while a run waits for it. Keep a week, for the run pages.
  await admin
    .from("inbox_messages")
    .delete()
    .eq("project_id", project.id)
    .lt("received_at", new Date(Date.now() - KEEP_DAYS * 86_400_000).toISOString());
  return Response.json({ ok: true });
}
