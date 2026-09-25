import { icd11MapLoads, icd11MapRows } from "../../src/kernel/db/schema";
import type { Db } from "../../src/kernel/db/client";

/**
 * ═══ SYNTHETIC ROWS IN WHO'S ICD-10 → ICD-11 FORMAT — AND ONLY SYNTHETIC ═══
 *
 * WHO's mapping data may not be committed (licence §1.2.4 is unruled; see `icd11_map_rows`). Every
 * row here is MADE UP: ICD-10 codes in the X00 range, ICD-11 codes beginning `ZZ` (no such ICD-11
 * stem exists), titles that say "Synthetic", URIs on the reserved `.invalid` domain. Only the SHAPE
 * is WHO's — the header, the tabs, the CRLF, the stray stamp cell and the three edge cases — because
 * the shape is what the parser has to get right.
 */
export const SYNTHETIC_HEADER = [
  "10ClassKind", "10DepthInKind", "icd10Code", "icd10Chapter", "icd10Title",
  "11ClassKind", "11DepthInKind", "ICD-11 FoundationURI", "Linearization (releaseURI)",
  "icd11Code", "icd11Chapter", "icd11Title",
];

const ent = (n: number): string => `https://synthetic.invalid/entity/${String(n)}`;
const rel = (n: number, tail = ""): string => `https://synthetic.invalid/release/2026-01/mms/${String(n)}${tail}`;

/** Twelve cells each: a mapped code, `&` and `/` combinations, a block target, and a No Mapping row. */
export const SYNTHETIC_ROWS: string[][] = [
  ["category", "1", "X00", "XX", "Synthetic title X00", "category", "1", ent(1), rel(1), "ZZ00", "99", "Synthetic title ZZ00"],
  ["modifiedcategory", "2", "X00.1", "XX", "Synthetic title X00.1", "category", "2", ent(2), rel(2, "/other"), "ZZ00&ZZ9P1", "99", "Synthetic title ZZ00&ZZ9P1"],
  ["category", "2", "X00.2", "XX", "Synthetic title X00.2", "category", "2", ent(3), rel(3, "/unspecified"), "ZZ01.1Y/ZZ02.3Z", "99", "Synthetic title ZZ01.1Y/ZZ02.3Z"],
  ["block", "1", "X00-X09", "XX", "Synthetic block X00-X09", "block", "1", ent(4), rel(4), "", "99", "Synthetic block"],
  ["category", "2", "X02", "XX", "Synthetic title X02", "", "", "No Mapping", "", "", "", ""],
];

/** WHO's file as bytes would decode: CRLF throughout, a stray 13th header cell, a final CRLF. */
export function syntheticWhoMap(
  rows: string[][] = SYNTHETIC_ROWS, header: string[] = [...SYNTHETIC_HEADER, "2026-Jan-17"],
): string {
  return [header, ...rows].map((cells) => cells.join("\t")).join("\r\n") + "\r\n";
}

/** A release in the tables directly — for the READ tests, which are not about the loader. */
export async function seedIcd11Release(
  db: Db, release: string,
  rows: { icd10Code: string; icd11Code: string; icd11Title: string; mapKind?: "mapped" | "no_mapping" | "grouping" }[],
): Promise<void> {
  await db.insert(icd11MapLoads).values({
    id: `load-${release}`, release, sourceFile: "synthetic.txt", sha256: `sha-${release}`, rowCount: rows.length, loadedBy: "test",
  });
  await db.insert(icd11MapRows).values(rows.map((r, i) => ({
    release, icd10Code: r.icd10Code, icd10Title: `Synthetic title ${r.icd10Code}`,
    icd11Code: r.icd11Code, icd11Title: r.icd11Title, icd11Chapter: "99",
    icd11ClassKind: r.mapKind === "grouping" ? "block" : r.mapKind === "no_mapping" ? "" : "category",
    icd11ReleaseUri: r.mapKind === "no_mapping" ? "" : `https://synthetic.invalid/release/${release}/mms/${String(i)}`,
    icd11FoundationUri: r.mapKind === "no_mapping" ? "No Mapping" : `https://synthetic.invalid/entity/${String(i)}`,
    mapKind: r.mapKind ?? "mapped",
  })));
}
