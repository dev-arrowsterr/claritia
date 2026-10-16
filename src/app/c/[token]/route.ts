import { looksLikeScanner, readToken } from "@/lib/email/track";
import { serviceClient } from "@/lib/serviceClient";

// A tracked link in an email: log the click, then send the reader on. A bad token or a missing link goes to the
// marketing site rather than an error page.
async function go(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const home = `https://${process.env.SITE_HOST?.trim() || "tryclaritia.com"}`;
  let t: ReturnType<typeof readToken> = null;
  try {
    t = readToken(token);
  } catch {
    t = null;
  }
  const db = serviceClient();
  if (!t || t.kind !== "click" || !db) return Response.redirect(home, 302);
  const ua = request.headers.get("user-agent");
  const { data } = await db.rpc("email_click", { p_message: t.message, p_link: t.link, p_human: !looksLikeScanner(request.method, ua), p_data: { ua: (ua ?? "").slice(0, 200) } });
  const url = typeof data === "string" && /^https?:\/\//i.test(data) ? data : home;
  return new Response(null, { status: 302, headers: { Location: url, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
}

export const GET = go;
export const HEAD = go;
