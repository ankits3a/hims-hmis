import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { formularyGenerics } from "../../kernel/db/schema";
import { MIN_QUERY_CHARS, suggestDrugs } from "./suggest";
import type { Db } from "../../kernel/db/client";

/**
 * THE PRESCRIBER'S DRUG SEARCH.
 *
 * Every fixture below is a REAL row shape from the NRCeS national release, including the SNOMED
 * fully-specified-name wrapper on `name`, because the normalisation is the thing most likely to be
 * quietly lost and a fixture that carried pre-cleaned names could not detect that.
 */
const AUDIT = { createdBy: "t", updatedBy: "t" };
const REL = "nrces-2026-09";

/** `name` as released; `nameNormalized` as the loader produces it. */
function generic(
  id: string, sctid: string, raw: string, normalized: string, doseForm: string,
  route = "Oral route", composition: string | null = null, active = true,
): typeof formularyGenerics.$inferInsert {
  return {
    id, sctid, name: raw, nameNormalized: normalized, doseForm,
    routeOfAdministration: route, compositionSummary: composition,
    source: REL, active, ...AUDIT,
  };
}

describe("suggestDrugs — molecule and strength, no brand", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); });

  async function seed(): Promise<void> {
    await db.insert(formularyGenerics).values([
      // The plain molecule — ONE component, and deliberately the LONGER string of the two
      // prefix matches, because the release writes the salt form into its name.
      generic("G1", "1001", "Product containing precisely amlodipine (as amlodipine besylate) 5 mg oral tablet (clinical drug)",
        "amlodipine (as amlodipine besylate) 5 mg oral tablet", "Oral tablet",
        "Oral route", "Amlodipine besilate (5/1 milligram/Tablet)"),
      // A fixed-dose combination naming amlodipine FIRST — same prefix, two components, and a
      // SHORTER name than G1. This pair is what makes the ranking assertion discriminate.
      generic("G2", "1002", "Product containing precisely amlodipine 5 mg and atorvastatin 10 mg oral tablet (clinical drug)",
        "amlodipine 5 mg and atorvastatin 10 mg oral tablet", "Oral tablet",
        "Oral route", "Amlodipine besilate (5/1 mg/Tablet) + Atorvastatin calcium (10/1 mg/Tablet)"),
      // A combination that only CONTAINS amlodipine — lane 2, must rank below both of the above.
      generic("G3", "1003", "Telmisartan 40 mg and amlodipine 5 mg oral tablet",
        "Telmisartan 40 mg and amlodipine 5 mg oral tablet", "Oral tablet",
        "Oral route", "Telmisartan (40/1 mg/Tablet) + Amlodipine besilate (5/1 mg/Tablet)"),
      generic("G4", "1004", "Pantoprazole 40 mg gastro-resistant oral tablet",
        "Pantoprazole 40 mg gastro-resistant oral tablet", "Gastro-resistant oral tablet",
        "Oral route", "Pantoprazole sodium (40/1 mg/Tablet)"),
      // Inactive: a withdrawn drug must not be prescribable.
      generic("G5", "1005", "Rofecoxib 25 mg oral tablet", "Rofecoxib 25 mg oral tablet",
        "Oral tablet", "Oral route", null, false),
    ]);
  }

  it("finds a drug by its molecule, with no brand anywhere in the answer", async () => {
    await seed();
    const hits = await suggestDrugs(db, "amlodipine");
    expect(hits.map((h) => h.genericId)).toContain("G1");
    expect(hits[0]?.name).toContain("amlodipine");
    // The whole point of this slice: nothing branded is returned, and no medicine id is offered.
    expect(Object.keys(hits[0] ?? {})).not.toContain("medicineId");
  });

  it("STRIPS THE SNOMED WRAPPER — searching 'product' does not return 47% of the catalogue", async () => {
    await seed();
    // `name` still begins "Product containing precisely" for G1 and G2. If search ever reads
    // `name` instead of `name_normalized`, this query returns them and the doctor's five-character
    // search returns 2,357 rows on the real release.
    expect(await suggestDrugs(db, "product")).toEqual([]);
  });

  it("ranks a prefix match above a contains match, and the plain molecule above the combination", async () => {
    await seed();
    const ids = (await suggestDrugs(db, "amlodipine")).map((h) => h.genericId);
    // G1 (prefix, ONE component) → G2 (prefix, two) → G3 (contains only).
    // NOTE: G1's name is LONGER than G2's — 51 characters against 49 — because the release writes
    // the salt form into it. This assertion failed when the rule was "shortest name wins", which
    // is how that rule was found to be backwards.
    expect(ids).toEqual(["G1", "G2", "G3"]);
  });

  it("reports WHICH lane matched, so the screen can show the doctor why a row is there", async () => {
    await seed();
    const byId = new Map((await suggestDrugs(db, "amlodipine")).map((h) => [h.genericId, h.matchedOn]));
    expect(byId.get("G1")).toBe("prefix");
    expect(byId.get("G3")).toBe("contains");
  });

  it("carries dose form on every row — a composition without its form is two drugs that look alike", async () => {
    await seed();
    const hit = (await suggestDrugs(db, "pantoprazole"))[0];
    expect(hit?.doseForm).toBe("Gastro-resistant oral tablet");
    expect(hit?.route).toBe("Oral route");
  });

  it("never offers an inactive drug", async () => {
    await seed();
    expect(await suggestDrugs(db, "rofecoxib")).toEqual([]);
  });

  it("answers a too-short query with nothing, never with the catalogue", async () => {
    await seed();
    for (const q of ["", "a", "am"]) expect(await suggestDrugs(db, q)).toEqual([]);
    expect((await suggestDrugs(db, "aml")).length).toBeGreaterThan(0);
    expect(MIN_QUERY_CHARS).toBe(3);
  });

  it("treats % and _ as characters a doctor typed, not as wildcards", async () => {
    await seed();
    // Unescaped, `%%%` is "match everything" and would hand back the whole catalogue on a
    // stray keypress. `a_l` would match "aml" by LIKE's single-character wildcard.
    expect(await suggestDrugs(db, "%%%")).toEqual([]);
    expect(await suggestDrugs(db, "a_lodipine")).toEqual([]);
  });

  it("clamps the limit instead of refusing — a typeahead must not 400 on a stray parameter", async () => {
    await seed();
    expect((await suggestDrugs(db, "amlodipine", { limit: 1 })).length).toBe(1);
    expect((await suggestDrugs(db, "amlodipine", { limit: 9999 })).length).toBe(3);
  });

  it("orders identically across repeated identical queries", async () => {
    await seed();
    // Without the alphabetical tie-break, two rows of equal length can swap between keystrokes and
    // the row under the doctor's cursor changes as they type.
    const a = (await suggestDrugs(db, "tablet")).map((h) => h.genericId);
    const b = (await suggestDrugs(db, "tablet")).map((h) => h.genericId);
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(1);
  });
});
