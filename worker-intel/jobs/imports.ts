// Imports on claritia-intel (docs/conversion-weeks.md week 2): big files, undo, and clearing old files.

import type pg from "pg";
import type { Ctx } from "../../src/lib/contacts/import.ts";
import { executeImport, type ImportRow } from "../../src/lib/contacts/importJob.ts";
import { removeFiles } from "../../src/lib/contacts/storage.ts";
import type { CustomField } from "../../src/lib/records/fields.ts";
import { JobError, type Handler, type Rpc } from "../../src/lib/jobs.ts";

async function call<T>(rpc: Rpc, fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data as T;
}

/** What cleaning needs from the workspace: its custom contact fields and its own and partner domains. */
export async function ctxFor(pool: pg.Pool, ws: string): Promise<Ctx> {
  const [fields, settings] = await Promise.all([
    pool.query(`select key, label, type, options from fields where workspace_id = $1 and object = 'contact'`, [ws]),
    pool.query(`select own_domains, partner_domains from identity_settings where workspace_id = $1`, [ws]),
  ]);
  return { custom: fields.rows as CustomField[], own_domains: settings.rows[0]?.own_domains ?? [], partner_domains: settings.rows[0]?.partner_domains ?? [] };
}

/** import_file: read the stored file from where the last attempt stopped, to the end. */
export const importFile =
  (pool: pg.Pool, rpc: Rpc, open?: (path: string) => Promise<ReadableStream<Uint8Array>>): Handler =>
  async (job, signal) => {
    const id = String(job.payload.import_id ?? "");
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new JobError("import_file needs an import", { retry: false });
    const imp = await call<ImportRow | null>(rpc, "import_claim", { p_import: id });
    if (!imp) return;
    await executeImport(rpc, imp, await ctxFor(pool, imp.workspace_id), { signal, open });
  };

/** import_undo: take back what an import did. */
export const importUndo = (rpc: Rpc): Handler => async (job) => {
  const id = String(job.payload.import_id ?? "");
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new JobError("import_undo needs an import", { retry: false });
  await call(rpc, "import_undo_run", { p_import: id });
};

/** Files past the 30-day undo window go from storage. */
export async function pruneImportFiles(rpc: Rpc): Promise<number> {
  const paths = await call<string[]>(rpc, "imports_files_to_prune", {});
  const list = (Array.isArray(paths) ? paths : []).map((p) => (typeof p === "string" ? p : (p as Record<string, string>).imports_files_to_prune)).filter(Boolean);
  if (!list.length) return 0;
  await removeFiles(list);
  await call(rpc, "imports_files_pruned", { p_paths: list });
  return list.length;
}
