import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { MembershipError } from "../errors";
import {
  COLUMN_MAP_VERSIONS, HOLDER_BOOK_COLUMN_MAPS, foldHeader, mapRow, resolveColumnMap,
} from "./column-maps";

/**
 * PLAN 09 T5 — the column maps. No database: this file is about a header row and nothing else.
 *
 * ═══ EVERY FIXTURE IN `fixtures/` IS INVENTED BY THIS TASK (DD3 / owner ruling O-9) ═══
 * The out-of-git partner book may never be quoted into a tracked file. These drops test CLASSES —
 * a duplicate key, an inverted validity range, a transposed header, an over-cap family, a shared
 * family phone, a mixed-script name — and a class does not care which invented name carries it.
 */
export const FIXTURES = resolve(__dirname, "fixtures");

export function fixture(name: string): string {
  return readFileSync(resolve(FIXTURES, name), "utf8");
}

function headerOf(csv: string): string[] {
  return csv.split(/\r?\n/)[0]!.split(",").map((c) => c.trim());
}

describe("holder-book column maps", () => {
  it("folds a header for comparison but does not fold an underscore into a space", () => {
    expect(foldHeader("  Holder_Name ")).toBe("holder_name");
    expect(foldHeader("Sale  Ref")).toBe("sale ref");
    // The negative half: two headings that a laxer fold would merge stay different.
    expect(foldHeader("card_code")).not.toBe(foldHeader("card code"));
  });

  it("every shipped map declares a distinct version and a non-empty header set", () => {
    // §2.49 — the census FIRST. A map list that had gone empty would satisfy every check below.
    expect(HOLDER_BOOK_COLUMN_MAPS.length).toBeGreaterThanOrEqual(2);
    expect(new Set(COLUMN_MAP_VERSIONS).size).toBe(COLUMN_MAP_VERSIONS.length);
    for (const map of HOLDER_BOOK_COLUMN_MAPS) {
      const headers = Object.keys(map.headers);
      expect(headers.length).toBeGreaterThan(0);
      // Every declared header is already in folded form, or it could never match a real file.
      expect(headers.map(foldHeader)).toEqual(headers);
    }
  });

  it("recognises each shipped drop shape by its header SET", () => {
    expect(resolveColumnMap(headerOf(fixture("drop-a-baseline.csv"))).version).toBe("holder-book-v1");
    expect(resolveColumnMap(headerOf(fixture("drop-v2-activation.csv"))).version).toBe("holder-book-v2");
  });

  it("E5 — a TRANSPOSED drop is the same SET, so it is recognised and read BY NAME", () => {
    const csv = fixture("drop-transposed.csv");
    const header = headerOf(csv);
    // The proof that it really is transposed rather than merely equal: the ORDER differs from v1's.
    expect(header).not.toEqual(headerOf(fixture("drop-a-baseline.csv")));
    expect(new Set(header)).toEqual(new Set(headerOf(fixture("drop-a-baseline.csv"))));

    const map = resolveColumnMap(header);
    const cells = csv.split(/\r?\n/)[1]!.split(",").map((c) => c.trim());
    const fields = mapRow(map, header, cells);
    // The name is the NAME even though it is in the phone's usual position. A positional reader
    // would put "9820100113" here, which is the whole of E5's second direction.
    expect(fields.holderName).toBe("Rukmini Sathe");
    expect(fields.holderPhone).toBe("9820100113");
  });

  it("E5 — an unknown column SHAPE refuses loudly and never falls back to position", () => {
    const header = headerOf(fixture("drop-unknown-columns.csv"));
    let thrown: unknown;
    try {
      resolveColumnMap(header);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(MembershipError);
    expect((thrown as MembershipError).code).toBe("import_columns_unknown");
    // The refusal NAMES what it got and what it knows: an operator has to be able to act on it.
    expect((thrown as MembershipError).detail).toEqual({
      headers: header.map(foldHeader),
      knownVersions: COLUMN_MAP_VERSIONS,
    });
  });

  it("a REPEATED heading is an unknown shape, not a near-miss", () => {
    // Set equality alone cannot see this: the second `card_code` collapses into the first and the
    // set would match v1 exactly, while no cell could be read by name.
    const header = [
      "partner_sale_ref", "card_code", "card_code", "plan_code", "holder_name", "holder_phone",
      "valid_from", "valid_to", "members",
    ];
    expect(() => resolveColumnMap(header)).toThrow(/repeats a column name/);
  });

  it("naming a version licenses nothing — it still has to match", () => {
    const header = headerOf(fixture("drop-a-baseline.csv"));
    expect(resolveColumnMap(header, "holder-book-v1").version).toBe("holder-book-v1");
    expect(() => resolveColumnMap(header, "holder-book-v2")).toThrow(MembershipError);
    expect(() => resolveColumnMap(header, "holder-book-v9")).toThrow(/no column map named/);
  });

  it("mapRow ignores a column no map declares and drops empty cells rather than storing \"\"", () => {
    const header = headerOf(fixture("drop-a-baseline.csv"));
    const map = resolveColumnMap(header);
    const fields = mapRow(map, header, ["S-1001", "KM-70", "PL-INV-SOLO", "Vasanti Kher", "", "2026-01-01", "2026-12-31", ""]);
    expect(fields.holderPhone).toBeUndefined();
    expect(fields.members).toBeUndefined();
    expect(fields.partnerSaleRef).toBe("S-1001");
  });

  it("O-9 — every fixture is a .csv this task wrote, and the directory is not empty", () => {
    // §2.49: a fixture directory that had gone empty would make every drop-driven test below
    // vacuous, and the reviewer's O-9 check is over exactly these files.
    const files = readdirSync(FIXTURES);
    expect(files.length).toBeGreaterThanOrEqual(10);
    expect(files.filter((f) => !f.endsWith(".csv"))).toEqual([]);
  });
});
