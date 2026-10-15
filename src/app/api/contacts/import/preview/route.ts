import { chunksOf, fileRows, kindOf } from "@/lib/contacts/files";
import { mappingError, prepareImport, type Mapping } from "@/lib/contacts/import";
import { cleaningCtx, isMember } from "@/lib/contacts/server";
import { openFile, validPath } from "@/lib/contacts/storage";
import { requireUser } from "@/lib/serverAuth";
import { serviceClient } from "@/lib/serviceClient";

// What an import would do to its first rows: POST { workspaceId, path, fileName, sheet, mapping } returns up to 20
// rows, each New, Update, Suppressed, Skip (with the reason) or Erased.

const bad = (error: string, status = 400) => Response.json({ error }, { status });

export async function POST(request: Request) {
  const auth = await requireUser(request);
  if ("denied" in auth) return auth.denied;
  const body = (await request.json().catch(() => ({}))) as { workspaceId?: unknown; path?: unknown; fileName?: unknown; sheet?: unknown; mapping?: Mapping };
  if (!(await isMember(auth, body.workspaceId))) return bad("Workspace not found.", 404);
  const ws = body.workspaceId as string;
  if (!validPath(ws, body.path)) return bad("File not found.", 404);
  const kind = kindOf(String(body.fileName ?? body.path));
  if (!kind) return bad("Choose a CSV, Excel (.xlsx) or vCard file.");
  const sb = serviceClient();
  if (!sb) return bad("The server is not set up for this.", 500);
  try {
    const ctx = await cleaningCtx(sb, ws);
    const rows: string[][] = [];
    let header: string[] | null = null;
    for await (const r of fileRows(kind, chunksOf(await openFile(body.path)), typeof body.sheet === "string" ? body.sheet : null)) {
      if (!header) header = r;
      else rows.push(r);
      if (rows.length >= 20) break;
    }
    if (!header) return bad("The file has no rows.");
    const mapping = body.mapping ?? ({} as Mapping);
    const wrong = mappingError(mapping, header.length, ctx.custom);
    if (wrong) return bad(wrong);
    const out: { row: number; email: string; name: string; company: string; outcome: string; reason?: string }[] = [];
    const ready = rows.map((r, i) => ({ i, p: prepareImport([r], mapping, ctx, i + 2) }));
    const emails = ready.flatMap(({ p }) => p.contacts.map((c) => c.email_clean));
    const look = (await sb.rpc("import_lookup", { p_ws: ws, p_emails: emails })).data as { existing: string[]; suppressed: string[]; erased: string[] } | null;
    for (const { i, p } of ready) {
      const c = p.contacts[0];
      if (!c) {
        out.push({ row: i + 2, email: p.errors[0]?.email ?? "", name: "", company: "", outcome: "skip", reason: p.errors[0]?.reason });
        continue;
      }
      const name = [c.first_name, c.last_name].filter(Boolean).join(" ");
      const outcome = look?.erased.includes(c.email_clean)
        ? "erased"
        : p.suppress.length || look?.suppressed.includes(c.email_clean)
          ? "suppressed"
          : look?.existing.includes(c.email_clean)
            ? "update"
            : "new";
      out.push({ row: i + 2, email: c.email, name, company: c.company_name ?? c.company_domain ?? "", outcome });
    }
    return Response.json({ rows: out });
  } catch (e) {
    return bad(e instanceof Error ? e.message : String(e), 500);
  }
}
