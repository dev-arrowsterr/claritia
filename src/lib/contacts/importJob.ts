// Running a stored import from start (or from where it stopped) to finish. The web app calls this for small files;
// the import_file job on claritia-intel for big ones. Both pass the database through `rpc`.

import type { Rpc } from "../jobs.ts";
import { writeContacts, type Source } from "./contacts.ts";
import { chunksOf, fileRows, kindOf } from "./files.ts";
import type { Ctx, Mapping } from "./import.ts";
import { emptyTotals, errorsCsv, runImport, type Totals } from "./importRun.ts";
import { openFile, putFile } from "./storage.ts";

export type ImportRow = {
  id: string;
  workspace_id: string;
  file_name: string;
  file_path: string;
  kind: string;
  sheet: string | null;
  mapping: Mapping;
  rows_done: number;
  progress: { totals?: Totals };
};

const call = async (rpc: Rpc, fn: string, args: Record<string, unknown>) => {
  const { data, error } = await rpc(fn, args);
  if (error) throw new Error(error.message);
  return data;
};

/** Which source a file import writes as, so the field order can rank it. */
export function sourceOfFile(imp: Pick<ImportRow, "kind" | "file_name">): Source {
  if (imp.kind === "paste") return "paste";
  const k = kindOf(imp.file_name);
  return k === "xlsx" ? "excel" : k === "vcf" ? "vcard" : "csv";
}

export async function executeImport(rpc: Rpc, imp: ImportRow, ctx: Ctx, opts: { signal?: AbortSignal; open?: (path: string) => Promise<ReadableStream<Uint8Array>> } = {}) {
  const kind = kindOf(imp.file_name);
  if (!kind) throw new Error("This kind of file can't be imported");
  const source = sourceOfFile(imp);
  const stream = await (opts.open ?? openFile)(imp.file_path);
  try {
    const { totals, errors } = await runImport({
      rows: fileRows(kind, chunksOf(stream), imp.sheet),
      mapping: imp.mapping,
      ctx,
      skip: imp.rows_done,
      initial: imp.progress?.totals ?? emptyTotals(),
      signal: opts.signal,
      suppress: async (rows) => {
        for (let i = 0; i < rows.length; i += 10_000) await call(rpc, "suppress", { p_ws: imp.workspace_id, p_source: source, p_rows: rows.slice(i, i + 10_000), p_import: imp.id });
      },
      write: async (contacts) => {
        await writeContacts(rpc, imp.workspace_id, source, contacts, { importId: imp.id });
      },
      progress: async (done, t) => {
        await call(rpc, "import_progress", { p_import: imp.id, p_rows_done: done, p_progress: { stage: "running", rows: done, totals: t } });
      },
    });
    let errorsPath: string | null = null;
    if (errors.length) {
      errorsPath = `${imp.workspace_id}/${imp.id}/errors.csv`;
      try {
        await putFile(errorsPath, errorsCsv(errors), "text/csv");
      } catch {
        errorsPath = null;
      }
    }
    await call(rpc, "imports_finish", { p_import: imp.id, p_status: "done", p_counts: totals, p_error: null, p_errors_path: errorsPath });
    return totals;
  } catch (e) {
    // A file that can't be read or a mapping that doesn't fit won't get better by trying again.
    const message = e instanceof Error ? e.message : String(e);
    if (/can't be imported|Map |Choose |empty|rows at a time|no longer exists|one column|Bought/.test(message)) {
      await call(rpc, "imports_finish", { p_import: imp.id, p_status: "failed", p_counts: imp.progress?.totals ?? {}, p_error: message });
    }
    throw e;
  }
}
