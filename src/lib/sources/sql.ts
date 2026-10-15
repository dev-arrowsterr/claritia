// Checks for a warehouse source's saved query (docs/contact-sources.md Part 8). Runs in the browser and on the
// server: one SELECT, nothing that writes, key and cursor columns named, and `:cursor` found outside quoted text.

export const START_CURSOR = "1970-01-01 00:00:00";
const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

export type WhQuery = { sql: string; key: string; cursor: string; target: "contacts" | "companies" | "events" | `object:${string}`; event?: string; email?: string };

/** The SQL with comments and quoted text blanked out, so checks only see the statement's own words. */
export function bare(sql: string): string {
  let out = "";
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    const two = sql.slice(i, i + 2);
    if (two === "--") {
      while (i < sql.length && sql[i] !== "\n") i++;
      out += " ";
    } else if (two === "/*") {
      const end = sql.indexOf("*/", i + 2);
      i = end < 0 ? sql.length : end + 1;
      out += " ";
    } else if (ch === "'" || ch === '"' || ch === "`") {
      let j = i + 1;
      for (; j < sql.length; j++) {
        if (sql[j] === ch && sql[j + 1] === ch) j++;
        else if (sql[j] === ch) break;
        else if (sql[j] === "\\" && ch === "'") j++;
      }
      out += " ".repeat(j - i + 1);
      i = j;
    } else out += ch;
  }
  return out;
}

/** What's wrong with a query, or null. */
export function queryError(q: Partial<WhQuery>): string | null {
  const sql = (q.sql ?? "").trim().replace(/;\s*$/, "");
  if (!sql) return "Write a query.";
  if (sql.length > 20_000) return "The query is too long.";
  const b = bare(sql);
  if (b.includes(";")) return "One statement only.";
  if (!/^\s*(select|with)\b/i.test(b)) return "Start with SELECT or WITH.";
  if (/\b(insert|update|delete|merge|drop|alter|create|truncate|grant|revoke|copy|call|exec|execute|into)\b/i.test(b)) return "Only reading is allowed.";
  if (!q.key || !IDENT.test(q.key)) return "Name the key column.";
  if (!q.cursor || !IDENT.test(q.cursor)) return "Name the cursor column.";
  if (q.target === "events" && q.event && !/^[a-z][a-z0-9_.]{1,60}$/.test(q.event)) return "Name the activity in lowercase, like product.signup.";
  return null;
}

/** Put the driver's placeholder where `:cursor` is, outside quoted text. Returns how many there were. */
export function bindCursor(sql: string, placeholder: (n: number) => string): { sql: string; count: number } {
  const b = bare(sql);
  let out = "";
  let count = 0;
  let last = 0;
  const re = /:cursor\b/g;
  for (let m = re.exec(b); m; m = re.exec(b)) {
    out += sql.slice(last, m.index) + placeholder(++count);
    last = m.index + m[0].length;
  }
  return { sql: out + sql.slice(last), count };
}

