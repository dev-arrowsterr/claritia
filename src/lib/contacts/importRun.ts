// One import run, the same in the web app (small files) and the import_file job (big files): rows in pages of
// 5,000, each page's unsubscribes and bounces written before its contacts, progress saved after each page. A
// restart passes `skip` (rows already done) and reads on from there; repeating a page changes nothing.

import { toCsv } from "./csv.ts";
import { mappingError, prepareImport, type ContactInput, type Ctx, type Mapping, type RowError, type Suppression } from "./import.ts";

export type Totals = { rows: number; merged: number; no_basis: number; suppressed: number; skipped: { missing_email: number; invalid_email: number; disposable: number } };

export type RunDeps = {
  /** The file's rows, header first. */
  rows: AsyncIterable<string[]>;
  mapping: Mapping;
  ctx: Ctx;
  /** Data rows already done by an earlier attempt. */
  skip?: number;
  write: (contacts: ContactInput[]) => Promise<void>;
  suppress: (rows: Suppression[]) => Promise<void>;
  /** Called after each page with rows done and the totals so far. */
  progress?: (done: number, totals: Totals) => Promise<void>;
  /** Totals saved by an earlier attempt. */
  initial?: Totals;
  signal?: AbortSignal;
  page?: number;
  maxRows?: number;
};

export const emptyTotals = (): Totals => ({ rows: 0, merged: 0, no_basis: 0, suppressed: 0, skipped: { missing_email: 0, invalid_email: 0, disposable: 0 } });

export async function runImport(d: RunDeps): Promise<{ totals: Totals; errors: RowError[]; header: string[] }> {
  const page = d.page ?? 5000;
  const skip = d.skip ?? 0;
  const totals: Totals = d.initial ? structuredClone(d.initial) : emptyTotals();
  const errors: RowError[] = [];
  let header: string[] | null = null;
  let seen = 0;
  let chunk: string[][] = [];
  let firstRow = skip + 2;

  const flush = async () => {
    if (!chunk.length) return;
    const p = prepareImport(chunk, d.mapping, d.ctx, firstRow);
    if (p.suppress.length) await d.suppress(p.suppress);
    if (p.contacts.length) await d.write(p.contacts);
    totals.rows += p.counts.rows;
    totals.merged += p.counts.merged;
    totals.no_basis += p.counts.no_basis;
    totals.suppressed += p.counts.suppressed;
    totals.skipped.missing_email += p.counts.skipped.missing_email;
    totals.skipped.invalid_email += p.counts.skipped.invalid_email;
    totals.skipped.disposable += p.counts.skipped.disposable;
    for (const e of p.errors) if (errors.length < 50_000) errors.push(e);
    firstRow += chunk.length;
    chunk = [];
    await d.progress?.(seen, totals);
  };

  for await (const row of d.rows) {
    if (d.signal?.aborted) throw new Error("Stopped");
    if (!header) {
      header = row;
      const wrong = mappingError(d.mapping, header.length, d.ctx.custom);
      if (wrong) throw new Error(wrong);
      continue;
    }
    seen++;
    if (d.maxRows && seen > d.maxRows) throw new Error(`Up to ${d.maxRows.toLocaleString("en-US")} rows at a time.`);
    if (seen <= skip) continue;
    chunk.push(row);
    if (chunk.length >= page) await flush();
  }
  await flush();
  if (!header) throw new Error("The file is empty.");
  return { totals, errors, header };
}

/** The rows that didn't come in, with their reason, as a CSV to download. */
export const errorsCsv = (errors: RowError[]) => toCsv([["Row", "Email", "Reason"], ...errors.map((e) => [e.row, e.email, e.reason])]);
