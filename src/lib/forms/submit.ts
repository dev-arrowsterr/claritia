// A form's answers, start to finish (docs/marketing-platform.md M6). Shared by the submit route and the tests.
// Spam checks first: a filled hidden field or a post in the first 2 seconds is kept as spam and answered like a
// success, so a bot learns nothing; a missing or stale page token and a failed Turnstile check are refused. Then the
// answers are checked, the contact is written with the consent the form gave, and the submission is linked and
// logged as a 'form.submitted' event.

import { createHash } from "node:crypto";
import { writeContacts } from "../contacts/contacts.ts";
import type { Target } from "../contacts/fields.ts";
import { prepareImport, type Ctx as CleanCtx } from "../contacts/import.ts";
import type { Rpc } from "../jobs.ts";
import { checkAnswers, cleanContext, cleanFields, contactRow, type FormSettings } from "./schema.ts";
import { shownAgo } from "./token.ts";

const MIN_MS = 2_000;
const MAX_MS = 24 * 3_600_000;

export type SubmitDeps = { rpc: Rpc; clean: (ws: string) => Promise<CleanCtx>; captcha: (token: unknown, ip: string) => Promise<boolean>; captchaOn: boolean; now?: () => number };
export type SubmitMeta = { ip: string; userAgent: string; preview: boolean };
export type SubmitOut = { status: number; body: Record<string, unknown> };

export async function submitForm(d: SubmitDeps, formId: string, raw: unknown, meta: SubmitMeta): Promise<SubmitOut> {
  const body = (raw && typeof raw === "object" ? raw : {}) as { answers?: Record<string, unknown>; context?: unknown };
  const { data, error } = await d.rpc("form_public", { p_id: formId, p_preview: meta.preview });
  const form = (error ? null : data) as { id: string; workspace_id: string; fields: unknown; settings: FormSettings } | null;
  if (!form) return { status: 404, body: { error: "This form isn't available." } };
  const fields = cleanFields(form.fields);
  const s = form.settings ?? {};
  const input = body.answers && typeof body.answers === "object" ? body.answers : {};

  const ago = shownAgo(form.id, input._t, (d.now ?? Date.now)());
  if (ago === null || ago > MAX_MS) return { status: 400, body: { error: "This page is out of date. Reload it and try again." } };
  let spam: string | null = typeof input._hp === "string" && input._hp.trim() ? "honeypot" : ago < MIN_MS ? "too_fast" : null;
  if (!spam && s.captcha && d.captchaOn && !(await d.captcha(input["cf-turnstile-response"], meta.ip))) return { status: 400, body: { error: "Check the box to show you're a person." } };

  const { answers, errors } = checkAnswers(fields, input);
  if (!spam && Object.keys(errors).length) return { status: 422, body: { errors } };
  const basis = s.consent === "notice" ? "legitimate_interest" : input._consent === "1" || input._consent === true ? "opt_in" : "none";
  const emailField = fields.find((f) => f.maps_to === "email");
  const email = emailField ? String(answers[emailField.key] ?? "") : "";

  // The contact as a file import would clean it; an address that can't be used is refused before anything is kept.
  const row = contactRow(fields, answers, basis);
  const p = prepareImport([row.cells], { columns: row.targets as Target[], source: "signups", basis: null, list: "contacts" }, await d.clean(form.workspace_id));
  const c = p.contacts[0];
  if (!spam && !c) return { status: 422, body: { errors: { [emailField?.key ?? "email"]: "Enter a valid email" } } };
  const ok = (): SubmitOut => ({ status: 200, body: { ok: true, email: spam ? null : email || null } });
  if (meta.preview) return ok();

  const ctx = cleanContext(body.context);
  const ipHash = meta.ip ? createHash("sha256").update(`${meta.ip}|${process.env.SECRETS_KEY ?? ""}`).digest("hex").slice(0, 32) : "";
  const sub = await d.rpc("form_submit", {
    p_form: form.id,
    p_row: { answers, utm: ctx.utm, page_url: ctx.page_url, referrer: ctx.referrer, basis, spam, ip_hash: ipHash, user_agent: meta.userAgent.slice(0, 300) },
  });
  if (sub.error) return { status: 500, body: { error: "Something went wrong. Try again." } };
  const rec = sub.data as { id: string; spam: string | null };
  spam = rec.spam;
  if (spam || !c) return ok();

  await writeContacts(d.rpc, form.workspace_id, "form", [c]);
  const ids = await d.rpc("contact_ids_by_email", { p_ws: form.workspace_id, p_emails: [c.email_clean] });
  const contactId = (ids.data as Record<string, string> | null)?.[c.email_clean];
  if (contactId) {
    const linked = await d.rpc("form_submission_link", { p_submission: rec.id, p_contact: contactId });
    if (linked.error) return { status: 500, body: { error: "Something went wrong. Try again." } };
  }
  return ok();
}
