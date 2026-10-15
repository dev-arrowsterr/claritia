// Company domains (docs/account-intelligence.md 5.1): clean to the registrable domain with the Public Suffix List,
// keep the full name for companies living on a hosting domain, and find redirect aliases (acme.io → acme.com).

import { isIP } from "node:net";
import { domainToASCII } from "node:url";
import psl from "psl";
import { hostIsPrivate } from "../privateNet.ts";

// Hosting domains the Public Suffix List doesn't list (most hosts, like vercel.app or github.io, are on it).
const HOSTING = new Set([
  "wixsite.com", "squarespace.com", "hs-sites.com", "hubspotpagebuilder.com", "hubspotpagebuilder.eu", "carrd.co", "notion.site",
  "framer.website", "framer.app", "webflow.io", "weebly.com", "godaddysites.com", "mystrikingly.com", "jimdosite.com", "site123.me",
  "tilda.ws", "ueniweb.com", "glitch.me", "replit.app", "bubbleapps.io", "softr.app", "typedream.app", "super.site", "gitbook.io",
  "substack.com", "medium.com", "beehiiv.com", "ghost.io", "wordpress.com", "blogspot.com", "tumblr.com", "linktr.ee",
]);

// Hosting suffixes on the Public Suffix List: psl keeps the company's label, and the domain is marked hosted.
const HOSTED_SUFFIX = new Set([
  "vercel.app", "netlify.app", "github.io", "gitlab.io", "herokuapp.com", "pages.dev", "workers.dev", "web.app", "firebaseapp.com",
  "azurewebsites.net", "cloudfront.net", "appspot.com", "myshopify.com", "onrender.com", "fly.dev", "readthedocs.io", "surge.sh",
  "netlify.com", "now.sh", "repl.co", "bitbucket.io", "azurestaticapps.net", "amplifyapp.com", "elasticbeanstalk.com", "deno.dev",
]);

export type CleanDomain = { domain: string; hosted: boolean };

/** The registrable domain for a URL, email domain or host, or null when it isn't a public domain. */
export function cleanDomain(raw: unknown): CleanDomain | null {
  if (typeof raw !== "string") return null;
  let s = raw.trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/^[^/@]*@/, "");
  s = s.split(/[/?#]/)[0].replace(/:\d+$/, "").replace(/\.$/, "");
  s = domainToASCII(s);
  if (!s || isIP(s) || !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s)) return null;
  const p = psl.parse(s);
  if ("error" in p && p.error) return null;
  const parsed = p as { domain: string | null; subdomain: string | null; listed: boolean };
  if (!parsed.listed || !parsed.domain) return null;
  if (HOSTING.has(parsed.domain)) {
    const label = parsed.subdomain?.split(".").pop();
    if (!label || label === "www") return { domain: parsed.domain, hosted: true };
    return { domain: `${label}.${parsed.domain}`, hosted: true };
  }
  const suffix = (p as { tld: string | null }).tld ?? "";
  return { domain: parsed.domain, hosted: HOSTED_SUFFIX.has(suffix) || HOSTING.has(suffix) };
}

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Where `https://<domain>/` ends up after up to 5 redirects, as a registrable domain, or null when it stays put or
 * can't be reached. Private hosts are never fetched.
 */
export async function redirectAlias(domain: string, deps: { fetcher?: Fetcher; isPrivate?: (host: string) => Promise<boolean> } = {}): Promise<string | null> {
  const fetcher = deps.fetcher ?? fetch;
  const isPrivate = deps.isPrivate ?? ((h: string) => hostIsPrivate(h));
  let url = `https://${domain}/`;
  for (let hop = 0; hop < 5; hop++) {
    const host = new URL(url).hostname;
    if (await isPrivate(host)) return null;
    let res: Response;
    try {
      res = await fetcher(url, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(5000), headers: { "user-agent": "ClaritiaBot/1.0 (+https://tryclaritia.com/bot)" } });
    } catch {
      return null;
    }
    const loc = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (!loc) break;
    try {
      url = new URL(loc, url).toString();
    } catch {
      return null;
    }
    if (!/^https?:/.test(url)) return null;
  }
  const end = cleanDomain(new URL(url).hostname);
  return end && end.domain !== domain ? end.domain : null;
}
