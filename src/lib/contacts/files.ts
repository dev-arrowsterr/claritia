// Reading an import file as rows, whatever it is: CSV, TSV or TXT (any encoding), Excel .xlsx, or vCard. Rows
// stream, so a file of any size reads in steady memory. Server only (the web app's routes and claritia-intel).

import { Readable } from "node:stream";
import ExcelJS from "exceljs";
import { unzipSync, strFromU8 } from "fflate";
import { csvRows } from "./csv.ts";
import { VCARD_HEADER, vcardRows } from "./vcard.ts";

export type FileKind = "csv" | "xlsx" | "vcf";

export function kindOf(name: string): FileKind | null {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  if (["csv", "tsv", "txt", "tab"].includes(ext)) return "csv";
  if (ext === "xlsx" || ext === "xlsm") return "xlsx";
  if (ext === "vcf" || ext === "vcard") return "vcf";
  return null;
}

/** A spreadsheet cell as text: dates as dates, formulas as their result, rich text and links as their text. */
export function cellText(v: unknown): string {
  if (v == null) return "";
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return "";
    const iso = v.toISOString();
    return iso.endsWith("T00:00:00.000Z") ? iso.slice(0, 10) : iso;
  }
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (Array.isArray(o.richText)) return (o.richText as { text: string }[]).map((t) => t.text).join("");
    if ("result" in o) return cellText(o.result);
    if ("text" in o) return cellText(o.text);
    if ("error" in o) return "";
    return "";
  }
  return String(v);
}

/** Sheet names in an .xlsx, from its workbook part. */
export function xlsxSheets(bytes: Uint8Array): string[] {
  const files = unzipSync(bytes, { filter: (f) => f.name === "xl/workbook.xml" });
  const xml = files["xl/workbook.xml"] ? strFromU8(files["xl/workbook.xml"]) : "";
  return [...xml.matchAll(/<sheet\b[^>]*\bname="([^"]*)"/g)].map((m) =>
    m[1].replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'"),
  );
}

async function* xlsxRows(bytes: AsyncIterable<Uint8Array>, sheet?: string | null): AsyncGenerator<string[]> {
  // Styles are read so date cells come back as dates.
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(Readable.from(bytes), { worksheets: "emit", sharedStrings: "cache", hyperlinks: "ignore", styles: "cache", entries: "ignore" });
  let first = true;
  for await (const ws of reader) {
    const name = (ws as unknown as { name?: string }).name;
    const take = sheet ? name === sheet : first;
    first = false;
    if (!take) {
      for await (const row of ws) void row;
      continue;
    }
    let width = 0;
    let header: string[] | null = null;
    for await (const row of ws) {
      const values = (row as unknown as { values: unknown[] }).values ?? [];
      // Row values start at index 1.
      const cells = Array.from({ length: Math.max(values.length - 1, width) }, (_, i) => cellText(values[i + 1]).trim());
      if (!header) {
        // Merged or blank header cells take the one before them, so every column has a name.
        header = cells.map((c, i) => c || (i > 0 ? `${cells[i - 1] || `Column ${i}`} ${i + 1}` : `Column ${i + 1}`));
        width = header.length;
        yield header;
        continue;
      }
      if (cells.some((c) => c !== "")) yield cells.slice(0, Math.max(width, cells.length));
    }
    return;
  }
}

async function* vcfRows(bytes: AsyncIterable<Uint8Array>): AsyncGenerator<string[]> {
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of bytes) {
    text += decoder.decode(chunk, { stream: true });
    // Emit finished cards as they come.
    const end = text.lastIndexOf("END:VCARD");
    if (end >= 0) {
      const cut = end + "END:VCARD".length;
      const rows = vcardRows(text.slice(0, cut));
      text = text.slice(cut);
      if (rows.length) yield* rows;
    }
  }
  text += decoder.decode();
  yield* vcardRows(text);
}

/** Rows of a file, header first. */
export async function* fileRows(kind: FileKind, bytes: AsyncIterable<Uint8Array>, sheet?: string | null): AsyncGenerator<string[]> {
  if (kind === "xlsx") yield* xlsxRows(bytes, sheet);
  else if (kind === "vcf") {
    yield VCARD_HEADER;
    yield* vcfRows(bytes);
  } else yield* csvRows(bytes);
}

export type Inspection = { header: string[]; samples: string[][]; rows: number; done: boolean; sheets: string[] };

/** The header, the first rows, and a row count (exact when the file was read to the end within the limit). */
export async function inspect(kind: FileKind, bytes: AsyncIterable<Uint8Array>, opts: { sheet?: string | null; sheets?: string[]; samples?: number; countUpTo?: number } = {}): Promise<Inspection> {
  const want = opts.samples ?? 20;
  const limit = opts.countUpTo ?? 200_000;
  let header: string[] = [];
  const samples: string[][] = [];
  let rows = 0;
  let done = true;
  for await (const r of fileRows(kind, bytes, opts.sheet)) {
    if (!header.length) {
      header = r;
      continue;
    }
    rows++;
    if (samples.length < want) samples.push(r);
    if (rows >= limit) {
      done = false;
      break;
    }
  }
  return { header, samples, rows, done, sheets: opts.sheets ?? [] };
}

/** Bytes as an async iterable, from a web stream, a Blob or a buffer. */
export async function* chunksOf(src: ReadableStream<Uint8Array> | Blob | Uint8Array): AsyncGenerator<Uint8Array> {
  if (src instanceof Uint8Array) {
    for (let i = 0; i < src.length; i += 1 << 20) yield src.subarray(i, i + (1 << 20));
    return;
  }
  const stream = src instanceof Blob ? src.stream() : src;
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value?.length) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}
