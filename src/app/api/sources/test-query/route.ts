import { unseal } from "@/lib/seal";
import { makeCtx } from "@/lib/sources/ctx";
import { isOwner } from "@/lib/sources/server";
import { queryError, START_CURSOR, type WhQuery } from "@/lib/sources/sql";
import type { Creds, SourceRow } from "@/lib/sources/types";
import { runQuery } from "@/lib/sources/warehouse";
import { requireUser } from "@/lib/serverAuth";
import { serviceClient } from "@/lib/serviceClient";

// Run a warehouse source's query once and show 20 rows: POST { id, query }. Owners only.
export const maxDuration = 150;

export async function POST(request: Request) {
  const auth = await requireUser(request);
  if ("denied" in auth) return auth.denied;
  const body = (await request.json().catch(() => ({}))) as { id?: unknown; query?: Partial<WhQuery> };
  const id = typeof body.id === "string" ? body.id : "";
  if (!/^[0-9a-f-]{36}$/.test(id)) return Response.json({ error: "Source not found." }, { status: 404 });
  const { data: src } = await auth.sb.from("sources").select("workspace_id").eq("id", id).maybeSingle();
  if (!src || !(await isOwner(auth.sb, auth.user.id, src.workspace_id))) return Response.json({ error: "Source not found." }, { status: 404 });
  const q = { ...body.query, target: body.query?.target ?? "contacts" } as WhQuery;
  const wrong = queryError(q);
  if (wrong) return Response.json({ error: wrong }, { status: 400 });
  const db = serviceClient();
  if (!db) return Response.json({ error: "The server is not set up for this." }, { status: 500 });
  const { data: l } = await db.rpc("source_load", { p_id: id });
  const loaded = l as { source: SourceRow; sealed: string | null } | null;
  if (!loaded?.sealed) return Response.json({ error: "Connect it again first." }, { status: 409 });
  try {
    const ctx = makeCtx({ source: loaded.source, creds: JSON.parse(unseal(loaded.sealed)) as Creds });
    const r = await runQuery(ctx, q, START_CURSOR, 20);
    return Response.json({ columns: r.columns, rows: r.rows });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message.slice(0, 500) : "The query failed." }, { status: 400 });
  }
}
