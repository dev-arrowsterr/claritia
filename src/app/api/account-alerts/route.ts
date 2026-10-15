import { SLACK_WEBHOOK } from "@/lib/alerts";
import { seal, unseal } from "@/lib/seal";
import { requireUser } from "@/lib/serverAuth";
import { serviceClient } from "@/lib/serviceClient";
import { parseRule, slackAccountMessage } from "@/lib/web/accountAlerts";

const bad = (error: string, status = 400) => Response.json({ error }, { status });

async function member(auth: Exclude<Awaited<ReturnType<typeof requireUser>>, { denied: Response }>, workspaceId: unknown) {
  if (typeof workspaceId !== "string") return false;
  const { data } = await auth.sb.from("workspace_members").select("role").eq("workspace_id", workspaceId).eq("user_id", auth.user.id).maybeSingle();
  return !!data;
}

/**
 * Account alert rules. { workspaceId, rule, slackUrl, dailyCap? } adds one (the Slack address is sealed first).
 * { workspaceId, ruleId, test: true } sends a sample to that rule's Slack.
 */
export async function POST(request: Request) {
  const auth = await requireUser(request);
  if ("denied" in auth) return auth.denied;
  const body = (await request.json().catch(() => ({}))) as { workspaceId?: unknown; rule?: unknown; slackUrl?: unknown; dailyCap?: unknown; ruleId?: unknown; test?: unknown };
  if (!(await member(auth, body.workspaceId))) return bad("Workspace not found.", 404);
  const sb = serviceClient();
  if (!sb) return bad("The server is not set up for alerts.", 500);

  if (body.test === true) {
    const { data: r } = await sb.from("account_alert_rules").select("rule, slack_sealed").eq("id", String(body.ruleId)).eq("workspace_id", body.workspaceId as string).maybeSingle();
    const rule = r ? parseRule(r.rule) : null;
    if (!r?.slack_sealed || !rule) return bad("Alert not found.", 404);
    const msg = slackAccountMessage({ id: "00000000-0000-0000-0000-000000000000", name: "Acme (sample)", domain: "acme.com", fit: 82, intent: 74, stage: "evaluating", why_now: "This week: 3 people read pricing, and checked security." }, rule);
    const res = await fetch(unseal(r.slack_sealed), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(msg) }).catch((e: Error) => e);
    if (res instanceof Error) return bad(`Slack: ${res.message}`);
    if (!res.ok) return bad(`Slack answered ${res.status}.`);
    return Response.json({ ok: true });
  }

  const rule = parseRule(body.rule);
  if (!rule) return bad("Pick when to alert.");
  const url = typeof body.slackUrl === "string" ? body.slackUrl.trim() : "";
  if (!SLACK_WEBHOOK.test(url)) return bad("That isn't a Slack webhook address. It starts with https://hooks.slack.com/.");
  const cap = Number(body.dailyCap ?? 10);
  if (!Number.isInteger(cap) || cap < 1 || cap > 100) return bad("Daily cap is 1 to 100.");
  let sealed: string;
  try {
    sealed = seal(url);
  } catch (e) {
    return bad(e instanceof Error ? e.message : String(e), 500);
  }
  const { count } = await sb.from("account_alert_rules").select("id", { count: "exact", head: true }).eq("workspace_id", body.workspaceId as string);
  if ((count ?? 0) >= 20) return bad("Up to 20 alerts.");
  const { data, error } = await sb
    .from("account_alert_rules")
    .insert({ workspace_id: body.workspaceId, user_id: auth.user.id, rule, channel: "slack", daily_cap: cap, slack_sealed: sealed, slack_hint: url.slice(-4) })
    .select("id")
    .single();
  if (error) return bad(error.message);
  await sb.from("audit_log").insert({ workspace_id: body.workspaceId, actor: auth.user.id, action: "account_alert.add", target: data.id });
  return Response.json({ ok: true, id: data.id });
}

/** { workspaceId, ruleId } removes a rule. */
export async function DELETE(request: Request) {
  const auth = await requireUser(request);
  if ("denied" in auth) return auth.denied;
  const body = (await request.json().catch(() => ({}))) as { workspaceId?: unknown; ruleId?: unknown };
  if (!(await member(auth, body.workspaceId))) return bad("Workspace not found.", 404);
  const sb = serviceClient();
  if (!sb) return bad("The server is not set up for alerts.", 500);
  const { error } = await sb.from("account_alert_rules").delete().eq("id", String(body.ruleId)).eq("workspace_id", body.workspaceId as string);
  if (error) return bad(error.message);
  await sb.from("audit_log").insert({ workspace_id: body.workspaceId, actor: auth.user.id, action: "account_alert.remove", target: String(body.ruleId) });
  return Response.json({ ok: true });
}
