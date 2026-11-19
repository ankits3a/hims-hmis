import { inflateSync } from "node:zlib";

/**
 * STORES S5c (#1115, flow 6; edge cases 4 and 5) — THE TEXT ON A SUPPLIER'S QUOTATION PDF, PAGE BY PAGE.
 *
 * A quotation PDF from a supplier's billing software carries its words as text-showing operators (`Tj`, `TJ`, `'`, `"`)
 * in each page's content stream, usually Flate-compressed, sometimes with the page objects themselves packed in an
 * object stream. This reads exactly that and nothing more: no new dependency, no network, no model. A scan (an image
 * with no text), an encrypted file or a font whose glyphs are not readable text gives pages with no words, and the
 * caller's draft is then EMPTY — the buyer types the quote and the PDF stays attached (edge case 4).
 *
 * Text is data. Nothing here interprets it; the reader only proposes lines the buyer confirms (edge case 5).
 */
export type PdfPage = { page: number; lines: string[] };

/** Past this the file is refused before it is read (the upload route caps the body too). */
export const PDF_MAX_BYTES = 8 * 1024 * 1024;
const MAX_PAGES = 30;
const MAX_STREAM_BYTES = 4 * 1024 * 1024;

type PdfObject = { num: number; body: string; stream: Buffer | null };

export function isPdf(bytes: Buffer): boolean {
  return bytes.length > 8 && bytes.subarray(0, 5).toString("latin1") === "%PDF-";
}

/** The pages' text lines, in page order. Never throws on a malformed file: it returns what it could read. */
export function pdfPages(bytes: Buffer): PdfPage[] {
  if (!isPdf(bytes) || bytes.length > PDF_MAX_BYTES) return [];
  let objects: Map<number, PdfObject>;
  try {
    objects = readObjects(bytes);
  } catch {
    return [];
  }
  if ([...objects.values()].some((o) => /\/Encrypt\b/.test(o.body))) return [];
  const pages = [...objects.values()].filter((o) => /\/Type\s*\/Page\b(?!s)/.test(o.body)).sort((a, b) => a.num - b.num).slice(0, MAX_PAGES);
  const out: PdfPage[] = [];
  pages.forEach((p, i) => {
    const refs = contentRefs(p.body);
    const text: string[] = [];
    for (const r of refs) {
      const o = objects.get(r);
      if (o?.stream == null) continue;
      const data = decoded(o);
      if (data !== null) text.push(...contentLines(data.toString("latin1")));
    }
    out.push({ page: i + 1, lines: text.map((l) => l.replace(/\s+/g, " ").trim()).filter((l) => l !== "") });
  });
  return out;
}

/** Every `n g obj … endobj`, with its stream bytes, plus the objects packed inside object streams. */
function readObjects(bytes: Buffer): Map<number, PdfObject> {
  const src = bytes.toString("latin1");
  const out = new Map<number, PdfObject>();
  const re = /(\d+)\s+(\d+)\s+obj\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const start = m.index + m[0].length;
    const end = src.indexOf("endobj", start);
    if (end < 0) break;
    let body = src.slice(start, end);
    let stream: Buffer | null = null;
    const s = body.indexOf("stream");
    if (s >= 0 && /\/Length\b/.test(body.slice(0, s))) {
      let from = start + s + "stream".length;
      if (src[from] === "\r") from += 1;
      if (src[from] === "\n") from += 1;
      const lenMatch = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(body.slice(0, s));
      let to = src.indexOf("endstream", from);
      if (lenMatch !== null) {
        const len = Number(lenMatch[1]);
        if (from + len <= src.length && src.slice(from + len, from + len + 20).includes("endstream")) to = from + len;
      }
      if (to > from && to - from <= MAX_STREAM_BYTES) stream = bytes.subarray(from, to);
      body = body.slice(0, s);
    }
    out.set(Number(m[1]), { num: Number(m[1]), body, stream });
    re.lastIndex = end + "endobj".length;
  }
  // Object streams (PDF 1.5+): the page objects of a modern file often live inside one.
  for (const o of [...out.values()]) {
    if (!/\/Type\s*\/ObjStm\b/.test(o.body) || o.stream === null) continue;
    const data = decoded(o);
    if (data === null) continue;
    const n = Number(/\/N\s+(\d+)/.exec(o.body)?.[1] ?? 0);
    const first = Number(/\/First\s+(\d+)/.exec(o.body)?.[1] ?? 0);
    const text = data.toString("latin1");
    const head = text.slice(0, first).trim().split(/\s+/).map(Number);
    for (let i = 0; i < n && 2 * i + 1 < head.length; i++) {
      const num = head[2 * i]!;
      const off = first + head[2 * i + 1]!;
      const next = 2 * i + 3 < head.length ? first + head[2 * i + 3]! : text.length;
      if (!out.has(num)) out.set(num, { num, body: text.slice(off, next), stream: null });
    }
  }
  return out;
}

