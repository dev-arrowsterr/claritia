import { channelsOf, deliver } from "@/lib/alertSender";
import { SLACK_WEBHOOK } from "@/lib/alerts";
import { seal } from "@/lib/seal";
import { requireUser } from "@/lib/serverAuth";
import { serviceClient } from "@/lib/serviceClient";

/**
 * Save a project's alerts: { projectId, emails, onFailure, onHeal, slackUrl? }. slackUrl null removes Slack; leaving
 * it out keeps the saved one. The Slack address is sealed before it's saved. With { projectId, test: true }, sends a
 * sample alert to the saved Slack and emails.
 */
export async function POST(request: Request) {
  const auth = await requireUser(request);
  if ("denied" in auth) return auth.denied;
  const body = (await request.json().catch(() => ({}))) as { projectId?: unknown; emails?: unknown; onFailure?: unknown; onHeal?: unknown; slackUrl?: unknown; test?: unknown };
  const bad = (error: string, status = 400) => Response.json({ error }, { status });
  if (typeof body.projectId !== "string") return bad("Missing project.");

  if (body.test === true) {
    // The caller must be able to see the project; the server then reads its sealed Slack address.
    const { data: project } = await auth.sb.from("projects").select("id, name").eq("id", body.projectId).maybeSingle<{ id: string; name: string }>();
    if (!project) return bad("Project not found.", 404);
    const sb = serviceClient();
    if (!sb) return bad("The server is not set up for alerts.", 500);
    const { data: s } = await sb.from("alert_settings").select("project_id, slack_sealed, emails").eq("project_id", project.id).maybeSingle();
    const to = channelsOf(s ?? undefined);
    if (!to.slack && !to.emails.length) return bad("Add a Slack address or an email first.");
    const sample = { runId: "00000000-0000-0000-0000-000000000000", test: "Sample test", environment: "staging", source: "schedule", verdict: "app_bug" as const, reason: "This is a test alert from Claritia.", failedStep: { position: 2, label: "Check: It says saved" } };
    const result = await deliver(to, { project: project.name, failures: [sample], heals: [] });
    return result.errors.length ? bad(result.errors.join(" ")) : Response.json({ ok: true, delivered: result.delivered });
  }

  const emails = Array.isArray(body.emails) ? [...new Set(body.emails.map((e) => String(e).trim().toLowerCase()).filter(Boolean))] : [];
  if (emails.length > 20) return bad("Up to 20 emails.");
  let sealed: string | null = null;
  let hint: string | null = null;
  if (typeof body.slackUrl === "string" && body.slackUrl.trim()) {
    const url = body.slackUrl.trim();
    if (!SLACK_WEBHOOK.test(url)) return bad("That isn't a Slack webhook address. It starts with https://hooks.slack.com/.");
    try {
      sealed = seal(url);
    } catch (e) {
      return bad(e instanceof Error ? e.message : String(e), 500);
    }
    hint = url.slice(-4);
  }
  const { error } = await auth.sb.rpc("save_alert_settings", {
    p_project: body.projectId,
    p_emails: emails,
    p_on_failure: body.onFailure !== false,
    p_on_heal: body.onHeal !== false,
    p_slack_sealed: sealed,
    p_slack_hint: hint,
    p_clear_slack: body.slackUrl === null,
  });
  if (error) return bad(error.message);
  return Response.json({ ok: true });
}
