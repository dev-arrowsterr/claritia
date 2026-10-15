// The domain lists in Settings › Identity: split on commas or spaces, drop http://, www. and a leading @.

const DOMAIN = /^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export function domainList(text: string): { ok: string[]; bad: string[] } {
  const ok: string[] = [];
  const bad: string[] = [];
  for (const raw of text.split(/[\s,]+/)) {
    const d = raw.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^@/, "").replace(/^www\./, "").split("/")[0];
    if (!d) continue;
    if (!DOMAIN.test(d)) bad.push(raw.trim());
    else if (!ok.includes(d)) ok.push(d);
  }
  return { ok, bad };
}
