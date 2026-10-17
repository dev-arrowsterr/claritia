// How email and form activity reads in a CRM: one line for the title and a few for the detail. Shared by the
// HubSpot timeline (or notes) and Salesforce tasks.

import type { ActivityItem } from "./types.ts";

const LABEL: Record<string, string> = { "email.sent": "Email sent", "email.clicked": "Email clicked", "email.unsubscribed": "Unsubscribed", "form.submitted": "Form submitted" };

export function activityText(x: ActivityItem): { action: string; title: string; detail: string } {
  const action = LABEL[x.kind] ?? x.kind;
  if (x.kind === "form.submitted") {
    const answers = (x.data.answers ?? {}) as Record<string, unknown>;
    const detail = Object.entries(answers)
      .filter(([, v]) => v != null && v !== "")
      .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : String(v)}`)
      .join("\n");
    return { action, title: String(x.data.form_name ?? "Form"), detail: detail.slice(0, 2000) };
  }
  const title = x.subject ?? "Email";
  if (x.kind === "email.clicked") return { action, title, detail: String(x.data.url ?? "").slice(0, 500) };
  if (x.kind === "email.unsubscribed") return { action, title, detail: x.data.scope === "topic" ? "From this topic" : "From all email" };
  return { action, title, detail: "" };
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The same text as simple HTML, for a HubSpot note. */
export function activityHtml(x: ActivityItem): string {
  const t = activityText(x);
  return `<p><strong>${esc(t.action)}:</strong> ${esc(t.title)}</p>${t.detail ? `<p>${esc(t.detail).replace(/\n/g, "<br>")}</p>` : ""}<p>From Claritia</p>`;
}
