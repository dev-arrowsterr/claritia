import { effectiveMapping, type SavedMapping } from "@/lib/sources/map";
import { connectorFor } from "@/lib/sources/registry";
import type { CustomField } from "@/lib/records/fields";
import { requireUser } from "@/lib/serverAuth";

// The mapping a source runs with, for its page: GET ?id=. Saved columns, or the tool's defaults and guesses.
export async function GET(request: Request) {
  const auth = await requireUser(request);
  if ("denied" in auth) return auth.denied;
  const id = new URL(request.url).searchParams.get("id") ?? "";
  if (!/^[0-9a-f-]{36}$/.test(id)) return Response.json({ error: "Source not found." }, { status: 404 });
  const { data: src } = await auth.sb.from("sources").select("workspace_id, kind, columns").eq("id", id).maybeSingle();
  const c = src ? connectorFor(src.kind) : undefined;
  if (!src || !c) return Response.json({ error: "Source not found." }, { status: 404 });
  const [{ data: saved }, { data: custom }] = await Promise.all([
    auth.sb.from("mappings").select("object, col, target, value_map, wins").eq("source_id", id).order("position"),
    auth.sb.from("fields").select("key, label, type, options").eq("workspace_id", src.workspace_id).eq("object", "contact"),
  ]);
  const cols = (src.columns ?? {}) as Record<string, Record<string, string>>;
  const out = (object: "contact" | "company") => {
    const seen = Object.keys(cols[object] ?? {});
    const mapped = effectiveMapping(c, object, (saved ?? []) as SavedMapping[], seen, (custom ?? []) as CustomField[]);
    const names = [...new Set([...mapped.map((m) => m.col), ...seen])];
    return names.map((col) => {
      const m = mapped.find((x) => x.col === col);
      return { col, sample: cols[object]?.[col] ?? "", target: m?.target ?? "skip", wins: m?.wins ?? "claritia" };
    });
  };
  return Response.json({ contact: out("contact"), company: out("company"), saved: (saved ?? []).length > 0 });
}
