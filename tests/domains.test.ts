import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanDomain, redirectAlias } from "../src/lib/company/domains.ts";

// 100 labeled inputs: what a person would call the company's domain (null: not a company domain).
const LABELED: [string, string | null][] = [
  ["acme.com", "acme.com"], ["www.acme.com", "acme.com"], ["https://www.acme.com/pricing?x=1", "acme.com"], ["ACME.COM", "acme.com"], [" acme.com ", "acme.com"],
  ["app.acme.com", "acme.com"], ["eu.app.acme.com", "acme.com"], ["acme.com:8443", "acme.com"], ["acme.com.", "acme.com"], ["http://acme.com", "acme.com"],
  ["jane@acme.com", "acme.com"], ["mailto:jane@acme.com", "acme.com"], ["acme.co.uk", "acme.co.uk"], ["app.eu.acme.co.uk", "acme.co.uk"], ["www.acme.co.uk", "acme.co.uk"],
  ["acme.com.au", "acme.com.au"], ["shop.acme.com.au", "acme.com.au"], ["acme.co.jp", "acme.co.jp"], ["acme.com.br", "acme.com.br"], ["acme.co.nz", "acme.co.nz"],
  ["acme.de", "acme.de"], ["www.acme.de", "acme.de"], ["acme.fr", "acme.fr"], ["acme.io", "acme.io"], ["app.acme.io", "acme.io"],
  ["acme.ai", "acme.ai"], ["acme.dev", "acme.dev"], ["acme.app", "acme.app"], ["acme.tech", "acme.tech"], ["acme.cloud", "acme.cloud"],
  ["acme.vercel.app", "acme.vercel.app"], ["preview-123.acme.vercel.app", "acme.vercel.app"], ["acme.netlify.app", "acme.netlify.app"], ["acme.github.io", "acme.github.io"], ["docs.acme.github.io", "acme.github.io"],
  ["acme.herokuapp.com", "acme.herokuapp.com"], ["acme.pages.dev", "acme.pages.dev"], ["acme.web.app", "acme.web.app"], ["acme.firebaseapp.com", "acme.firebaseapp.com"], ["acme.azurewebsites.net", "acme.azurewebsites.net"],
  ["acme.myshopify.com", "acme.myshopify.com"], ["acme.onrender.com", "acme.onrender.com"], ["acme.fly.dev", "acme.fly.dev"], ["acme.workers.dev", "acme.workers.dev"], ["acme.gitlab.io", "acme.gitlab.io"],
  ["acme.wixsite.com", "acme.wixsite.com"], ["acme.wixsite.com/home", "acme.wixsite.com"], ["acme.squarespace.com", "acme.squarespace.com"], ["acme.webflow.io", "acme.webflow.io"], ["acme.hs-sites.com", "acme.hs-sites.com"],
  ["acme.notion.site", "acme.notion.site"], ["acme.carrd.co", "acme.carrd.co"], ["acme.framer.website", "acme.framer.website"], ["acme.substack.com", "acme.substack.com"], ["acme.gitbook.io", "acme.gitbook.io"],
  ["acme.blogspot.com", "acme.blogspot.com"], ["acme.wordpress.com", "acme.wordpress.com"], ["acme.readthedocs.io", "acme.readthedocs.io"], ["acme.ghost.io", "acme.ghost.io"], ["acme.beehiiv.com", "acme.beehiiv.com"],
  ["bücher.de", "xn--bcher-kva.de"], ["www.bücher.de", "xn--bcher-kva.de"], ["münchen-firma.de", "xn--mnchen-firma-dlb.de"], ["xn--bcher-kva.de", "xn--bcher-kva.de"], ["acme-corp.com", "acme-corp.com"],
  ["a1.com", "a1.com"], ["3m.com", "3m.com"], ["x.com", "x.com"], ["about.x.com", "x.com"], ["google.com", "google.com"],
  ["mail.google.com", "google.com"], ["salesforce.com", "salesforce.com"], ["login.salesforce.com", "salesforce.com"], ["acme.my.salesforce.com", "salesforce.com"], ["amazon.co.uk", "amazon.co.uk"],
  ["bbc.co.uk", "bbc.co.uk"], ["gov.uk", null], ["www.gov.uk", "www.gov.uk"], ["co.uk", null], ["com", null],
  ["localhost", null], ["127.0.0.1", null], ["10.0.0.5", null], ["[::1]", null], ["::1", null],
  ["", null], ["   ", null], ["not a domain", null], ["acme", null], ["acme.notarealtld", null],
  ["http://", null], ["acme..com", null], ["-acme.com", null], ["acme.com/", "acme.com"], ["acme.com#x", "acme.com"],
  ["sub.acme.org", "acme.org"], ["acme.org.uk", "acme.org.uk"], ["blog.acme.co", "acme.co"], ["acme.amplifyapp.com", "acme.amplifyapp.com"], ["shop.acme.store", "acme.store"],
];

test("domain cleaning: 100 labeled inputs, at least 98 right", () => {
  assert.equal(LABELED.length, 100);
  const wrong = LABELED.filter(([input, want]) => (cleanDomain(input)?.domain ?? null) !== want);
  for (const [input, want] of wrong) console.log(`  wrong: ${JSON.stringify(input)} -> ${cleanDomain(input)?.domain ?? null}, want ${want}`);
  assert.ok(wrong.length <= 2, `${wrong.length} wrong`);
});

test("hosted domains are marked", () => {
  assert.equal(cleanDomain("acme.vercel.app")?.hosted, true);
  assert.equal(cleanDomain("acme.wixsite.com")?.hosted, true);
  assert.equal(cleanDomain("acme.co.uk")?.hosted, false);
  assert.equal(cleanDomain("acme.com")?.hosted, false);
});

test("redirect aliases follow up to 5 hops and never fetch private hosts", async () => {
  const hops: Record<string, string> = { "https://acme.io/": "https://www.acme.com/", "https://www.acme.com/": "/en" };
  const fetcher = async (url: string) => new Response(null, hops[url] ? { status: 301, headers: { location: hops[url] } } : { status: 200 });
  const pub = async () => false;
  assert.equal(await redirectAlias("acme.io", { fetcher, isPrivate: pub }), "acme.com");
  assert.equal(await redirectAlias("acme.com", { fetcher, isPrivate: pub }), null, "no redirect");
  const loop = async (url: string) => new Response(null, { status: 302, headers: { location: url.replace("https://", "https://x.") } });
  assert.equal(await redirectAlias("loop.com", { fetcher: loop, isPrivate: pub }), null, "stops after 5 and stays on the same domain");
  const toPrivate = async () => new Response(null, { status: 302, headers: { location: "http://internal.local/" } });
  let fetched = 0;
  assert.equal(await redirectAlias("evil.com", { fetcher: async () => (fetched++, toPrivate()), isPrivate: async (h) => h.endsWith(".local") }), null);
  assert.equal(fetched, 1, "the private host isn't fetched");
  assert.equal(await redirectAlias("down.com", { fetcher: async () => { throw new Error("timeout"); }, isPrivate: pub }), null);
});
