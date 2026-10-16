import { appBase } from "@/lib/billing";
import { oauthExchange, readState } from "@/lib/sources/oauth";
import { connectSource } from "@/lib/sources/server";
import { serviceClient } from "@/lib/serviceClient";

// Tools send people back here after they allow access (OAuth), and Omniscient after its one-click approve page.
// Save the sealed sign-in, start the first pull, and go back to Settings › Sources.

export async function GET(request: Request) {
  const url = new URL(request.url);
  const base = appBase();
  const go = (q: Record<string, string>) => Response.redirect(`${base}/settings/sources?${new URLSearchParams(q)}`, 302);
  const state = readState(url.searchParams.get("state"));
  if (!state) return go({ error: "The sign-in link expired. Try again." });
  if (url.searchParams.get("error")) return go({ error: url.searchParams.get("error_description") || "Access was not allowed." });
  const code = url.searchParams.get("code") ?? "";
  const db = serviceClient();
  if (!db || !code) return go({ error: "Could not connect." });
  try {
    const redirect = `${base}/api/sources/callback`;
    if (state.kind === "omniscient") {
      const omni = process.env.OMNISCIENT_URL?.trim().replace(/\/+$/, "") || "https://app.tryomniscient.com";
      const res = await fetch(`${omni}/api/v1/connect/token`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, redirect_uri: redirect }) });
      const t = (await res.json().catch(() => ({}))) as { key?: string; error?: { message?: string } };
      if (!res.ok || !t.key) throw new Error(t.error?.message ?? "Omniscient didn't accept the code.");
      const s = await connectSource(db, { ws: state.ws, user: state.user, kind: "omniscient", creds: { type: "key", values: { api_key: t.key, url: omni } } });
      return go({ connected: s.id });
    }
    const tok = await oauthExchange(state.kind, code, redirect, state.verifier);
    const s = await connectSource(db, { ws: state.ws, user: state.user, kind: state.kind, creds: { type: "oauth", access: tok.access, refresh: tok.refresh, expiresAt: tok.expiresAt, extra: tok.extra } });
    return go({ connected: s.id });
  } catch (e) {
    return go({ error: e instanceof Error ? e.message.slice(0, 200) : "Could not connect." });
  }
}
