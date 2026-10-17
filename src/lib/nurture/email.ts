// A nurture step's email: paragraphs and one button in a plain layout, and back again for editing. Safe to use in the
// browser (no SDK, no Node modules).

export type StepBody = { paragraphs: string[]; cta_label: string; cta_url: string };

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** A step as email HTML and plain text, in one simple layout. Also the links, in order, for click tokens. */
export function stepEmail(s: StepBody, color = "#266df0"): { html: string; text: string; links: string[] } {
  const paras = s.paragraphs.map((p) => `<p style="margin:0 0 16px">${esc(p).replace(/\n/g, "<br>")}</p>`).join("");
  const cta = s.cta_url && s.cta_label ? `<p style="margin:24px 0 0"><a href="${esc(s.cta_url)}" style="display:inline-block;background:${color};color:#fff;text-decoration:none;padding:10px 16px;border-radius:6px">${esc(s.cta_label)}</a></p>` : "";
  const html = `<!doctype html><html><body style="margin:0;padding:24px 16px;background:#ffffff"><div style="max-width:560px;margin:0 auto;font:15px/1.6 -apple-system,Segoe UI,Arial,sans-serif;color:#0c0c0b">${paras}${cta}</div></body></html>`;
  const text = `${s.paragraphs.join("\n\n")}${s.cta_url && s.cta_label ? `\n\n${s.cta_label}: ${s.cta_url}` : ""}\n`;
  return { html, text, links: s.cta_url && s.cta_label ? [s.cta_url] : [] };
}

/** Pull paragraphs and the button back out of a step's email, for editing. */
export function readStep(html: string, text: string): StepBody {
  const btn = html.match(/<a href="([^"]+)"[^>]*>([^<]*)<\/a><\/p><\/div>/);
  const unesc = (s: string) => s.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  const cta_url = btn ? unesc(btn[1]) : "";
  const cta_label = btn ? unesc(btn[2]) : "";
  let body = text.trimEnd();
  if (cta_url && body.endsWith(`${cta_label}: ${cta_url}`)) body = body.slice(0, -`${cta_label}: ${cta_url}`.length).trimEnd();
  return { paragraphs: body.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean), cta_label, cta_url };
}
