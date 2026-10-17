import { formPage } from "@/lib/forms/render";
import { cleanFields, type FormSettings } from "@/lib/forms/schema";
import { shownToken } from "@/lib/forms/token";
import { serviceClient } from "@/lib/serviceClient";

// A form's page: what the embed frames, and a link that works on its own. ?preview=1 shows a draft (answers
// aren't kept).
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const preview = new URL(request.url).searchParams.get("preview") === "1";
  const db = serviceClient();
  const gone = () => new Response("This form isn't available.", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  if (!db || !/^[0-9a-f-]{36}$/.test(id)) return gone();
  const { data } = await db.rpc("form_public", { p_id: id, p_preview: preview });
  const f = data as { id: string; name: string; fields: unknown; settings: FormSettings; topic: string | null } | null;
  if (!f) return gone();
  const html = formPage({
    id: f.id,
    name: f.name,
    fields: cleanFields(f.fields),
    settings: f.settings ?? {},
    token: shownToken(f.id),
    preview,
    captchaKey: process.env.TURNSTILE_SITE_KEY?.trim() || null,
    topic: f.topic,
  });
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      // Any site may frame a form; that's what the embed does.
      "Content-Security-Policy": "frame-ancestors *",
      "X-Robots-Tag": "noindex",
    },
  });
}
