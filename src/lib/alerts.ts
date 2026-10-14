// Alert messages for Slack and email: one message per project, listing real failures and fixes waiting for approval.

import { APP_URL } from "./site.ts";

export type AlertFailure = {
  runId: string;
  test: string;
  environment: string;
  /** How the run started: a schedule, a pull request (ci) or an API key. */
  source: string;
  verdict: "app_bug" | "flaky" | "setup" | null;
  reason: string | null;
  failedStep: { position: number; label: string } | null;
};
export type AlertHeal = { healId: string; test: string; stepLabel: string };

const MAX_ITEMS = 10;
const SOURCE: Record<string, string> = { schedule: "schedule", ci: "pull request", api: "API" };
const KIND: Record<string, string> = { app_bug: "App bug", flaky: "Failed again on re-run" };

export const runUrl = (id: string) => `${APP_URL}/runs/${id}`;
export const healUrl = (id: string) => `${APP_URL}/approvals/${id}`;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function alertTitle(project: string, failures: AlertFailure[], heals: AlertHeal[]): string {
  const parts: string[] = [];
  if (failures.length) parts.push(`${plural(failures.length, "test", "tests")} failed`);
  if (heals.length) parts.push(`${plural(heals.length, "fix", "fixes")} waiting for approval`);
  return `${project}: ${parts.join(", ")}`;
}

const why = (f: AlertFailure) => [f.verdict ? KIND[f.verdict] : "Failed", f.reason].filter(Boolean).join(": ");
const where = (f: AlertFailure) => `${f.environment}${SOURCE[f.source] ? `, ${SOURCE[f.source]}` : ""}`;
const slackText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** A Slack incoming-webhook message (Block Kit). */
export function slackMessage(project: string, failures: AlertFailure[], heals: AlertHeal[]) {
  const title = alertTitle(project, failures, heals);
  const blocks: Record<string, unknown>[] = [{ type: "section", text: { type: "mrkdwn", text: `*${slackText(title)}*` } }];
  for (const f of failures.slice(0, MAX_ITEMS)) {
    const lines = [`*${slackText(f.test)}*  ·  ${slackText(where(f))}`, slackText(cut(why(f), 280))];
    if (f.failedStep) lines.push(`Step ${f.failedStep.position}: ${slackText(cut(f.failedStep.label, 200))}`);
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: lines.join("\n") },
      accessory: { type: "button", text: { type: "plain_text", text: "Open run" }, url: runUrl(f.runId) },
    });
  }
  for (const h of heals.slice(0, MAX_ITEMS)) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*${slackText(h.test)}*  ·  fix for "${slackText(cut(h.stepLabel, 200))}"` },
      accessory: { type: "button", style: "primary", text: { type: "plain_text", text: "Review fix" }, url: healUrl(h.healId) },
    });
  }
  const more = Math.max(0, failures.length - MAX_ITEMS) + Math.max(0, heals.length - MAX_ITEMS);
  if (more) blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: `And ${more} more in <${APP_URL}/runs|Claritia>.` }] });
  return { text: title, blocks };
}

const html = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The same alert as an email, in the brand's plain style: square boxes, one blue link color, no images. */
export function emailMessage(project: string, failures: AlertFailure[], heals: AlertHeal[]) {
  const subject = alertTitle(project, failures, heals);
  const font = "font-family:Geist,-apple-system,'Segoe UI',Roboto,Arial,sans-serif";
  const row = (title: string, sub: string, href: string, label: string) =>
    `<tr><td style="padding:14px 16px;border-top:1px solid #eaeaea;${font}">` +
    `<div style="font-size:14px;font-weight:600;color:#0c0c0b">${html(title)}</div>` +
    `<div style="font-size:13px;color:#6f6f6b;margin-top:4px;line-height:1.5">${sub}</div>` +
    `<div style="margin-top:8px"><a href="${html(href)}" style="font-size:13px;color:#266df0;text-decoration:none">${label} &rarr;</a></div></td></tr>`;
  const rows = [
    ...failures.slice(0, MAX_ITEMS).map((f) =>
      row(f.test, [html(where(f)), html(cut(why(f), 280)), f.failedStep ? html(`Step ${f.failedStep.position}: ${cut(f.failedStep.label, 200)}`) : ""].filter(Boolean).join("<br>"), runUrl(f.runId), "Open run"),
    ),
    ...heals.slice(0, MAX_ITEMS).map((h) => row(h.test, html(`A fix for "${cut(h.stepLabel, 200)}" is waiting for approval.`), healUrl(h.healId), "Review fix")),
  ];
  const more = Math.max(0, failures.length - MAX_ITEMS) + Math.max(0, heals.length - MAX_ITEMS);
  const body =
    `<div style="background:#fafafa;padding:24px 12px">` +
    `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #eaeaea;border-collapse:collapse">` +
    `<tr><td style="padding:16px;${font};font-size:15px;font-weight:600;color:#0c0c0b">${html(subject)}</td></tr>` +
    rows.join("") +
    (more ? `<tr><td style="padding:12px 16px;border-top:1px solid #eaeaea;${font};font-size:13px;color:#6f6f6b">And ${more} more in <a href="${APP_URL}/runs" style="color:#266df0">Claritia</a>.</td></tr>` : "") +
    `</table>` +
    `<div style="max-width:560px;margin:12px auto 0;${font};font-size:12px;color:#6f6f6b">Change alerts in <a href="${APP_URL}/settings" style="color:#6f6f6b">Settings</a>.</div></div>`;
  const text = [
    subject,
    "",
    ...failures.slice(0, MAX_ITEMS).map((f) => `${f.test} (${where(f)})\n${why(f)}${f.failedStep ? `\nStep ${f.failedStep.position}: ${f.failedStep.label}` : ""}\n${runUrl(f.runId)}\n`),
    ...heals.slice(0, MAX_ITEMS).map((h) => `${h.test}: a fix for "${h.stepLabel}" is waiting for approval.\n${healUrl(h.healId)}\n`),
    more ? `And ${more} more: ${APP_URL}/runs` : "",
    `Change alerts in Settings: ${APP_URL}/settings`,
  ].join("\n");
  return { subject, html: body, text };
}

/** A Slack incoming webhook address. */
export const SLACK_WEBHOOK = /^https:\/\/hooks\.slack\.com\/(services|workflows|triggers)\/[A-Za-z0-9/_-]+$/;
