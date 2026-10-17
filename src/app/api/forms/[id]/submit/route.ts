import { cleaningCtx } from "@/lib/contacts/server";
import { submitForm } from "@/lib/forms/submit";
import { serviceClient } from "@/lib/serviceClient";

// A form's answers. The work is in src/lib/forms/submit.ts.

async function turnstileOk(token: unknown, ip: string): Promise<boolean> {
  const secret = process.env.TURNSTILE_SECRET_KEY?.trim();
  if (!secret) return true;
  if (typeof token !== "string" || !token) return false;
  const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    body: new URLSearchParams({ secret, response: token, ...(ip ? { remoteip: ip } : {}) }),
    signal: AbortSignal.timeout(8_000),
  }).catch(() => null);
  const j = res ? ((await res.json().catch(() => ({}))) as { success?: boolean }) : {};
  return j.success === true;
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = serviceClient();
  if (!db || !/^[0-9a-f-]{36}$/.test(id)) return Response.json({ error: "This form isn't available." }, { status: 404 });
  const raw = await request.text();
  if (raw.length > 100_000) return Response.json({ error: "Too much." }, { status: 413 });
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return Response.json({ error: "Something went wrong. Try again." }, { status: 400 });
  }
  const out = await submitForm(
    { rpc: (fn, args) => db.rpc(fn, args), clean: (ws) => cleaningCtx(db, ws), captcha: turnstileOk, captchaOn: !!(process.env.TURNSTILE_SITE_KEY && process.env.TURNSTILE_SECRET_KEY) },
    id,
    body,
    {
      ip: (request.headers.get("fly-client-ip") ?? request.headers.get("x-forwarded-for") ?? "").split(",")[0].trim(),
      userAgent: request.headers.get("user-agent") ?? "",
      preview: new URL(request.url).searchParams.get("preview") === "1",
    },
  );
  return Response.json(out.body, { status: out.status });
}
