import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { seedIcd11Release } from "../../../test/helpers/icd11";
import { icd11ForCodes, withIcd11 } from "./icd11-lookup";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ THE READ-TIME ICD-11 LOOKUP ═══
 *
 * Null is the shipped state (nothing is loaded anywhere), so the first test is that the read is
 * silent on empty tables. Every row is SYNTHETIC — `test/helpers/icd11.ts` says why.
 */
describe("icd11ForCodes / withIcd11 — WHO's answer for an ICD-10 code, or null", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); });

  it("K1: NOTHING LOADED — every code answers null, and nothing throws", async () => {
    expect((await icd11ForCodes(db, ["X00", "X00.1"])).size).toBe(0);
    expect(await withIcd11(db, [{ c: "X00" }, { c: null }], (x) => x.c)).toEqual([{ c: "X00", icd11: null }, { c: null, icd11: null }]);
  });

  it("K2: a mapped code carries WHO's code, title and URI — and the release it came from", async () => {
    await seedIcd11Release(db, "2026-01", [{ icd10Code: "X00.1", icd11Code: "ZZ00&ZZ9P1", icd11Title: "Synthetic title" }]);
    const [hit] = await withIcd11(db, [{ code: "X00.1" }], (x) => x.code);
    expect(hit!.icd11).toEqual({
      code: "ZZ00&ZZ9P1", title: "Synthetic title", uri: "https://synthetic.invalid/release/2026-01/mms/0", release: "2026-01",
    });
  });

  it("K3: a GROUPING (no code) and WHO's 'No Mapping' both answer null", async () => {
    await seedIcd11Release(db, "2026-01", [
      { icd10Code: "X01", icd11Code: "", icd11Title: "Synthetic block", mapKind: "grouping" },
      { icd10Code: "X02", icd11Code: "", icd11Title: "", mapKind: "no_mapping" },
    ]);
    expect((await icd11ForCodes(db, ["X01", "X02"])).size).toBe(0);
  });

  it("K4: the LATEST release answers — by its name, not by which was loaded last", async () => {
    await seedIcd11Release(db, "2027-01", [{ icd10Code: "X00", icd11Code: "ZZ00.NEW", icd11Title: "Synthetic new" }]);
    await seedIcd11Release(db, "2026-01", [{ icd10Code: "X00", icd11Code: "ZZ00.OLD", icd11Title: "Synthetic old" }]);
    expect((await icd11ForCodes(db, ["X00"])).get("X00")).toMatchObject({ code: "ZZ00.NEW", release: "2027-01" });
  });

  it("K5: an EXACT match only — a child code WHO does not list never borrows its parent's answer", async () => {
    await seedIcd11Release(db, "2026-01", [{ icd10Code: "X00.1", icd11Code: "ZZ00", icd11Title: "Synthetic title" }]);
    /* `X00.19` is how an ICD-10-CM extension of a WHO code looks. Walking up to X00.1 would be OUR crosswalk. */
    const out = await withIcd11(db, [{ c: "X00.19" }, { c: "X00" }, { c: " x00.1 " }], (x) => x.c);
    expect(out.map((o) => o.icd11?.code ?? null)).toEqual([null, null, "ZZ00"]);
  });
});
