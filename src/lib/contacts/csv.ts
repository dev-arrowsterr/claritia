// CSV in and out for contacts. Reads what spreadsheets save: a byte order mark, commas, semicolons or tabs, quoted
// cells with commas, quotes and line breaks inside, and Windows line ends. A file is read as a stream, so its size
// doesn't matter. Runs in the browser and on the server.

export const MAX_ROWS = 2_000_000;
export const MAX_BYTES = 1_000_000_000;
/** Files up to this size import right away in the web app; bigger ones run as a background job. */
export const INLINE_BYTES = 3_000_000;

/** The delimiter used most in the first line, outside quotes. */
function sniff(text: string): string {
  const counts: Record<string, number> = { ",": 0, ";": 0, "\t": 0 };
  let quoted = false;
  for (const ch of text) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === "\n" || ch === "\r")) break;
    else if (!quoted && ch in counts) counts[ch]++;
  }
  const [best, n] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return n > 0 ? best : ",";
}

/** Reads CSV text pushed in pieces; returns the rows each piece finished. Rows with nothing in them are dropped. */
export class CsvReader {
  private d: string | null = null;
  private row: string[] = [];
  private cell = "";
  private quoted = false;
  private lastCr = false;
  private quoteEnd = false;
  private started = false;
  private head = "";

  push(input: string): string[][] {
    let text = input;
    if (!this.started) {
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      this.head += text;
      // Wait for a full first line (or 64 KB) before choosing the delimiter.
      if (!/[\r\n]/.test(this.head) && this.head.length < 65536) return [];
      this.started = true;
      this.d = sniff(this.head);
      text = this.head;
      this.head = "";
    }
    return this.read(text);
  }

  end(): string[][] {
    if (!this.started) {
      this.started = true;
      this.d = sniff(this.head);
      const out = this.read(this.head);
      this.head = "";
      return [...out, ...this.flush()];
    }
    return this.flush();
  }

  private flush(): string[][] {
    if (this.cell !== "" || this.row.length) {
      this.row.push(this.cell);
      const r = this.row;
      this.row = [];
      this.cell = "";
      return r.some((c) => c.trim() !== "") ? [r] : [];
    }
    return [];
  }

  private read(text: string): string[][] {
    const out: string[][] = [];
    const d = this.d!;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (this.lastCr) {
        this.lastCr = false;
        if (ch === "\n") continue;
      }
      if (this.quoted) {
        if (this.quoteEnd) {
          this.quoteEnd = false;
          if (ch === '"') {
            this.cell += '"';
            continue;
          }
          this.quoted = false;
        } else if (ch === '"') {
          this.quoteEnd = true;
          continue;
        } else {
          this.cell += ch;
          continue;
        }
      }
      if (ch === '"' && this.cell === "") this.quoted = true;
      else if (ch === d) {
        this.row.push(this.cell);
        this.cell = "";
      } else if (ch === "\n" || ch === "\r") {
        if (ch === "\r") this.lastCr = true;
        this.row.push(this.cell);
        if (this.row.some((c) => c.trim() !== "")) out.push(this.row);
        this.row = [];
        this.cell = "";
      } else this.cell += ch;
    }
    return out;
  }
}

/** Rows of cells from CSV text. */
export function parseCsv(input: string): string[][] {
  const r = new CsvReader();
  return [...r.push(input), ...r.end()];
}

/** The text encoding of a file from its first bytes: a byte order mark, valid UTF-8, or Windows-1252. */
export function sniffEncoding(head: Uint8Array): "utf-8" | "utf-16le" | "utf-16be" | "windows-1252" {
  if (head[0] === 0xff && head[1] === 0xfe) return "utf-16le";
  if (head[0] === 0xfe && head[1] === 0xff) return "utf-16be";
  if (head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) return "utf-8";
  try {
    // A multi-byte character cut at the end of the sample isn't an error.
    new TextDecoder("utf-8", { fatal: true }).decode(head.subarray(0, Math.max(0, head.length - 4)));
    return "utf-8";
  } catch {
    return "windows-1252";
  }
}

/** CSV rows from a byte stream, header first. */
export async function* csvRows(bytes: AsyncIterable<Uint8Array>): AsyncGenerator<string[]> {
  const reader = new CsvReader();
  let decoder: TextDecoder | null = null;
  let pending = new Uint8Array(0);
  for await (const chunk of bytes) {
    if (!decoder) {
      const joined = new Uint8Array(pending.length + chunk.length);
      joined.set(pending);
      joined.set(chunk, pending.length);
      if (joined.length < 65536) {
        pending = joined;
        continue;
      }
      decoder = new TextDecoder(sniffEncoding(joined.subarray(0, 65536)));
      yield* reader.push(decoder.decode(joined, { stream: true }));
      pending = new Uint8Array(0);
      continue;
    }
    yield* reader.push(decoder.decode(chunk, { stream: true }));
  }
  if (!decoder) {
    decoder = new TextDecoder(sniffEncoding(pending.subarray(0, 65536)));
    yield* reader.push(decoder.decode(pending, { stream: true }));
  }
  yield* reader.push(decoder.decode());
  yield* reader.end();
}

/** One cell for a CSV file. Cells that a spreadsheet would run as a formula get a leading quote. */
function cellOut(v: unknown): string {
  let s = v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: unknown[][]): string {
  return rows.map((r) => r.map(cellOut).join(",")).join("\r\n") + "\r\n";
}
