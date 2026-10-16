import { appBase } from "@/lib/billing";
import { appHook, readHook } from "@/lib/sources/hooks";
import { serviceClient } from "@/lib/serviceClient";

// App-wide webhooks (HubSpot sends every account's changes to one address).
export async function POST(request: Request, { params }: { params: Promise<{ kind: string }> }) {
  const { kind } = await params;
  const db = serviceClient();
  if (!db) return Response.json({ error: "Not set up." }, { status: 503 });
  const u = new URL(request.url);
  const req = await readHook(request, `${appBase()}${u.pathname}${u.search}`);
  if (req instanceof Response) return req;
  return appHook(db, kind, req);
}
