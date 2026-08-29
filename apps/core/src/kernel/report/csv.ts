/**
 * PLAN 07c T3 — THE FIRST EXPORT THIS APPLICATION HAS EVER HAD.
 *
 * Measured before it was written: zero occurrences of `Content-Disposition` anywhere in the tree, no
 * PDF/XLSX/CSV-writer dependency in either package, and every CSV path INBOUND — pasted into a
 * `<textarea>` for reconciliation or import. So there was no house pattern to follow, which means
 * this file becomes the house pattern, and every later module inherits whatever it gets wrong.
 *
 * ═══ THE ESCAPING IS THE WHOLE JOB ═══
 *
 * A patient's name is the field most likely to contain a comma ("Devi, Asha"), an apostrophe, or —
 * in a note field — a newline. A naive `rows.map(r => r.join(","))` shifts every column after the
 * comma by one, silently, and the file still opens. The corruption is invisible until somebody
 * reconciles a column of money against a column of names. RFC 4180: quote a field containing a
 * comma, a quote, a CR or an LF, and double the quotes inside it.
 *
 * ═══ THE BOM IS NOT DECORATION ═══
 *
 * Excel on Windows reads a UTF-8 CSV as the local ANSI codepage unless it finds a byte-order mark,
 * so a Devanagari name arrives as mojibake — and this hospital's patient names are Devanagari half
 * the time. The BOM costs three bytes and is the difference between a usable file and a support
 * call. Tally's importer tolerates it.
 *
 * ═══ CRLF, ALSO DELIBERATELY ═══
 *
 * RFC 4180 says CRLF, and the importers that care are the ones on Windows. Nothing that reads CSV
 * minds the extra byte.
 */
const NEEDS_QUOTING = /[",\r\n]/;

export function csvField(value: string): string {
  return NEEDS_QUOTING.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function csvRow(fields: readonly string[]): string {
  return fields.map(csvField).join(",");
}

/** Rows in, one RFC-4180 document out, BOM first. */
export function toCsv(rows: readonly (readonly string[])[]): string {
  return `﻿${rows.map(csvRow).join("\r\n")}\r\n`;
}

/**
 * A filename a person can find again in their downloads folder six weeks later, and one that cannot
 * escape it: everything outside the safe set becomes `-`, so a report title carrying a slash or a
 * patient's name carrying a quote cannot steer the path or break the header.
 */
export function contentDisposition(filename: string): string {
  const safe = filename.replace(/[^A-Za-z0-9._-]/g, "-").replace(/-+/g, "-");
  return `attachment; filename="${safe}"`;
}
