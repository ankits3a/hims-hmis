/**
 * ═══ WHO'S ICD-10 → ICD-11 ONE-TO-ONE TABLE, READ EXACTLY AS WHO WROTE IT ═══
 *
 * WHO ships the mapping tables with each ICD-11 release as tab-separated text. This is the PURE half
 * of loading `10To11MapToOneCategory.txt`: bytes in, rows out, no database. `scripts/icd11-load.ts`
 * is the half that writes, and `icd11-lookup.ts` the half that reads.
 *
 * No row of WHO's file is in this repository and none may be (the licence's §1.2.4 is unruled — see
 * `icd11_map_rows` in `kernel/db/schema/clinical-coding.ts`). Every test of this parser runs on
 * SYNTHETIC rows in WHO's format.
 *
 * ═══ THE FORMAT, MEASURED ON THE 2026-01 RELEASE BEFORE A LINE OF THIS WAS WRITTEN ═══
 *
 *   · CRLF line ends, no BOM, no quoting at all — a title with a comma is just a title.
 *   · A 12-cell header plus a STRAY 13th cell (`2026-Jan-17`) that no row fills. Every row is 12.
 *   · 12,597 rows, each ICD-10 code exactly once — which is what makes it ONE-to-one.
 *   · 4 rows whose FoundationURI cell is the literal `No Mapping`, every ICD-11 cell empty.
 *   · 93 rows whose target is an ICD-11 BLOCK: a URI and a title but an empty `icd11Code`, because
 *     WHO's groupings bear no code.
 *   · `icd11Code` is FREE TEXT. 816 rows join a stem to an extension code with `&`; 61 name a
 *     cluster with `/`. Neither is split, normalised or validated here — it is WHO's string.
 *
 * The multiple-categories file spells its depth columns `Depth` rather than `10DepthInKind`, so the
 * exact-header check below is also what stops the wrong one of WHO's two files being loaded.
 *
 * ═══ NOTHING HERE ALTERS A WHO STRING ═══
 *
 * No trim, no case fold, no re-encoding: each cell is the text between two tabs. An empty cell stays
 * '' rather than becoming null, because '' is what WHO wrote. The single derived value is `mapKind`,
 * and it is ours, not WHO's (§1.2.5) — it is computed from WHO's cells and stored beside them.
 */

/** WHO's header, cell for cell. A 13th cell may follow (a date stamp); a 14th is a different file. */
export const WHO_ONE_TO_ONE_HEADER = [
  "10ClassKind", "10DepthInKind", "icd10Code", "icd10Chapter", "icd10Title",
  "11ClassKind", "11DepthInKind", "ICD-11 FoundationURI", "Linearization (releaseURI)",
  "icd11Code", "icd11Chapter", "icd11Title",
] as const;

/** The literal WHO writes in the FoundationURI cell of an ICD-10 code ICD-11 has nothing for. */
export const WHO_NO_MAPPING = "No Mapping";

/**
 * NOT WHO'S. `mapped` — an ICD-11 code with its title and URI. `grouping` — the target is a block
 * with a URI and a title but no code. `no_mapping` — WHO says ICD-11 has nothing for this code.
 */
export type Icd11MapKind = "mapped" | "no_mapping" | "grouping";

export type WhoMapRow = {
  icd10ClassKind: string; icd10DepthInKind: string; icd10Code: string; icd10Chapter: string; icd10Title: string;
  icd11ClassKind: string; icd11DepthInKind: string; icd11FoundationUri: string; icd11ReleaseUri: string;
  icd11Code: string; icd11Chapter: string; icd11Title: string;
  /** Derived here — see `mapKindOf`. */
  mapKind: Icd11MapKind;
};

export type ParsedWhoMap = {
  rows: WhoMapRow[];
  /** The stray 13th header cell, verbatim (`2026-Jan-17`), or null when the header has 12. */
  headerStamp: string | null;
};

/** A file this parser will not read. It always names the line, because 12,597 rows is not a file anyone scrolls. */
export class Icd11MapFormatError extends Error {
  constructor(readonly line: number, message: string) {
    super(`line ${String(line)}: ${message}`);
    this.name = "Icd11MapFormatError";
  }
}

