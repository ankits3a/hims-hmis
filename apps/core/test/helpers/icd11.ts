import { crc32, deflateRawSync } from "node:zlib";
import { icd11MapLoads, icd11MapRows } from "../../src/kernel/db/schema";
import type { Db } from "../../src/kernel/db/client";

/**
 * ═══ SYNTHETIC ROWS IN WHO'S ICD-10 → ICD-11 FORMAT — AND ONLY SYNTHETIC ═══
 *
 * WHO's mapping data is not committed: the owner's 2026-09-26 ruling lets the loader DOWNLOAD it at run
 * time (`--from-who`), and the repository still holds none of it. Every
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

export type SyntheticZipEntry = {
  name: string; data: Buffer;
  /** 8 deflates (the default), 0 stores; any other number is written as given over the raw bytes. */
  method?: number;
  /** General-purpose flags, written to both headers — bit 0 is "encrypted". */
  flags?: number;
};

/**
 * A ZIP ARCHIVE BUILT HERE, BYTE BY BYTE, SO NO TEST EVER TOUCHES WHO'S FILE. Local headers, then the
 * central directory, then the 22-byte end record with no comment — so `zip.length - 22` is the end
 * record and a test can tamper with a field at a known offset.
 */
export function syntheticZip(entries: SyntheticZipEntry[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const method = e.method ?? 8;
    const body = method === 8 ? deflateRawSync(e.data) : e.data;
    const name = Buffer.from(e.name, "utf8");
    const crc = crc32(e.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(e.flags ?? 0, 6);
    local.writeUInt16LE(method, 8); local.writeUInt32LE(crc, 14); local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(e.data.length, 22); local.writeUInt16LE(name.length, 26);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(e.flags ?? 0, 8);
    cd.writeUInt16LE(method, 10); cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(e.data.length, 24); cd.writeUInt16LE(name.length, 28); cd.writeUInt32LE(offset, 42);
    parts.push(local, name, body);
    central.push(cd, name);
    offset += local.length + name.length + body.length;
  }
  const cdBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cdBytes.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cdBytes, end]);
}

/** WHO's archive in miniature: the one-to-one file among the decoys whose names it contains. */
export function syntheticWhoZip(text = syntheticWhoMap(), method = 8): Buffer {
  const decoy = (name: string): SyntheticZipEntry => ({ name, data: Buffer.from(`decoy ${name}\r\n`, "utf8") });
  return syntheticZip([
    decoy("10To11MapToMultipleCategories.txt"),
    decoy("foundation_10To11MapToOneCategory.txt"),
    { name: "10To11MapToOneCategory.txt", data: Buffer.from(text, "utf8"), method },
    decoy("readme.txt"),
  ]);
}
