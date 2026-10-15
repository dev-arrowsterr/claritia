import { writeContacts } from "@/lib/contacts/contacts";
import { parseCsv } from "@/lib/contacts/csv";
import { MAX_BYTES, MAX_ROWS, mappingError, prepareImport, type Mapping } from "@/lib/contacts/import";
import { cleaningCtx, isMember } from "@/lib/contacts/server";
import { requireUser } from "@/lib/serverAuth";
import { serviceClient } from "@/lib/serviceClient";

// Import contacts from a CSV: POST { workspaceId, fileName, text, mapping: { columns, source, basis } }. The file is
// parsed here again (the browser only previews it), cleaned, and written in batches of 1,000. Returns the counts.

export const maxDuration = 300;

const bad = (error: string, status = 400) => Response.json({ error }, { status });

export async function POST(request: Request) {
  const auth = await requireUser(request);
  if ("denied" in auth) return auth.denied;
  const body = (await request.json().catch(() => ({}))) as { workspaceId?: unknown; fileName?: unknown; text?: unknown; mapping?: Mapping };
  if (!(await isMember(auth, body.workspaceId))) return bad("Workspace not found.", 404);
  const ws = body.workspaceId as string;
  if (typeof body.text !== "string" || !body.text.trim()) return bad("The file is empty.");
  if (body.text.length > MAX_BYTES) return bad("The file is over 20 MB.");
  const sb = serviceClient();
  if (!sb) return bad("The server is not set up for this.", 500);

  const [header, ...rows] = parseCsv(body.text);
  if (!header || !rows.length) return bad("The file has no rows under its header.");
  if (rows.length > MAX_ROWS) return bad(`Up to ${MAX_ROWS.toLocaleString("en-US")} rows at a time.`);
  const ctx = await cleaningCtx(sb, ws);
  const mapping = body.mapping ?? ({} as Mapping);
  const wrong = mappingError(mapping, header.length, ctx.custom);
  if (wrong) return bad(wrong);

  const prepared = prepareImport(rows, mapping, ctx);
  const fileName = typeof body.fileName === "string" ? body.fileName : "contacts.csv";
  const started = await sb.rpc("imports_start", { p_ws: ws, p_user: auth.user.id, p_file_name: fileName, p_mapping: { ...mapping, header } });
  if (started.error) return bad(started.error.message, 500);
  const importId = started.data as string;
  const rpc = (fn: string, args: Record<string, unknown>) => sb.rpc(fn, args);
  try {
    const written = await writeContacts(rpc, ws, "import", prepared.contacts, { importId });
    const counts = { ...prepared.counts, created: written.created, updated: written.updated };
    await sb.rpc("imports_finish", { p_import: importId, p_status: "done", p_counts: counts });
    return Response.json({ importId, counts });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await sb.rpc("imports_finish", { p_import: importId, p_status: "failed", p_counts: prepared.counts, p_error: message });
    return bad(`The import stopped: ${message}`, 500);
  }
}