/**
 * The one derived value. `No Mapping` is WHO's own words and wins first; then an empty code means a
 * grouping. A `No Mapping` row that nevertheless carries a code contradicts itself, and a `mapped`
 * row without its title or URI could not be shown lawfully (§1.2.3 wants code, title AND URI) — both
 * refuse the FILE rather than dropping the row, because a quietly shorter table is the failure that
 * nobody notices.
 */
export function mapKindOf(row: Omit<WhoMapRow, "mapKind">, line: number): Icd11MapKind {
  if (row.icd11FoundationUri === WHO_NO_MAPPING) {
    if (row.icd11Code !== "") throw new Icd11MapFormatError(line, `"${WHO_NO_MAPPING}" with an ICD-11 code (${row.icd11Code})`);
    return "no_mapping";
  }
  if (row.icd11Code === "") return "grouping";
  if (row.icd11Title === "" || row.icd11ReleaseUri === "") {
    throw new Icd11MapFormatError(line, `ICD-11 ${row.icd11Code} without its title or release URI`);
  }
  return "mapped";
}

export function parseWhoOneToOneMap(text: string): ParsedWhoMap {
  /* A BOM is an encoding mark, not a cell: WHO's own readme in the same archive carries one. */
  const body = text.startsWith("﻿") ? text.slice(1) : text;
  const lines = body.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
  /* The file ENDS with a CRLF, so the split leaves one empty string after it — that, and only that. */
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  if (lines.length === 0) throw new Icd11MapFormatError(1, "empty file");

  const header = lines[0]!.split("\t");
  if (header.length < WHO_ONE_TO_ONE_HEADER.length || header.length > WHO_ONE_TO_ONE_HEADER.length + 1) {
    throw new Icd11MapFormatError(1, `expected ${String(WHO_ONE_TO_ONE_HEADER.length)} header cells (+1 stamp), got ${String(header.length)}`);
  }
  WHO_ONE_TO_ONE_HEADER.forEach((want, i) => {
    if (header[i] !== want) throw new Icd11MapFormatError(1, `header cell ${String(i + 1)} is "${header[i] ?? ""}", expected "${want}"`);
  });
  const headerStamp = header.length > WHO_ONE_TO_ONE_HEADER.length ? header[WHO_ONE_TO_ONE_HEADER.length]! : null;

  const rows: WhoMapRow[] = [];
  const seen = new Set<string>();
  for (let n = 1; n < lines.length; n += 1) {
    const line = n + 1;
    const cells = lines[n]!.split("\t");
    /* No row fills the stray header cell. A row that does is not this file's shape. */
    if (cells.length !== WHO_ONE_TO_ONE_HEADER.length) {
      throw new Icd11MapFormatError(line, `expected ${String(WHO_ONE_TO_ONE_HEADER.length)} cells, got ${String(cells.length)}`);
    }
    const [
      icd10ClassKind, icd10DepthInKind, icd10Code, icd10Chapter, icd10Title,
      icd11ClassKind, icd11DepthInKind, icd11FoundationUri, icd11ReleaseUri,
      icd11Code, icd11Chapter, icd11Title,
    ] = cells as [string, string, string, string, string, string, string, string, string, string, string, string];
    if (icd10Code === "") throw new Icd11MapFormatError(line, "empty icd10Code");
    if (seen.has(icd10Code)) throw new Icd11MapFormatError(line, `icd10Code ${icd10Code} appears twice — not the one-to-one file`);
    seen.add(icd10Code);
    const cellsOf = {
      icd10ClassKind, icd10DepthInKind, icd10Code, icd10Chapter, icd10Title,
      icd11ClassKind, icd11DepthInKind, icd11FoundationUri, icd11ReleaseUri,
      icd11Code, icd11Chapter, icd11Title,
    };
    rows.push({ ...cellsOf, mapKind: mapKindOf(cellsOf, line) });
  }
  if (rows.length === 0) throw new Icd11MapFormatError(2, "a header and no rows");
  return { rows, headerStamp };
}
