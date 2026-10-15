import { INLINE_BYTES } from "@/lib/contacts/csv";
import { kindOf } from "@/lib/contacts/files";
import { mappingError, type Mapping } from "@/lib/contacts/import";
import { executeImport, type ImportRow } from "@/lib/contacts/importJob";
import { cleaningCtx, isMember } from "@/lib/contacts/server";
import { fileSize, validPath } from "@/lib/contacts/storage";
import { requireUser } from "@/lib/serverAuth";
import { serviceClient } from "@/lib/serviceClient";

// Start an import of an uploaded file: POST { workspaceId, path, fileName, sheet, mapping, kind }. Files up to 3 MB
// run now and return their counts; bigger ones go to the import_file job, and the app follows its progress.

export const maxDuration = 300;

const bad = (error: string, status = 400) => Response.json({ error }, { status });

export async function POST(request: Request) {
  const auth = await requireUser(request);
  if ("denied" in auth) return auth.denied;
  const body = (await request.json().catch(() => ({}))) as { workspaceId?: unknown; path?: unknown; fileName?: unknown; sheet?: unknown; mapping?: Mapping; kind?: unknown };
  if (!(await isMember(auth, body.workspaceId))) return bad("Workspace not found.", 404);
  const ws = body.workspaceId as string;
  if (!validPath(ws, body.path)) return bad("File not found.", 404);
  const fileName = typeof body.fileName === "string" ? body.fileName.slice(0, 200) : "contacts.csv";
  if (!kindOf(fileName)) return bad("Choose a CSV, Excel (.xlsx) or vCard file.");
  const sb = serviceClient();
  if (!sb) return bad("The server is not set up for this.", 500);

  const ctx = await cleaningCtx(sb, ws);
  const mapping = body.mapping ?? ({} as Mapping);
  if (!Array.isArray(mapping.columns)) return bad("Map every column.");
  const wrong = mappingError(mapping, mapping.columns.length, ctx.custom);
  if (wrong) return bad(wrong);
  const size = await fileSize(body.path);
  if (size == null) return bad("The file is gone. Upload it again.", 404);
  if (size > 1_000_000_000) return bad("The file is over 1 GB.");
  const sheet = typeof body.sheet === "string" ? body.sheet.slice(0, 120) : null;
  const queued = size > INLINE_BYTES;
  const started = await sb.rpc("imports_start", {
    p_ws: ws,
    p_user: auth.user.id,
    p_file_name: fileName,
    p_mapping: mapping,
    p_kind: body.kind === "paste" ? "paste" : "file",
    p_path: body.path,
    p_size: size,
    p_sheet: sheet,
    p_queued: queued,
  });
  if (started.error) return bad(started.error.message, 500);
  const importId = started.data as string;
  if (queued) return Response.json({ importId, queued: true });

  const rpc = (fn: string, args: Record<string, unknown>) => sb.rpc(fn, args);
  const imp: ImportRow = { id: importId, workspace_id: ws, file_name: fileName, file_path: body.path, kind: body.kind === "paste" ? "paste" : "file", sheet, mapping, rows_done: 0, progress: {} };
  try {
    await executeImport(rpc, imp, ctx);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await sb.rpc("imports_finish", { p_import: importId, p_status: "failed", p_counts: {}, p_error: message });
    return bad(`The import stopped: ${message}`, 500);
  }
  const { data } = await sb.from("imports").select("counts, errors_path").eq("id", importId).single();
  return Response.json({ importId, counts: data?.counts ?? {}, errorsPath: data?.errors_path ?? null });
}
