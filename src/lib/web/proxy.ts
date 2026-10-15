// The same-site proxy path (docs/identity.md 4.3, mode A) for a Next.js site: /_clr/* is forwarded to collect with
// the visitor's IP and the site's proxy secret. tryclaritia.com uses it, and it's the recipe customers copy.

const PASS_UP = ["cookie", "origin", "referer", "user-agent", "accept-language", "content-type", "dnt", "sec-ch-ua-mobile"];
const PASS_DOWN = ["content-type", "cache-control", "retry-after", "access-control-allow-origin", "access-control-allow-credentials", "vary"];

export type ProxyOptions = {
  collectUrl: string;
  /** The visitor's IP as the edge saw it (Fly-Client-IP on Fly). */
  clientIp?: string | null;
  proxySecret?: string | null;
  fetcher?: typeof fetch;
  timeoutMs?: number;
};

export async function proxyToCollect(req: Request, path: string, opts: ProxyOptions): Promise<Response> {
  if (!/^[\w./-]{1,64}$/.test(path) || path.includes("..")) return new Response(null, { status: 404 });
  const src = new URL(req.url);
  const target = new URL(opts.collectUrl.replace(/\/+$/, "") + "/" + path + src.search);
  const headers = new Headers();
  for (const h of PASS_UP) {
    const v = req.headers.get(h);
    if (v) headers.set(h, v);
  }
  if (opts.proxySecret && opts.clientIp) {
    headers.set("x-clr-proxy", opts.proxySecret);
    headers.set("x-clr-client-ip", opts.clientIp);
  }
  headers.set("x-forwarded-proto", src.protocol.replace(":", ""));
  let res: Response;
  try {
    res = await (opts.fetcher ?? fetch)(target, {
      method: req.method,
      headers,
      body: req.method === "POST" ? await req.text() : undefined,
      redirect: "manual",
      signal: AbortSignal.timeout(opts.timeoutMs ?? 5000),
    });
  } catch {
    return new Response(null, { status: 503, headers: { "retry-after": "5" } });
  }
  const out = new Headers();
  for (const h of PASS_DOWN) {
    const v = res.headers.get(h);
    if (v) out.set(h, v);
  }
  for (const c of res.headers.getSetCookie()) out.append("set-cookie", c);
  return new Response(res.status === 204 ? null : await res.arrayBuffer(), { status: res.status, headers: out });
}
