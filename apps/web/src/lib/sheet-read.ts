/**
 * Owner 2026-10-04 — reading a vendor's price list in the browser: a CSV file, an Excel (.xlsx) file, or rows
 * copied from Excel and pasted (tab-separated). Every reader returns the same thing: rows of text cells, the
 * first row being whatever the vendor wrote as headings. Nothing leaves the browser until the person asks
 * for the rows to be matched.
 */
export type Grid = string[][];

/** CSV (or TSV) text → rows; quotes, doubled quotes and line breaks inside quotes are honoured. */
export function parseDelimited(text: string): Grid {
  const sep = (text.split(/\r?\n/, 1)[0] ?? "").includes("\t") ? "\t" : ",";
  const rows: Grid = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') quoted = false; else cell += c;
    } else if (c === '"' && cell === "") quoted = true;
    else if (c === sep) { row.push(cell.trim()); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell.trim()); cell = "";
      if (row.some((x) => x !== "")) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell.trim());
  if (row.some((x) => x !== "")) rows.push(row);
  return rows.map((r) => r.map((x) => x.replace(/^﻿/, "")));
}

/** The files inside a ZIP (an .xlsx is one), inflated with the browser's own DecompressionStream. */
async function unzip(bytes: Uint8Array, wanted: (name: string) => boolean): Promise<Map<string, string>> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65_557); i--) if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("not an Excel (.xlsx) file");
  const count = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);
  const out = new Map<string, string>();
  const dec = new TextDecoder();
  for (let n = 0; n < count; n++) {
    const method = view.getUint16(at + 10, true);
    const size = view.getUint32(at + 20, true);
    const nameLen = view.getUint16(at + 28, true);
    const extraLen = view.getUint16(at + 30, true);
    const commentLen = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const name = dec.decode(bytes.subarray(at + 46, at + 46 + nameLen));
    at += 46 + nameLen + extraLen + commentLen;
    if (!wanted(name)) continue;
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const raw = bytes.subarray(start, start + size);
    if (method === 0) { out.set(name, dec.decode(raw)); continue; }
    const stream = new Blob([raw as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    out.set(name, await new Response(stream).text());
  }
  return out;
}

const colIndex = (ref: string): number => {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? "A";
  return [...letters].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
};

/** The first worksheet of an .xlsx → rows of text (shared strings and inline strings resolved). */
export async function readXlsx(bytes: Uint8Array): Promise<Grid> {
  const files = await unzip(bytes, (n) => n === "xl/sharedStrings.xml" || /^xl\/worksheets\/sheet1\.xml$/.test(n));
  const sheet = files.get("xl/worksheets/sheet1.xml");
  if (sheet === undefined) throw new Error("the Excel file has no first sheet");
  const parser = new DOMParser();
  const shared = files.has("xl/sharedStrings.xml")
    ? [...parser.parseFromString(files.get("xl/sharedStrings.xml")!, "application/xml").getElementsByTagName("si")].map((si) => [...si.getElementsByTagName("t")].map((t) => t.textContent ?? "").join(""))
    : [];
  const doc = parser.parseFromString(sheet, "application/xml");
  const rows: Grid = [];
  for (const r of [...doc.getElementsByTagName("row")]) {
    const cells: string[] = [];
    for (const c of [...r.getElementsByTagName("c")]) {
      const i = colIndex(c.getAttribute("r") ?? "A");
      const type = c.getAttribute("t");
      const v = c.getElementsByTagName("v")[0]?.textContent ?? "";
      const text = type === "s" ? (shared[Number(v)] ?? "") : type === "inlineStr" ? [...c.getElementsByTagName("t")].map((t) => t.textContent ?? "").join("") : v;
      while (cells.length < i) cells.push("");
      cells[i] = text.trim();
    }
    if (cells.some((x) => x !== "")) rows.push(cells);
  }
  return rows;
}

/** The fields a price list may carry, and the words a vendor's heading uses for each. */
export const PRICE_FIELDS = ["brand", "manufacturer", "composition", "pack", "mrp", "gst", "hsn"] as const;
export type PriceField = (typeof PRICE_FIELDS)[number];
const HEADING_WORDS: Record<PriceField, RegExp> = {
  brand: /brand|product|item|drug ?name|^name/i,
  manufacturer: /manufact|mfg|company|marketed|mkt/i,
  composition: /compos|salt|generic|content|molecule/i,
  pack: /pack/i,
  mrp: /mrp/i,
  gst: /gst|tax/i,
  hsn: /hsn/i,
};

/** Which column holds which field, guessed from the headings (each column used once, brand first). */
export function guessColumns(headings: readonly string[]): Partial<Record<PriceField, number>> {
  const out: Partial<Record<PriceField, number>> = {};
  const used = new Set<number>();
  for (const f of PRICE_FIELDS) {
    const i = headings.findIndex((h, k) => !used.has(k) && HEADING_WORDS[f].test(h));
    if (i >= 0) { out[f] = i; used.add(i); }
  }
  return out;
}
