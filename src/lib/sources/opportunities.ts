// Opportunities from CRMs (docs/marketing-platform.md, CRM). Each connector reads its deals into one shape; this
// turns them into rows for opportunities_ingest (supabase/migrations/039_crm.sql). Stages keep the CRM's names, with
// won and lost always landing on the same two values so boards and reports can tell them apart.

import type { RawRecord } from "./types.ts";

export type StageKind = "open" | "won" | "lost";

/** One deal as every CRM gives it. `company` and `contacts` are the CRM's own ids; undefined means "not read". */
export type Deal = {
  name: string | null;
  amount: number | null;
  stage: string | null;
  stageKind: StageKind;
  closeDate: string | null;
  /** 0 to 100. */
  probability: number | null;
  owner: string | null;
  pipeline: string | null;
  nextStep: string | null;
  url: string | null;
  company?: string | null;
  contacts?: string[];
};

export type OpportunityRow = {
  id: string;
  name: string;
  fields: Record<string, unknown>;
  stage_label: string | null;
  stage_kind: StageKind;
  company?: string;
  contacts?: string[];
};

const slug = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);

/** The stage's value: "won" and "lost" for closed deals, else the CRM's stage name as a key. */
export function stageValue(label: string | null, kind: StageKind): string | null {
  if (kind === "won" || kind === "lost") return kind;
  const s = label ? slug(label) : "";
  // A CRM stage that slugs to "won" or "lost" but is still open keeps its own value.
  return !s ? null : s === "won" || s === "lost" ? `${s}_open` : s;
}

export const num = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const t = String(v).replace(/[^0-9.-]/g, "");
  const n = typeof v === "number" ? v : /\d/.test(t) ? Number(t) : NaN;
  return Number.isFinite(n) ? n : null;
};

/** A date the CRM gave (date, datetime or epoch ms) as YYYY-MM-DD. */
export function day(v: unknown): string | null {
  if (v == null || v === "") return null;
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const t = /^\d{10,}$/.test(s) ? Number(s) : Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null;
}

const clampPct = (n: number | null) => (n == null ? null : Math.max(0, Math.min(100, Math.round(n))));

export const dealRecord = (id: string, updatedAt: string | null, deleted: boolean, deal: Deal): RawRecord => ({
  id,
  updatedAt,
  deleted,
  data: deal as unknown as Record<string, unknown>,
});

/** Live deals → rows for opportunities_ingest. Deleted ones are left out; they go through opportunities_remove. */
export function toOpportunityRows(records: RawRecord[]): OpportunityRow[] {
  const out: OpportunityRow[] = [];
  for (const r of records) {
    if (r.deleted || !r.id) continue;
    const d = r.data as unknown as Deal;
    const fields: Record<string, unknown> = {};
    const stage = stageValue(d.stage, d.stageKind);
    if (stage) fields.stage = stage;
    if (d.amount != null) fields.amount = d.amount;
    if (d.closeDate) fields.close_date = d.closeDate;
    const p = clampPct(d.probability ?? (d.stageKind === "won" ? 100 : d.stageKind === "lost" ? 0 : null));
    if (p != null) fields.probability = p;
    if (d.owner) fields.owner = d.owner.slice(0, 200);
    if (d.pipeline) fields.pipeline = d.pipeline.slice(0, 200);
    if (d.nextStep) fields.next_step = d.nextStep.slice(0, 500);
    if (d.url && /^https:\/\//.test(d.url)) fields.crm_url = d.url;
    const row: OpportunityRow = {
      id: r.id,
      name: (d.name ?? "").trim().slice(0, 300),
      fields,
      stage_label: d.stageKind === "won" ? "Won" : d.stageKind === "lost" ? "Lost" : d.stage,
      stage_kind: d.stageKind,
    };
    if (d.company !== undefined) row.company = d.company ?? "";
    if (d.contacts !== undefined) row.contacts = [...new Set(d.contacts)];
    out.push(row);
  }
  return out;
}
