// The suite: Claritia's links to Omniscient (CRM, deal rooms) and Arrowsterr (SEO and AI search). Each workspace
// saves the product's address and an API key from that product; the server seals the key and checks it with one
// call to the product's GET /api/v1/me (docs/marketing-platform.md Part 5).
import { hostIsPrivate } from "./privateNet.ts";

export type Product = "omniscient" | "arrowsterr";

export const PRODUCTS: Record<Product, { name: string; placeholder: string }> = {
  omniscient: { name: "Omniscient", placeholder: "https://app.omniscient.ai" },
  arrowsterr: { name: "Arrowsterr", placeholder: "https://app.arrowsterr.com" },
};

export const isProduct = (p: unknown): p is Product => p === "omniscient" || p === "arrowsterr";

/** "https://host" from what someone typed, or an error. Only https, no path, no credentials. */
export function cleanBaseUrl(input: string): { url: string } | { error: string } {
  let u: URL;
  try {
    u = new URL(input.trim().includes("://") ? input.trim() : `https://${input.trim()}`);
  } catch {
    return { error: "That isn't a web address." };
  }
  if (u.protocol !== "https:") return { error: "The address must start with https://." };
  if (u.username || u.password) return { error: "Leave the user name and password out of the address." };
  if (!/^[a-z0-9.-]+$/.test(u.hostname)) return { error: "That isn't a web address." };
  return { url: `https://${u.host.toLowerCase()}` };
}

export type CheckResult = { ok: true; detail: string } | { ok: false; error: string };

/**
 * One call to the product's GET /api/v1/me with the key. Refuses private addresses, doesn't follow redirects,
 * gives up after 8 seconds, and reads at most 64 KB.
 */
export async function checkConnection(product: Product, baseUrl: string, key: string, deps: { fetch?: typeof fetch; isPrivate?: (host: string) => Promise<boolean> } = {}): Promise<CheckResult> {
  const name = PRODUCTS[product].name;
  const host = new URL(baseUrl).hostname;
  if (await (deps.isPrivate ?? hostIsPrivate)(host)) return { ok: false, error: `${host} points to a private network address.` };
  let res: Response;
  try {
    res = await (deps.fetch ?? fetch)(`${baseUrl}/api/v1/me`, {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json", "User-Agent": "Claritia" },
      redirect: "manual",
      signal: AbortSignal.timeout(8000),
    });
  } catch (e) {
    const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
    return { ok: false, error: timedOut ? `${host} didn't answer within 8 seconds.` : `Couldn't reach ${host}.` };
  }
  if (res.status === 401 || res.status === 403) return { ok: false, error: `${name} didn't accept the key.` };
  if (res.status === 404) return { ok: false, error: `${host} doesn't have the Claritia connection yet.` };
  if (res.status >= 300 && res.status < 400) return { ok: false, error: `${host} sent Claritia somewhere else. Use the address it sends you to.` };
  if (!res.ok) return { ok: false, error: `${name} answered with an error (${res.status}).` };
  const text = (await res.text()).slice(0, 65_536);
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { ok: false, error: `${host} didn't answer like ${name}.` };
  }
  const who = [body.workspace, body.name, body.email].find((v) => typeof v === "string" && v.trim()) as string | undefined;
  return { ok: true, detail: who ? who.trim().slice(0, 120) : name };
}

/** The last characters of a key, to show which key is saved. */
export const keyHint = (key: string) => `…${key.trim().slice(-4)}`;
