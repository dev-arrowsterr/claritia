import { appBase } from "@/lib/billing";
import { entryOf } from "@/lib/sources/catalog";
import { oauthReady, oauthUrl, signState } from "@/lib/sources/oauth";
import { connectSource, isOwner } from "@/lib/sources/server";
import type { Creds, Settings } from "@/lib/sources/types";
import { requireUser } from "@/lib/serverAuth";
import { serviceClient } from "@/lib/serviceClient";

// Connect a tool: POST { workspaceId, kind, keys?, hookSecret?, settings? }. A tool with one-click sign-in returns
// its sign-in link; one connected by key is checked and saved now; a webhook tool gets its URL.

const bad = (error: string, status = 400) => Response.json({ error }, { status });

export async function POST(request: Request) {
  const auth = await requireUser(request);
  if ("denied" in auth) return auth.denied;
  const body = (await request.json().catch(() => ({}))) as { workspaceId?: unknown; kind?: unknown; keys?: Record<string, unknown>; hookSecret?: unknown; settings?: Settings };
  if (!(await isOwner(auth.sb, auth.user.id, body.workspaceId))) return bad("Only owners can connect tools.", 403);
  const ws = body.workspaceId as string;
  const kind = typeof body.kind === "string" ? body.kind : "";
  const e = entryOf(kind);
  if (!e) return bad("Unknown tool.");
  const db = serviceClient();
  if (!db) return bad("The server is not set up for this.", 500);
  const redirect = `${appBase()}/api/sources/callback`;

  try {
    if (kind === "omniscient") {
      const base = process.env.OMNISCIENT_URL?.trim().replace(/\/+$/, "") || "https://app.tryomniscient.com";
      const state = signState({ ws, user: auth.user.id, kind });
      return Response.json({ url: `${base}/connect?${new URLSearchParams({ app: "claritia", redirect_uri: redirect, state })}` });
    }
    const keys = body.keys && typeof body.keys === "object" ? body.keys : null;
    if (e.oauth && !keys) {
      if (!oauthReady(kind)) return bad(`${e.label} sign-in isn't set up yet. Use a key instead.`);
      return Response.json({ url: oauthUrl(kind, redirect, { ws, user: auth.user.id, kind }) });
    }
    let creds: Creds;
    if (e.hook) creds = { type: "hook" };
    else {
      const values: Record<string, string> = {};
      for (const f of e.keys ?? []) {
        const v = typeof keys?.[f.key] === "string" ? (keys[f.key] as string).trim() : "";
        if (!v && !f.optional) return bad(`Fill in ${f.label}.`);
        if (v) values[f.key] = v.slice(0, f.multiline ? 10_000 : 500);
      }
      creds = { type: "key", values };
    }
    const hookSecret = typeof body.hookSecret === "string" && body.hookSecret.trim() ? body.hookSecret.trim().slice(0, 300) : null;
    const s = await connectSource(db, { ws, user: auth.user.id, kind, creds, settings: body.settings, hookSecret });
    return Response.json({ id: s.id, label: s.label });
  } catch (err) {
    return bad(err instanceof Error ? err.message.slice(0, 300) : "Could not connect.", 502);
  }
}
