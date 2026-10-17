// One-click sign-in for the tools that offer it. Each needs Claritia's own app registered once with that tool
// (its client id and secret as <PREFIX>_CLIENT_ID and <PREFIX>_CLIENT_SECRET). Without them, the tool takes a
// pasted key instead. State is signed with SECRETS_KEY and carries the PKCE verifier, so nothing is stored.

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export type OauthCfg = { env: string; authorize: string; token: string; scope?: string; basic?: boolean; pkce?: boolean; extra?: Record<string, string> };

export const OAUTH: Record<string, OauthCfg> = {
  hubspot: {
    env: "HUBSPOT",
    authorize: "https://app.hubspot.com/oauth/authorize",
    token: "https://api.hubapi.com/oauth/v1/token",
    scope: "oauth crm.objects.contacts.read crm.objects.contacts.write crm.objects.companies.read crm.lists.read crm.schemas.contacts.read crm.schemas.contacts.write",
    // Timeline events for email and form activity; without it, activity goes in as notes.
    extra: { optional_scope: "timeline" },
  },
  salesforce: { env: "SALESFORCE", authorize: "https://login.salesforce.com/services/oauth2/authorize", token: "https://login.salesforce.com/services/oauth2/token", scope: "api refresh_token", pkce: true },
  pipedrive: { env: "PIPEDRIVE", authorize: "https://oauth.pipedrive.com/oauth/authorize", token: "https://oauth.pipedrive.com/oauth/token", basic: true },
  attio: { env: "ATTIO", authorize: "https://app.attio.com/authorize", token: "https://app.attio.com/oauth/token" },
  mailchimp: { env: "MAILCHIMP", authorize: "https://login.mailchimp.com/oauth2/authorize", token: "https://login.mailchimp.com/oauth2/token" },
};

const env = (name: string) => process.env[name]?.trim() ?? "";
const clientId = (kind: string) => env(`${OAUTH[kind]?.env}_CLIENT_ID`);
const clientSecret = (kind: string) => env(`${OAUTH[kind]?.env}_CLIENT_SECRET`);

export const oauthReady = (kind: string) => Boolean(OAUTH[kind] && clientId(kind) && clientSecret(kind));
/** The secret a tool signs its app-wide webhooks with (HubSpot v3 signatures use the client secret). */
export const appSecret = (kind: string) => clientSecret(kind);

export type State = { ws: string; user: string; kind: string; verifier?: string; exp: number };

function stateKey() {
  const k = env("SECRETS_KEY");
  if (k.length < 32) throw new Error("Add SECRETS_KEY (32 or more random characters) on Render.");
  return createHash("sha256").update(`oauth-state:${k}`).digest();
}

export function signState(s: Omit<State, "exp">, now = Date.now()) {
  const body = Buffer.from(JSON.stringify({ ...s, exp: now + 15 * 60_000 })).toString("base64url");
  return `${body}.${createHmac("sha256", stateKey()).update(body).digest("base64url")}`;
}

export function readState(raw: string | null, now = Date.now()): State | null {
  const [body, sig] = (raw ?? "").split(".");
  if (!body || !sig) return null;
  const want = Buffer.from(createHmac("sha256", stateKey()).update(body).digest("base64url"));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  try {
    const s = JSON.parse(Buffer.from(body, "base64url").toString()) as State;
    return typeof s.ws === "string" && typeof s.user === "string" && typeof s.kind === "string" && s.exp > now ? s : null;
  } catch {
    return null;
  }
}

/** The tool's sign-in link. */
export function oauthUrl(kind: string, redirectUri: string, s: Omit<State, "exp" | "verifier">) {
  const c = OAUTH[kind];
  const verifier = c.pkce ? randomBytes(32).toString("base64url") : undefined;
  const q = new URLSearchParams({ client_id: clientId(kind), redirect_uri: redirectUri, response_type: "code", state: signState({ ...s, verifier }) });
  if (c.scope) q.set("scope", c.scope);
  if (verifier) {
    q.set("code_challenge", createHash("sha256").update(verifier).digest("base64url"));
    q.set("code_challenge_method", "S256");
  }
  for (const [k, v] of Object.entries(c.extra ?? {})) q.set(k, v);
  return `${c.authorize}?${q}`;
}

export type Token = { access: string; refresh: string | null; expiresAt: number; extra: Record<string, string> };

async function tokenCall(kind: string, params: Record<string, string>, fetcher: typeof fetch = fetch): Promise<Token> {
  const c = OAUTH[kind];
  const body = new URLSearchParams(c.basic ? params : { ...params, client_id: clientId(kind), client_secret: clientSecret(kind) });
  const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" };
  if (c.basic) headers.Authorization = `Basic ${Buffer.from(`${clientId(kind)}:${clientSecret(kind)}`).toString("base64")}`;
  const res = await fetcher(c.token, { method: "POST", headers, body });
  const t = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || typeof t.access_token !== "string") throw new Error(String(t.error_description ?? t.message ?? t.error ?? `Sign-in failed (${res.status})`));
  const extra: Record<string, string> = {};
  // Salesforce's org address, Pipedrive's company address.
  for (const k of ["instance_url", "api_domain", "id"]) if (typeof t[k] === "string") extra[k] = t[k] as string;
  return {
    access: t.access_token,
    refresh: typeof t.refresh_token === "string" ? t.refresh_token : null,
    // Salesforce doesn't say; its sessions last at least 2 hours.
    expiresAt: Date.now() + (Number(t.expires_in) || 7200) * 1000,
    extra,
  };
}

export const oauthExchange = (kind: string, code: string, redirectUri: string, verifier?: string) =>
  tokenCall(kind, { grant_type: "authorization_code", code, redirect_uri: redirectUri, ...(verifier ? { code_verifier: verifier } : {}) });

export const oauthRefresh = (kind: string, refresh: string, fetcher?: typeof fetch) => tokenCall(kind, { grant_type: "refresh_token", refresh_token: refresh }, fetcher);
