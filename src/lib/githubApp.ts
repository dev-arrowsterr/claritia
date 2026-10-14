import "server-only";
import { appJwt } from "./github.ts";

// The GitHub App's settings, from the server's environment:
//   GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, GITHUB_WEBHOOK_SECRET, GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET
export function githubConfig() {
  const appId = process.env.GITHUB_APP_ID?.trim() ?? "";
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY?.trim() ?? "";
  const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET?.trim() ?? "";
  const clientId = process.env.GITHUB_CLIENT_ID?.trim() ?? "";
  const clientSecret = process.env.GITHUB_CLIENT_SECRET?.trim() ?? "";
  if (!appId || !privateKey || !webhookSecret || !clientId || !clientSecret) return null;
  return { appId, privateKey, webhookSecret, clientId, clientSecret };
}

export class GitHubError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** Call the GitHub API. */
export async function gh<T = Record<string, unknown>>(method: string, path: string, token: string, body?: unknown): Promise<T> {
  const res = await fetch(path.startsWith("https://") ? path : `https://api.github.com${path}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "Claritia",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as T & { message?: string };
  if (!res.ok) throw new GitHubError(`GitHub ${method} ${path}: ${res.status} ${data.message ?? ""}`.trim(), res.status);
  return data;
}

const jwt = () => {
  const c = githubConfig();
  if (!c) throw new GitHubError("GitHub isn't set up on the server.", 500);
  return appJwt(c.appId, c.privateKey);
};

/** The app's own details (its slug is in its install link). Kept for an hour. */
let app: { slug: string; at: number } | null = null;
export async function appSlug(): Promise<string> {
  if (app && Date.now() - app.at < 3_600_000) return app.slug;
  const data = await gh<{ slug: string }>("GET", "/app", jwt());
  app = { slug: data.slug, at: Date.now() };
  return data.slug;
}

export async function getInstallation(id: number) {
  return gh<{ id: number; account: { login: string; type: string } }>("GET", `/app/installations/${id}`, jwt());
}

/** A token that acts as one installation, kept until 5 minutes before it runs out. */
const tokens = new Map<number, { token: string; expires: number }>();
export async function installationToken(id: number): Promise<string> {
  const hit = tokens.get(id);
  if (hit && hit.expires - Date.now() > 5 * 60_000) return hit.token;
  const data = await gh<{ token: string; expires_at: string }>("POST", `/app/installations/${id}/access_tokens`, jwt());
  tokens.set(id, { token: data.token, expires: Date.parse(data.expires_at) });
  return data.token;
}

/** Trade the code GitHub sends back after an install for the installing person's token. */
export async function userToken(code: string): Promise<string> {
  const c = githubConfig();
  if (!c) throw new GitHubError("GitHub isn't set up on the server.", 500);
  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "Claritia" },
    body: JSON.stringify({ client_id: c.clientId, client_secret: c.clientSecret, code }),
  });
  const data = (await res.json().catch(() => ({}))) as { access_token?: string; error_description?: string };
  if (!data.access_token) throw new GitHubError(data.error_description ?? "GitHub didn't confirm the install.", 400);
  return data.access_token;
}

/** Whether the person behind a user token can reach an installation. */
export async function userCanReach(token: string, installationId: number): Promise<boolean> {
  for (let page = 1; page <= 10; page++) {
    const data = await gh<{ installations: { id: number }[] }>("GET", `/user/installations?per_page=100&page=${page}`, token);
    if (data.installations.some((i) => i.id === installationId)) return true;
    if (data.installations.length < 100) return false;
  }
  return false;
}