function contentRefs(pageBody: string): number[] {
  const m = /\/Contents\s*(\[[^\]]*\]|\d+\s+\d+\s+R)/.exec(pageBody);
  if (m === null) return [];
  return [...m[1]!.matchAll(/(\d+)\s+\d+\s+R/g)].map((r) => Number(r[1]));
}

function decoded(o: PdfObject): Buffer | null {
  if (o.stream === null) return null;
  const filters = /\/Filter\s*(\[[^\]]*\]|\/\w+)/.exec(o.body)?.[1] ?? "";
  if (filters === "") return o.stream;
  const names = [...filters.matchAll(/\/(\w+)/g)].map((f) => f[1]);
  if (names.some((n) => n !== "FlateDecode" && n !== "Fl")) return null;
  try {
    let out = o.stream;
    for (let i = 0; i < names.length; i++) out = inflateSync(out, { maxOutputLength: MAX_STREAM_BYTES });
    return out;
  } catch {
    return null;
  }
}

/** A content stream's shown text, split into lines where the page moves to a new line. */
function contentLines(content: string): string[] {
  const lines: string[] = [];
  let cur = "";
  const flush = (): void => { lines.push(cur); cur = ""; };
  const tokens = tokenize(content);
  const operands: Token[] = [];
  for (const t of tokens) {
    if (t.kind !== "op") { operands.push(t); continue; }
    switch (t.value) {
      case "Tj": { const s = operands.at(-1); if (s?.kind === "str") cur += s.value; break; }
      case "'": case "\"": { flush(); const s = operands.at(-1); if (s?.kind === "str") cur += s.value; break; }
      case "TJ": {
        for (const o of operands) {
          if (o.kind === "str") cur += o.value;
          else if (o.kind === "num" && o.value < -200) cur += " ";
        }
        break;
      }
      case "T*": flush(); break;
      case "Td": case "TD": {
        const ty = operands.at(-1);
        if (ty?.kind === "num" && Math.abs(ty.value) > 0.5) flush();
        else cur += " ";
        break;
      }
      case "Tm": flush(); break;
      case "ET": flush(); break;
      default: break;
    }
    operands.length = 0;
  }
  if (cur !== "") flush();
  return lines;
}

type Token = { kind: "str"; value: string } | { kind: "num"; value: number } | { kind: "op"; value: string } | { kind: "other" };

function tokenize(s: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (c === "(") {
      let depth = 1;
      let v = "";
      i += 1;
      while (i < s.length && depth > 0) {
        const d = s[i]!;
        if (d === "\\") {
          const e = s[i + 1] ?? "";
          if (/[0-7]/.test(e)) {
            const oct = /^[0-7]{1,3}/.exec(s.slice(i + 1))![0];
            v += String.fromCharCode(parseInt(oct, 8));
            i += 1 + oct.length;
            continue;
          }
          v += e === "n" ? "\n" : e === "r" ? "" : e === "t" ? " " : e === "\n" || e === "\r" ? "" : e;
          i += 2;
          continue;
        }
        if (d === "(") depth += 1;
        if (d === ")") { depth -= 1; if (depth === 0) { i += 1; break; } }
        v += d;
        i += 1;
      }
      out.push({ kind: "str", value: printable(v) });
      continue;
    }
    if (c === "<" && s[i + 1] !== "<") {
      const end = s.indexOf(">", i);
      const hex = s.slice(i + 1, end < 0 ? s.length : end).replace(/\s+/g, "");
      let v = "";
      for (let k = 0; k + 1 < hex.length; k += 2) v += String.fromCharCode(parseInt(hex.slice(k, k + 2), 16));
      out.push({ kind: "str", value: printable(v) });
      i = end < 0 ? s.length : end + 1;
      continue;
    }
    if (c === "%") { const nl = s.slice(i).search(/[\r\n]/); i = nl < 0 ? s.length : i + nl; continue; }
    if (/\s/.test(c) || c === "[" || c === "]") { i += 1; continue; }
    if (c === "<" || c === ">") { i += 2; out.push({ kind: "other" }); continue; }
    if (c === "/") { const m = /^\/[^\s/[\]()<>{}%]*/.exec(s.slice(i))!; i += m[0].length; out.push({ kind: "other" }); continue; }
    const num = /^[+-]?(\d+\.?\d*|\.\d+)/.exec(s.slice(i));
    if (num !== null) { out.push({ kind: "num", value: Number(num[0]) }); i += num[0].length; continue; }
    const op = /^[A-Za-z'"*]+/.exec(s.slice(i));
    if (op !== null) { out.push({ kind: "op", value: op[0] }); i += op[0].length; continue; }
    i += 1;
  }
  return out;
}

/** Glyph codes that are not readable text (a CID font without its map) become nothing, so a scan reads as empty. */
function printable(v: string): string {
  return [...v].filter((ch) => { const n = ch.charCodeAt(0); return n === 9 || n === 10 || (n >= 32 && n < 127) || (n >= 160 && n < 256); }).join("");
}
