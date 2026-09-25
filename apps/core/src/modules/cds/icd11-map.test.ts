import { SYNTHETIC_HEADER, SYNTHETIC_ROWS, syntheticWhoMap } from "../../../test/helpers/icd11";
import { Icd11MapFormatError, parseWhoOneToOneMap } from "./icd11-map";

/**
 * WHO's one-to-one ICD-10 → ICD-11 file, parsed. Every row is SYNTHETIC in WHO's shape — see
 * `test/helpers/icd11.ts` for why no real row may appear here. Each test is one property of the
 * 2026-01 file measured before the parser existed; a parser that fails any of them loads a table
 * that is subtly not WHO's and reports success.
 */
describe("parseWhoOneToOneMap — WHO's file, verbatim", () => {
  it("W1: reads CRLF rows with no '\\r' left on the last cell, and keeps the stray header stamp", () => {
    const { rows, headerStamp } = parseWhoOneToOneMap(syntheticWhoMap());
    expect(rows).toHaveLength(SYNTHETIC_ROWS.length);
    expect(headerStamp).toBe("2026-Jan-17");
    /* The last cell of a CRLF line is where a '\r' survives a plain split("\n"). */
    expect(rows[0]!.icd11Title).toBe("Synthetic title ZZ00");
    expect(rows.every((r) => !Object.values(r).some((v) => v.includes("\r")))).toBe(true);
  });

  it("W2: a header of exactly twelve cells is WHO's too — the stamp is optional", () => {
    const { rows, headerStamp } = parseWhoOneToOneMap(syntheticWhoMap(SYNTHETIC_ROWS, SYNTHETIC_HEADER));
    expect(headerStamp).toBeNull();
    expect(rows).toHaveLength(SYNTHETIC_ROWS.length);
  });

  it("W3: refuses a header that is not WHO's, cell for cell — the multiple-categories file among them", () => {
    /* WHO's OTHER file spells both depth columns `Depth`; loading it here would be the wrong table. */
    const multi = SYNTHETIC_HEADER.map((h) => (h.endsWith("DepthInKind") ? "Depth" : h));
    expect(() => parseWhoOneToOneMap(syntheticWhoMap(SYNTHETIC_ROWS, multi))).toThrow(/line 1: header cell 2 is "Depth"/);
    expect(() => parseWhoOneToOneMap(syntheticWhoMap(SYNTHETIC_ROWS, SYNTHETIC_HEADER.slice(0, 11)))).toThrow(Icd11MapFormatError);
    expect(() => parseWhoOneToOneMap(syntheticWhoMap(SYNTHETIC_ROWS, [...SYNTHETIC_HEADER, "stamp", "extra"]))).toThrow(/header cells/);
  });

  it("W4: 'No Mapping' is WHO's own words — kept verbatim, every ICD-11 cell empty, kind no_mapping", () => {
    const row = parseWhoOneToOneMap(syntheticWhoMap()).rows.find((r) => r.icd10Code === "X02")!;
    expect(row).toMatchObject({ icd11FoundationUri: "No Mapping", icd11Code: "", icd11Title: "", icd11ReleaseUri: "", mapKind: "no_mapping" });
  });

  it("W5: an empty icd11Code is a GROUPING — the block's title and URI kept, no code invented", () => {
    const row = parseWhoOneToOneMap(syntheticWhoMap()).rows.find((r) => r.icd10Code === "X00-X09")!;
    expect(row).toMatchObject({ icd11Code: "", icd11Title: "Synthetic block", icd11ClassKind: "block", mapKind: "grouping" });
    expect(row.icd11ReleaseUri).toBe("https://synthetic.invalid/release/2026-01/mms/4");
  });

  it("W6: '&' and '/' codes are FREE TEXT — neither split nor normalised", () => {
    const rows = parseWhoOneToOneMap(syntheticWhoMap()).rows;
    expect(rows.find((r) => r.icd10Code === "X00.1")).toMatchObject({ icd11Code: "ZZ00&ZZ9P1", mapKind: "mapped" });
    expect(rows.find((r) => r.icd10Code === "X00.2")).toMatchObject({ icd11Code: "ZZ01.1Y/ZZ02.3Z", mapKind: "mapped" });
  });

  it("W7: no cell is trimmed or case-folded — a WHO string is the text between two tabs", () => {
    const odd = [["category", "1", "X03", "XX", " Synthetic  spaced ", "category", "1", "u", "r", "zz03", "99", "Synthetic title, with comma "]];
    const [row] = parseWhoOneToOneMap(syntheticWhoMap(odd)).rows;
    expect(row).toMatchObject({ icd10Title: " Synthetic  spaced ", icd11Code: "zz03", icd11Title: "Synthetic title, with comma " });
  });

  it("W8: a row that is not twelve cells REFUSES THE FILE and names the line — nothing is dropped quietly", () => {
    const short = [...SYNTHETIC_ROWS, ["category", "1", "X04", "XX", "Synthetic"]];
    expect(() => parseWhoOneToOneMap(syntheticWhoMap(short))).toThrow(/line 7: expected 12 cells, got 5/);
    /* Filling the stray stamp column is a 13th cell, and no row of WHO's file does it. */
    const long = [[...SYNTHETIC_ROWS[0]!, "2026-Jan-17"]];
    expect(() => parseWhoOneToOneMap(syntheticWhoMap(long))).toThrow(/expected 12 cells, got 13/);
  });

  it("W9: the same ICD-10 code twice is not the one-to-one file", () => {
    expect(() => parseWhoOneToOneMap(syntheticWhoMap([SYNTHETIC_ROWS[0]!, SYNTHETIC_ROWS[0]!]))).toThrow(/X00 appears twice/);
  });

  it("W10: a mapped code without its title or URI refuses — §1.2.3 wants code, title AND URI together", () => {
    const noUri = [["category", "1", "X05", "XX", "Synthetic", "category", "1", "u", "", "ZZ05", "99", "Synthetic title"]];
    expect(() => parseWhoOneToOneMap(syntheticWhoMap(noUri))).toThrow(/ZZ05 without its title or release URI/);
    const contradiction = [["category", "1", "X06", "XX", "Synthetic", "", "", "No Mapping", "", "ZZ06", "", ""]];
    expect(() => parseWhoOneToOneMap(syntheticWhoMap(contradiction))).toThrow(/No Mapping" with an ICD-11 code/);
  });

  it("W11: an empty file, and a header with no rows, both refuse", () => {
    expect(() => parseWhoOneToOneMap("")).toThrow(/empty file/);
    expect(() => parseWhoOneToOneMap(syntheticWhoMap([]))).toThrow(/no rows/);
  });
});
