import { sql } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { icd11MapLoads, icd11MapRows } from "./index";
import type { Db } from "../client";

/**
 * The ICD-11 map's two tables, pinned against what POSTGRES has (the migration that ran), not what
 * the schema file says — comparing the file to itself would pass for a migration that never ran.
 */
const CENSUS: Record<string, string[]> = {
  icd11_map_loads: ["id", "loaded_at", "loaded_by", "release", "row_count", "sha256", "source_file"],
  icd11_map_rows: [
    "icd10_code", "icd10_title", "icd11_chapter", "icd11_class_kind", "icd11_code", "icd11_foundation_uri",
    "icd11_release_uri", "icd11_title", "map_kind", "release",
  ],
};

describe("the ICD-11 map tables", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); });

  it("every censused table exists with exactly the columns named", async () => {
    const actual: Record<string, string[]> = {};
    for (const table of Object.keys(CENSUS)) {
      const rows = (await db.execute(sql`
        select column_name as "columnName" from information_schema.columns
        where table_schema = 'public' and table_name = ${table} order by column_name asc
      `)).rows as { columnName: string }[];
      actual[table] = rows.map((r) => r.columnName);
    }
    expect(actual).toEqual(CENSUS);
  });

  it("no icd11_ table exists that this census does not know about", async () => {
    const rows = (await db.execute(sql`
      select table_name as "tableName" from information_schema.tables
      where table_schema = 'public' and table_name like 'icd11\\_%' order by table_name asc
    `)).rows as { tableName: string }[];
    expect(rows.map((r) => r.tableName).sort()).toEqual(Object.keys(CENSUS).sort());
  });

  it("a row needs its load, one row per (release, code), and map_kind is one of three", async () => {
    const row = { release: "2026-01", icd10Code: "X00", icd10Title: "Synthetic", icd11Code: "ZZ00", icd11Title: "Synthetic", icd11Chapter: "99", icd11ClassKind: "category", icd11ReleaseUri: "u", icd11FoundationUri: "f", mapKind: "mapped" };
    await expect(db.insert(icd11MapRows).values(row)).rejects.toThrow(/icd11_map_rows_release_icd11_map_loads_release_fk/);
    await db.insert(icd11MapLoads).values({ id: "L1", release: "2026-01", sourceFile: "f", sha256: "s", rowCount: 1, loadedBy: "t" });
    await db.insert(icd11MapRows).values(row);
    await expect(db.insert(icd11MapRows).values(row)).rejects.toThrow(/icd11_map_rows_release_icd10_code_pk/);
    await expect(db.insert(icd11MapRows).values({ ...row, icd10Code: "X01", mapKind: "guess" })).rejects.toThrow(/icd11_map_rows_map_kind_ck/);
    await expect(db.insert(icd11MapLoads).values({ id: "L2", release: "26-1", sourceFile: "f", sha256: "s2", rowCount: 1, loadedBy: "t" })).rejects.toThrow(/icd11_map_loads_release_ck/);
  });
});
