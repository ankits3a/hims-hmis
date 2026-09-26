import { sql } from "drizzle-orm";
import { setupTestDb, truncateAll } from "./helpers/db";
import { SYNTHETIC_ROWS, syntheticWhoMap, syntheticWhoZip } from "./helpers/icd11";
import { icd11MapLoads, icd11MapRows } from "../src/kernel/db/schema";
import { loadIcd11Map, parseArgs, readSource, sha256Of } from "../scripts/icd11-load";
import type { Db } from "../src/kernel/db/client";

/**
 * ═══ THE ICD-11 LOADER — ONE FILE ONCE, ON THE RECORD, ALL OR NOTHING ═══
 *
 * Importing the script is also what type-checks it: core's tsconfig excludes `scripts/`, so a loader
 * no test imports is a loader no compiler reads. Every row is SYNTHETIC (`test/helpers/icd11.ts`).
 */
describe("icd11:load — WHO's one-to-one table into icd11_map_rows", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); });

  const file = (text = syntheticWhoMap()): Buffer => Buffer.from(text, "utf8");
  const load = (bytes: Buffer, release = "2026-01") =>
    loadIcd11Map(db, { bytes, sourceFile: "10To11MapToOneCategory.txt", release, loadedBy: "dr.mrd" });
  const counts = async () => ({
    loads: (await db.select().from(icd11MapLoads)).length,
    rows: (await db.select().from(icd11MapRows)).length,
  });

  it("L1: loads every row verbatim and records the load — release, file, sha256, count, who", async () => {
    const bytes = file();
    const r = await load(bytes);
    expect(r).toMatchObject({ status: "loaded", release: "2026-01", rows: SYNTHETIC_ROWS.length, headerStamp: "2026-Jan-17" });
    expect(r.status === "loaded" && r.kinds).toEqual({ mapped: 3, grouping: 1, no_mapping: 1 });

    const [rec] = await db.select().from(icd11MapLoads);
    expect(rec).toMatchObject({
      release: "2026-01", sourceFile: "10To11MapToOneCategory.txt", sha256: sha256Of(bytes), rowCount: SYNTHETIC_ROWS.length, loadedBy: "dr.mrd",
    });
    expect(rec!.sha256).toMatch(/^[0-9a-f]{64}$/);

    /* Sorted HERE, by code point: `order by` follows the database's collation, which puts '-' and '.' where it likes. */
    const rows = (await db.select().from(icd11MapRows)).sort((a, b) => (a.icd10Code < b.icd10Code ? -1 : 1));
    expect(rows.map((x) => [x.icd10Code, x.icd11Code, x.mapKind])).toEqual([
      ["X00", "ZZ00", "mapped"],
      ["X00-X09", "", "grouping"],
      ["X00.1", "ZZ00&ZZ9P1", "mapped"],
      ["X00.2", "ZZ01.1Y/ZZ02.3Z", "mapped"],
      ["X02", "", "no_mapping"],
    ]);
    /* WHO's literal, and WHO's empty cells as '' — not nulls, not a tidied string. */
    expect(rows.find((x) => x.icd10Code === "X02")).toMatchObject({ icd11FoundationUri: "No Mapping", icd11Title: "", icd11ReleaseUri: "" });
  });

  it("L2: the SAME FILE a second time is refused, names the first load, and writes nothing", async () => {
    const bytes = file();
    const first = await load(bytes);
    const again = await load(bytes, "2027-01");
    expect(again).toMatchObject({ status: "refused", reason: "same_file" });
    expect(again.status === "refused" && again.existing.id).toBe(first.status === "loaded" ? first.loadId : "-");
    expect(await counts()).toEqual({ loads: 1, rows: SYNTHETIC_ROWS.length });
  });

  it("L3: a DIFFERENT file for a release already loaded is refused too — a correction is a new release", async () => {
    await load(file());
    const changed = await load(file(syntheticWhoMap(SYNTHETIC_ROWS.slice(0, 2))));
    expect(changed).toMatchObject({ status: "refused", reason: "same_release" });
    expect(await counts()).toEqual({ loads: 1, rows: SYNTHETIC_ROWS.length });
  });

  it("L4: a malformed file writes NOTHING — not even the load record", async () => {
    await expect(load(file(syntheticWhoMap([...SYNTHETIC_ROWS, ["short"]])))).rejects.toThrow(/expected 12 cells/);
    expect(await counts()).toEqual({ loads: 0, rows: 0 });
  });

  it("L5: the release must be YYYY-MM, and a load must name who ran it", async () => {
    await expect(load(file(), "2026-1")).rejects.toThrow(/YYYY-MM/);
    await expect(loadIcd11Map(db, { bytes: file(), sourceFile: "f.txt", release: "2026-01", loadedBy: " " })).rejects.toThrow(/loadedBy/);
    expect(await counts()).toEqual({ loads: 0, rows: 0 });
  });

  it("L6: the database holds the one-load rules even past the loader — UNIQUE sha and release", async () => {
    await load(file());
    const dup = (over: Record<string, string>) => db.insert(icd11MapLoads).values({
      id: "x", release: "2027-01", sourceFile: "f", sha256: "other", rowCount: 1, loadedBy: "t", ...over,
    });
    const [rec] = await db.select().from(icd11MapLoads);
    await expect(dup({ sha256: rec!.sha256 })).rejects.toThrow(/icd11_map_loads_sha256_uq/);
    await expect(dup({ release: "2026-01" })).rejects.toThrow(/icd11_map_loads_release_uq/);
    const kinds = await db.execute(sql`select count(*)::int as n from icd11_map_rows where map_kind not in ('mapped', 'grouping', 'no_mapping')`);
    expect((kinds.rows[0] as { n: number }).n).toBe(0);
  });

  it("L7: the CLI's arguments — the path first or last, --by optional", () => {
    expect(parseArgs(["/x/10To11MapToOneCategory.txt", "--release", "2026-01"])).toEqual({ path: "/x/10To11MapToOneCategory.txt", release: "2026-01", by: null });
    expect(parseArgs(["--release", "2026-01", "--by", "dr.mrd", "f.txt"])).toEqual({ path: "f.txt", release: "2026-01", by: "dr.mrd" });
    expect(() => parseArgs(["f.txt"])).toThrow(/usage/);
    expect(() => parseArgs(["--release", "2026-01"])).toThrow(/usage/);
  });

  it("L8: --from-who hands WHO's file to the SAME load — its record names the URL, and the same bytes from disk are then the same file", async () => {
    const zip = syntheticWhoZip();
    const fetch = async () => new Response(new Uint8Array(zip));
    const src = await readSource({ fromWho: "2099-01", sha256: sha256Of(zip), by: null }, { fetch });
    expect(src).toMatchObject({
      release: "2099-01", sourceFile: "https://icdcdn.who.int/static/releasefiles/2099-01/mapping.zip#10To11MapToOneCategory.txt",
    });
    expect(src.download).toMatchObject({ zipBytes: zip.length, zipSha256: sha256Of(zip), checksum: "given" });

    const r = await loadIcd11Map(db, { bytes: src.bytes, sourceFile: src.sourceFile, release: src.release, loadedBy: "dr.mrd" });
    expect(r).toMatchObject({ status: "loaded", release: "2099-01", rows: SYNTHETIC_ROWS.length });
    const [rec] = await db.select().from(icd11MapLoads);
    /* The load's sha256 is the TEXT file's, as it is for a path — which is what makes the next line refuse. */
    expect(rec).toMatchObject({ sourceFile: src.sourceFile, sha256: sha256Of(file()), loadedBy: "dr.mrd", rowCount: SYNTHETIC_ROWS.length });
    expect(await load(file(), "2099-02")).toMatchObject({ status: "refused", reason: "same_file" });
    expect(await counts()).toEqual({ loads: 1, rows: SYNTHETIC_ROWS.length });
  });
});
