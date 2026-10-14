import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { emailMessage, slackMessage, type AlertFailure, type AlertHeal } from "./alerts.ts";
import { unseal } from "./seal.ts";

type Event = { id: string; project_id: string; kind: "failure" | "heal"; run_id: string | null; heal_id: string | null; attempts: number };
type Settings = { project_id: string; slack_sealed: string | null; emails: string[] };
type RunRow = { id: string; test_name: string; environment_name: string; trigger: string; retry_of: string | null; verdict: AlertFailure["verdict"]; verdict_reason: string | null };

/** A failed delivery is tried again each minute, up to this many times. */
const MAX_ATTEMPTS = 5;
export const alertsFrom = () => process.env.ALERTS_FROM?.trim() || "Claritia <alerts@tryclaritia.com>";

export type Channels = { slack: string | null; emails: string[] };
export type Message = { project: string; failures: AlertFailure[]; heals: AlertHeal[] };

/** Send one project's alert to its Slack and email. Returns an error per channel that failed. */
export async function deliver(to: Channels, m: Message, fetchFn: typeof fetch = fetch): Promise<{ delivered: number; errors: string[] }> {
  const errors: string[] = [];
  let delivered = 0;
  if (to.slack) {
    const res = await fetchFn(to.slack, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(slackMessage(m.project, m.failures, m.heals)) }).catch((e: Error) => e);
    if (res instanceof Error) errors.push(`Slack: ${res.message}`);
    else if (!res.ok) errors.push(`Slack answered ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
    else delivered++;
  }
  if (to.emails.length) {
    const key = process.env.RESEND_API_KEY?.trim();
    if (!key) errors.push("Email: RESEND_API_KEY isn't set on the server.");
    else {
      const mail = emailMessage(m.project, m.failures, m.heals);
      const res = await fetchFn("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: alertsFrom(), to: to.emails, subject: mail.subject, html: mail.html, text: mail.text }),
      }).catch((e: Error) => e);
      if (res instanceof Error) errors.push(`Email: ${res.message}`);
      else if (!res.ok) errors.push(`Email answered ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
      else delivered++;
    }
  }
  return { delivered, errors };
}

export function channelsOf(s: Settings | undefined): Channels {
  let slack: string | null = null;
  if (s?.slack_sealed) {
    try {
      slack = unseal(s.slack_sealed);
    } catch {
      slack = null;
    }
  }
  return { slack, emails: s?.emails ?? [] };
}

/** Send every queued alert: one message per project, then mark the events sent. */
export async function sendAlerts(sb: SupabaseClient, fetchFn: typeof fetch = fetch): Promise<{ sent: number; errors: string[] }> {
  const errors: string[] = [];
  const { data, error } = await sb.from("alert_events").select("id, project_id, kind, run_id, heal_id, attempts").is("sent_at", null).order("created_at").limit(200);
  if (error) return { sent: 0, errors: [error.message] };
  const events = (data ?? []) as Event[];
  if (!events.length) return { sent: 0, errors };

  const projectIds = [...new Set(events.map((e) => e.project_id))];
  const runIds = events.map((e) => e.run_id).filter((x): x is string => !!x);
  const healIds = events.map((e) => e.heal_id).filter((x): x is string => !!x);
  const [settings, projects, runs, steps, heals] = await Promise.all([
    sb.from("alert_settings").select("project_id, slack_sealed, emails").in("project_id", projectIds),
    sb.from("projects").select("id, name").in("id", projectIds),
    runIds.length ? sb.from("runs").select("id, test_name, environment_name, trigger, retry_of, verdict, verdict_reason").in("id", runIds) : Promise.resolve({ data: [], error: null }),
    runIds.length ? sb.from("run_steps").select("run_id, position, label").in("run_id", runIds).eq("status", "failed") : Promise.resolve({ data: [], error: null }),
    healIds.length ? sb.from("heals").select("id, step_label, status, tests(name)").in("id", healIds) : Promise.resolve({ data: [], error: null }),
  ]);
  const loadErr = settings.error ?? projects.error ?? runs.error ?? steps.error ?? heals.error;
  if (loadErr) return { sent: 0, errors: [loadErr.message] };

  // A re-run alerts under the way its first run started.
  const runRows = (runs.data ?? []) as RunRow[];
  const parentIds = runRows.map((r) => r.retry_of).filter((x): x is string => !!x);
  const parents = new Map<string, string>();
  if (parentIds.length) {
    const { data: p } = await sb.from("runs").select("id, trigger").in("id", parentIds);
    for (const r of (p ?? []) as { id: string; trigger: string }[]) parents.set(r.id, r.trigger);
  }
  const stepRows = (steps.data ?? []) as { run_id: string; position: number; label: string }[];
  const healRows = (heals.data ?? []) as unknown as { id: string; step_label: string; status: string; tests: { name: string } | null }[];

  let sent = 0;
  for (const projectId of projectIds) {
    const mine = events.filter((e) => e.project_id === projectId);
    const failures: AlertFailure[] = mine
      .map((e) => runRows.find((r) => r.id === e.run_id))
      .filter((r): r is RunRow => !!r)
      .map((r) => {
        const step = stepRows.filter((s) => s.run_id === r.id).sort((a, b) => a.position - b.position)[0];
        return { runId: r.id, test: r.test_name, environment: r.environment_name, source: (r.retry_of && parents.get(r.retry_of)) || r.trigger, verdict: r.verdict, reason: r.verdict_reason, failedStep: step ? { position: step.position, label: step.label } : null };
      });
    // A fix someone already decided on needs no alert.
    const pendingHeals: AlertHeal[] = mine
      .map((e) => healRows.find((h) => h.id === e.heal_id))
      .filter((h): h is (typeof healRows)[number] => !!h && h.status === "pending")
      .map((h) => ({ healId: h.id, test: h.tests?.name ?? "Test", stepLabel: h.step_label }));
    const ids = mine.map((e) => e.id);
    const now = new Date().toISOString();
    const channels = channelsOf(((settings.data ?? []) as Settings[]).find((s) => s.project_id === projectId));

    if ((!failures.length && !pendingHeals.length) || (!channels.slack && !channels.emails.length)) {
      await sb.from("alert_events").update({ sent_at: now }).in("id", ids);
      continue;
    }
    const name = ((projects.data ?? []) as { id: string; name: string }[]).find((p) => p.id === projectId)?.name ?? "Claritia";
    const result = await deliver(channels, { project: name, failures, heals: pendingHeals }, fetchFn);
    const attempts = Math.max(...mine.map((e) => e.attempts)) + 1;
    const error = result.errors.join(" | ").slice(0, 500) || null;
    if (result.errors.length) errors.push(`${name}: ${error}`);
    // Sent once any channel took it, so a working channel never gets the same alert twice.
    if (result.delivered > 0 || attempts >= MAX_ATTEMPTS) {
      await sb.from("alert_events").update({ sent_at: now, attempts, error }).in("id", ids);
      if (result.delivered > 0) sent++;
    } else {
      await sb.from("alert_events").update({ attempts, error }).in("id", ids);
    }
  }
  return { sent, errors };
}
