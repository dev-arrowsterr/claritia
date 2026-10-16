import { chunksOf, inspect, kindOf, xlsxSheets } from "@/lib/contacts/files";
import { cleaningCtx, isMember } from "@/lib/contacts/server";
import { fileSize, openFile, validPath } from "@/lib/contacts/storage";
import { guessTarget } from "@/lib/contacts/fields";
import { requireUser } from "@/lib/serverAuth";
import { serviceClient } from "@/lib/serviceClient";

// Look at an uploaded file: POST { workspaceId, path, fileName, sheet? } returns its sheets (Excel), header, first
// rows, a row count, and a guessed field for each column.

const bad = (error: string, status = 400) => Response.json({ error }, { status });

export async function POST(request: Request) {
  const auth = await requireUser(request);
  if ("denied" in auth) return auth.denied;
  const body = (await request.json().catch(() => ({}))) as { workspaceId?: unknown; path?: unknown; fileName?: unknown; sheet?: unknown };
  if (!(await isMember(auth, body.workspaceId))) return bad("Workspace not found.", 404);
  const ws = body.workspaceId as string;
  if (!validPath(ws, body.path)) return bad("File not found.", 404);
  const kind = kindOf(String(body.fileName ?? body.path));
  if (!kind) return bad("Choose a CSV, Excel (.xlsx) or vCard file.");
  const sb = serviceClient();
  if (!sb) return bad("The server is not set up for this.", 500);
  try {
    const size = await fileSize(body.path);
    let sheets: string[] = [];
    let source: AsyncIterable<Uint8Array> = chunksOf(await openFile(body.path));
    if (kind === "xlsx" && size != null && size <= 60_000_000) {
      // Small enough to read the workbook's sheet list first.
      const bytes = new Uint8Array(await new Response(await openFile(body.path)).arrayBuffer());
      sheets = xlsxSheets(bytes);
      source = chunksOf(bytes);
    }
    const sheet = typeof body.sheet === "string" && sheets.includes(body.sheet) ? body.sheet : null;
    const r = await inspect(kind, source, { sheet, sheets, samples: 20, countUpTo: 200_000 });
    if (!r.header.length) return bad("The file has no rows.");
    const ctx = await cleaningCtx(sb, ws);
    const guessed: string[] = [];
    for (const h of r.header) {
      const t = guessTarget(h, ctx.custom);
      guessed.push(t !== "skip" && guessed.includes(t) ? "skip" : t);
    }
    return Response.json({ kind, size, sheets, sheet: sheet ?? sheets[0] ?? null, header: r.header, samples: r.samples, rows: r.rows, exact: r.done, guessed });
  } catch (e) {
    return bad(e instanceof Error ? e.message : String(e), 500);
  }
}
