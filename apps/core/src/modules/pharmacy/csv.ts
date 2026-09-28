/**
 * A CSV reader that understands quotes, because a formulary brand name carries commas
 * ("… 500 mg + 125 mg oral tablet") and a split on "," silently shifts every column.
 *
 * Moved here from `scripts/pharmacy-shelf-common.ts` when the opening-stock sheet got a screen
 * (gap closure A1, 2026-09-28): the scripts folder is not type-checked and `src` may not import it.
 * The scripts re-export these, so there is still ONE reader.
 */
export type CsvRow = { line: number; cells: Record<string, string> };
export type CsvFile = { header: string[]; rows: CsvRow[]; comments: string[] };

/** One physical line into fields, RFC 4180 quoting ("" is a quote inside a quoted field). */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === "\"") {
        if (line[i + 1] === "\"") { cur += "\""; i += 1; } else quoted = false;
      } else cur += ch;
      continue;
    }
    if (ch === "\"") { quoted = true; continue; }
    if (ch === ",") { out.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur.trim());
  return out;
}

/**
 * A file whose lines starting `#` are COMMENTS (the starter list's provenance header lives there),
 * whose first other line is the header, and whose blank lines are skipped. Line numbers are what a
 * text editor shows, so an error message can be followed with a finger.
 */
export function parseCsv(text: string): CsvFile {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  const comments: string[] = [];
  let header: string[] | undefined;
  const rows: CsvRow[] = [];
  lines.forEach((raw, idx) => {
    if (raw.trim() === "") return;
    if (raw.trimStart().startsWith("#")) { comments.push(raw.trimStart().replace(/^#\s?/, "")); return; }
    if (header === undefined) { header = splitCsvLine(raw).map((h) => h.toLowerCase()); return; }
    const values = splitCsvLine(raw);
    const cells: Record<string, string> = {};
    header.forEach((h, i) => { cells[h] = values[i] ?? ""; });
    rows.push({ line: idx + 1, cells });
  });
  return { header: header ?? [], rows, comments };
}
