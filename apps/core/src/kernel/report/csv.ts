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
 *
 * ═══ A CELL THAT STARTS LIKE A FORMULA IS WRITTEN AS TEXT (WASA L-03) ═══
 *
 * Excel, LibreOffice and Sheets EVALUATE a cell beginning `=`, `+`, `-` or `@`, and Excel strips a
 * leading tab or CR before it looks. A patient registered as `=HYPERLINK("http://evil","Click")`
 * therefore became a live link — or, with DDE, a command — in whoever opened `/me/report.csv`. The
 * OWASP rule is applied here, so every export inherits it: such a cell gets a leading `'`, which a
 * spreadsheet shows as text and never runs. It is applied BEFORE the quoting, so the `'` sits inside
 * the quotes.
 *
 * ONE EXEMPTION, AND IT IS A SHAPE, NOT A GUESS: every cell reaching this function is a string, so a
 * refund of `-₹1,500.00` (`formatPaise`) looks exactly like attacker text by type. A cell that is
 * nothing but an optional sign, an optional `₹`, digits, grouping commas and one decimal part
 * cannot name a function or a reference, so it stays a number the column can still sum. `-1+1`,
 * `-2+3+cmd|…` and anything else with an operator or a letter in it is prefixed.
 */
const NEEDS_QUOTING = /[",\r\n]/;
const FORMULA_TRIGGER = /^[=+\-@\t\r]/;
const PLAIN_NUMBER = /^[+-]?₹?\d[\d,]*(\.\d+)?$/;

export function csvField(value: string): string {
  const text = FORMULA_TRIGGER.test(value) && !PLAIN_NUMBER.test(value) ? `'${value}` : value;
  return NEEDS_QUOTING.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
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
