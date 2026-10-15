import { serviceClient } from "@/lib/serviceClient";
import { CLR_SITE_KEY, COLLECT_URL } from "@/lib/site";
import { proxyToCollect } from "@/lib/web/proxy";

// /_clr/* on tryclaritia.com goes to claritia-collect, so the device cookie is first-party (mode A).
let secret: { value: string | null; at: number } = { value: null, at: 0 };

async function proxySecret(): Promise<string | null> {
  if (Date.now() - secret.at < 10 * 60_000) return secret.value;
  const sb = serviceClient();
  const { data } = sb ? await sb.from("sites").select("proxy_secret").eq("site_key", CLR_SITE_KEY).maybeSingle<{ proxy_secret: string }>() : { data: null };
  secret = { value: data?.proxy_secret ?? null, at: Date.now() };
  return secret.value;
}

async function handle(request: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  return proxyToCollect(request, path.join("/"), {
    collectUrl: process.env.COLLECT_URL || COLLECT_URL,
    clientIp: request.headers.get("fly-client-ip"),
    proxySecret: await proxySecret(),
  });
}

export const GET = handle;
export const POST = handle;
export const OPTIONS = handle;
