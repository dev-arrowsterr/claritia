import { readToken } from "@/lib/email/track";
import { serviceClient } from "@/lib/serviceClient";

// Unsubscribe (docs/marketing-platform.md M3 and 9.2).
//   POST with "List-Unsubscribe=One-Click": the mail app's one-click button (RFC 8058). Unsubscribes at once.
//   GET: a page with the buttons. Opening it changes nothing, because mail filters open every link.
//   POST from that page: unsubscribes from the topic, or from everything.

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function page(title: string, body: string, status = 200) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title>
<style>
:root{color-scheme:light dark;--ink:#0c0c0b;--muted:#6b6b66;--line:#eaeaea;--panel:#fff;--canvas:#fafafa;--brand:#266df0}
@media (prefers-color-scheme:dark){:root{--ink:#f2f2f0;--muted:#a3a39e;--line:#2a2a28;--panel:#141413;--canvas:#0c0c0b}}
body{margin:0;background:var(--canvas);color:var(--ink);font:15px/1.5 Geist,ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif}
main{max-width:440px;margin:12vh auto 0;padding:0 16px}
section{background:var(--panel);border:1px solid var(--line);padding:24px}
h1{font-size:20px;font-weight:500;margin:0 0 8px;letter-spacing:-.01em}
p{margin:0 0 20px;color:var(--muted)}
form{display:flex;flex-wrap:wrap;gap:8px}
button{font:inherit;font-size:14px;border-radius:6px;padding:8px 14px;cursor:pointer;border:1px solid var(--line);background:var(--panel);color:var(--ink)}
button.primary{background:var(--brand);border-color:var(--brand);color:#fff}
</style></head><body><main><section>${body}</section></main></body></html>`;
  return new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" } });
}

async function load(params: Promise<{ token: string }>) {
  const { token } = await params;
  let t: ReturnType<typeof readToken> = null;
  try {
    t = readToken(token);
  } catch {
    t = null;
  }
  return { token, message: t?.kind === "unsub" ? t.message : null };
}

const gone = () => page("Link not valid", `<h1>This link isn't valid</h1><p>Use the unsubscribe link in the most recent email.</p>`, 404);

export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token, message } = await load(params);
  const db = serviceClient();
  if (!message || !db) return gone();
  const { data } = await db.rpc("email_unsubscribe_info", { p_message: message });
  const info = data as { topic: string | null; from: string | null; done: boolean } | null;
  if (!info) return gone();
  if (info.done) return page("Unsubscribed", `<h1>You're unsubscribed</h1><p>You won't get these emails again.</p>`);
  const from = info.from ? ` from ${esc(info.from)}` : "";
  const buttons = info.topic
    ? `<button class="primary" name="scope" value="topic">Unsubscribe from ${esc(info.topic)}</button><button name="scope" value="all">Unsubscribe from all</button>`
    : `<button class="primary" name="scope" value="all">Unsubscribe</button>`;
  return page("Unsubscribe", `<h1>Unsubscribe${from}</h1><p>${esc(info.topic ? `You get these as part of ${info.topic}.` : "Stop getting these emails.")}</p><form method="post" action="/u/${esc(token)}">${buttons}</form>`);
}

export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { message } = await load(params);
  const db = serviceClient();
  const body = await request.text().catch(() => "");
  const form = new URLSearchParams(body);
  const oneClick = form.get("List-Unsubscribe") === "One-Click";
  if (!message || !db) return oneClick ? new Response("Not found", { status: 404 }) : gone();
  const { data, error } = await db.rpc("email_unsubscribe", { p_message: message, p_scope: oneClick ? "all" : form.get("scope") === "topic" ? "topic" : "all" });
  if (error || !data) return oneClick ? new Response("Try again", { status: 500 }) : page("Something went wrong", `<h1>That didn't work</h1><p>Try again in a minute.</p>`, 500);
  if (oneClick) return new Response("Unsubscribed", { status: 200, headers: { "Content-Type": "text/plain" } });
  const done = data as { scope: "all" | "topic"; topic: string | null };
  return page("Unsubscribed", `<h1>You're unsubscribed</h1><p>${esc(done.scope === "topic" && done.topic ? `You won't get ${done.topic} emails again.` : "You won't get these emails again.")}</p>`);
}
