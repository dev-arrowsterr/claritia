// vCard 3.0 and 4.0 (exports from phones, Outlook and Apple Contacts) to rows with a header, for the importer.

export const VCARD_HEADER = ["First name", "Last name", "Email", "Phone", "Company", "Title", "Country"];

/** Unfold lines, split cards, and keep the fields the importer maps. Several emails make several rows. */
export function vcardRows(text: string): string[][] {
  const lines = text.replace(/\r\n?/g, "\n").replace(/\n[ \t]/g, "").split("\n");
  const rows: string[][] = [];
  let card: Record<string, string[]> | null = null;
  const unescape = (s: string) => s.replace(/\\n/gi, " ").replace(/\\([,;\\])/g, "$1").trim();
  for (const line of lines) {
    if (/^BEGIN:VCARD/i.test(line)) card = {};
    else if (/^END:VCARD/i.test(line) && card) {
      const [last = "", first = ""] = (card.N?.[0] ?? "").split(";").map(unescape);
      let fn = first;
      let ln = last;
      if (!fn && !ln && card.FN?.[0]) {
        const parts = unescape(card.FN[0]).split(/\s+/);
        fn = parts[0];
        ln = parts.slice(1).join(" ");
      }
      const org = unescape((card.ORG?.[0] ?? "").split(";")[0]);
      const adr = (card.ADR?.[0] ?? "").split(";");
      const country = unescape(adr[6] ?? "");
      const emails = (card.EMAIL ?? []).map(unescape).filter(Boolean);
      for (const email of emails.length ? emails : [""]) rows.push([fn, ln, email, unescape(card.TEL?.[0] ?? ""), org, unescape(card.TITLE?.[0] ?? ""), country]);
      card = null;
    } else if (card) {
      const m = /^(?:item\d+\.)?([A-Za-z-]+)(?:;[^:]*)?:(.*)$/.exec(line);
      if (!m) continue;
      const key = m[1].toUpperCase();
      (card[key] ??= []).push(m[2]);
    }
  }
  return rows;
}
