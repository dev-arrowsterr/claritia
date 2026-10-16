import { appBase } from "@/lib/billing";
import { readHook, sourceHook } from "@/lib/sources/hooks";
import { serviceClient } from "@/lib/serviceClient";

// One source's webhooks: forms, scheduling and event tools, Omniscient, and anything posting JSON.
export async function POST(request: Request, { params }: { params: Promise<{ kind: string; id: string }> }) {
  const { kind, id } = await params;
  const db = serviceClient();
  if (!db) return Response.json({ error: "Not set up." }, { status: 503 });
  const u = new URL(request.url);
  const req = await readHook(request, `${appBase()}${u.pathname}${u.search}`);
  if (req instanceof Response) return req;
  return sourceHook(db, kind, id, req);
}
