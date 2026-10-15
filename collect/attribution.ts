// Where a session came from: UTM tags, click ids and the referrer's kind.

export type RefClass = "search" | "ai_assistant" | "review_site" | "social" | "partner" | "email" | "paid" | "direct" | "other";
export type Attribution = {
  source: string | null;
  medium: string | null;
  campaign: string | null;
  term: string | null;
  content: string | null;
  referrer_host: string | null;
  ref_class: RefClass;
};

const KINDS: [RefClass, RegExp][] = [
  ["ai_assistant", /(^|\.)(chatgpt\.com|chat\.openai\.com|openai\.com|perplexity\.ai|claude\.ai|gemini\.google\.com|copilot\.microsoft\.com|you\.com|phind\.com|meta\.ai|grok\.com|chat\.deepseek\.com|chat\.mistral\.ai)$/],
  ["search", /(^|\.)(google\.[a-z.]+|bing\.com|duckduckgo\.com|search\.yahoo\.com|yahoo\.co\.jp|baidu\.com|yandex\.[a-z]+|ecosia\.org|search\.brave\.com|naver\.com|startpage\.com|qwant\.com|kagi\.com)$/],
  ["review_site", /(^|\.)(g2\.com|capterra\.[a-z.]+|trustradius\.com|getapp\.com|softwareadvice\.com|gartner\.com|producthunt\.com|trustpilot\.com|peerspot\.com|sourceforge\.net|saasworthy\.com)$/],
  ["social", /(^|\.)(linkedin\.com|lnkd\.in|twitter\.com|x\.com|t\.co|facebook\.com|fb\.com|instagram\.com|reddit\.com|youtube\.com|youtu\.be|news\.ycombinator\.com|threads\.net|bsky\.app|tiktok\.com|medium\.com|quora\.com)$/],
  ["email", /(^|\.)(mail\.google\.com|outlook\.live\.com|outlook\.office\.com|outlook\.office365\.com|mail\.yahoo\.com|mail\.proton\.me)$/],
];

const PAID_MEDIUM = /^(cpc|ppc|paid|paidsearch|paid_search|paidsocial|paid_social|display|cpm|retargeting|ads?)$/i;
const short = (s: string | null, n = 200) => (s ? s.trim().slice(0, n) || null : null);

/** `landing` is the page URL as sent, `referrer` the full referrer, `ownHosts` the site's domains. */
export function attribute(landing: URL | null, referrer: string | null, ownHosts: string[]): Attribution {
  const q = landing?.searchParams;
  let refHost: string | null = null;
  try {
    refHost = referrer ? new URL(referrer).hostname.toLowerCase().replace(/^www\./, "") : null;
  } catch {}
  if (refHost && ownHosts.some((h) => refHost === h || refHost!.endsWith("." + h))) refHost = null;

  const a: Attribution = {
    source: short(q?.get("utm_source") ?? null),
    medium: short(q?.get("utm_medium") ?? null),
    campaign: short(q?.get("utm_campaign") ?? null),
    term: short(q?.get("utm_term") ?? null),
    content: short(q?.get("utm_content") ?? null),
    referrer_host: refHost,
    ref_class: "other",
  };
  const clickId = q?.get("gclid") ? "google" : q?.get("msclkid") ? "bing" : q?.get("li_fat_id") ? "linkedin" : null;
  if (clickId && !a.source) a.source = clickId;
  if (clickId && !a.medium) a.medium = "cpc";

  const medium = (a.medium ?? "").toLowerCase();
  if (PAID_MEDIUM.test(medium) || clickId) a.ref_class = "paid";
  else if (medium === "email" || medium === "newsletter") a.ref_class = "email";
  else if (medium === "partner" || medium === "affiliate" || medium === "referral_partner") a.ref_class = "partner";
  else if (refHost) a.ref_class = KINDS.find(([, re]) => re.test(refHost!))?.[0] ?? "other";
  else if (medium === "social") a.ref_class = "social";
  else if (!a.source) a.ref_class = "direct";
  if (!a.source && refHost) a.source = refHost;
  return a;
}
