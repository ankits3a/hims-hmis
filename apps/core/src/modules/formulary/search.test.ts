import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { formularyMedicines, formularyMedicineSalts, formularySalts } from "../../kernel/db/schema";
import { searchMedicines } from "./search";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ THE DRUG TYPEAHEAD, AND THE ONE THING A PICK MUST GUARANTEE ═══
 *
 * `searchMedicines` shipped with the catalogue import and with no suite of its own. This is it, and
 * the case it exists for is the one #186 and this lane disagreed about in writing.
 *
 * #186's `DrugCombobox` fills the drug NAME and deliberately leaves `medicineId` null, on a stated
 * premise: *"setting `medicineId` on a 97.7%-uncurated catalogue makes coverage report a working
 * formulary while nothing is checked."* The mechanism is real — `resolveMedicines` (resolve.ts:147)
 * returns an entry for any ACTIVE medicine, `salts: []` and all, and `getCoverage` (curation.ts:80)
 * counts any entry as resolved. So a picked line with no moiety is counted as covered while no
 * interaction, duplicate or allergy check can say one word about it.
 *
 * The PREMISE, though, is a measurement of a formulary that no longer exists. Measured on the
 * imported catalogue, 2026-09-14:
 *
 *     active medicines             103,383
 *     with at least one moiety     103,375      (99.992%)
 *     active, NO moiety                  8
 *
 * Eight rows, not 97.7% of them. But eight is not zero, and "the number is small now" is not a
 * guard — the import could bring more tomorrow. So the objection is answered STRUCTURALLY rather
 * than argued away: a row the checks cannot reason about is not offered for picking at all. Then a
 * `medicineId` on a line always carries a composition, coverage counts only lines something can
 * actually check, and the field can fill the id — which is the whole point of picking rather than
 * typing, and what the owner's ruling of 2026-09-14 asks for: one drug list, one safety layer.
 */
const AUDIT = { createdBy: "t", updatedBy: "t" };

describe("searchMedicines — the typeahead over the imported catalogue", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); });

  async function seed(): Promise<void> {
    await db.insert(formularySalts).values([
      { id: "S1", name: "Amoxicillin", productCount: 3830, ...AUDIT },
      { id: "S2", name: "Clavulanic acid", productCount: 900, ...AUDIT },
      { id: "S3", name: "Amoxapine", productCount: 14, ...AUDIT },
    ]);
    await db.insert(formularyMedicines).values([
      { id: "M1", brandName: "Amoxil 500", form: "Capsule", routeClass: "systemic", saltRank: 3830, ...AUDIT },
      { id: "M2", brandName: "Augmentin 625", form: "Tablet", routeClass: "systemic", saltRank: 3830, ...AUDIT },
      // DELIBERATELY THE SHORTER NAME. Every tie-break BELOW `salt_rank` — similarity, then
      // length, then alphabetical — prefers this row over "Amoxil 500". So if the assertion in
      // S3 holds, `salt_rank` is the only thing that can have produced it.
      { id: "M3", brandName: "Amox 50", form: "Tablet", routeClass: "systemic", saltRank: 14, ...AUDIT },
      // THE ROW THIS SUITE EXISTS FOR: a brand-name match that carries no moiety at all. It is one
      // of the eight the bundle left uncomposed, and nothing downstream can check a line holding it.
      { id: "M4", brandName: "Amoxy Mystery Syrup", form: "Syrup", routeClass: "systemic", saltRank: 0, ...AUDIT },
      // Inactive: withdrawn, and never offered however well it matches.
      { id: "M5", brandName: "Amoxi Withdrawn", form: "Tablet", routeClass: "systemic", saltRank: 3830, active: false, ...AUDIT },
    ]);
    await db.insert(formularyMedicineSalts).values([
      { medicineId: "M1", saltId: "S1", strength: "500 mg", source: "curated" },
      { medicineId: "M2", saltId: "S1", strength: "500 mg", source: "curated" },
      { medicineId: "M2", saltId: "S2", strength: "125 mg", source: "curated" },
      { medicineId: "M3", saltId: "S3", strength: "50 mg", source: "curated" },
      { medicineId: "M5", saltId: "S1", strength: "500 mg", source: "curated" },
    ]);
  }

  it("S1: never offers a medicine with no moiety, however well its BRAND NAME matches", async () => {
    await seed();
    const hits = await searchMedicines(db, "amox");
    expect(hits.map((h) => h.id)).not.toContain("M4");
    // ...and not because the query found nothing: the composed neighbours are all there.
    expect(hits.map((h) => h.id).sort()).toEqual(["M1", "M2", "M3"]);
    // The guarantee the screen relies on to fill `medicineId`: every hit can be checked.
    expect(hits.every((h) => h.salts.length > 0)).toBe(true);
  });

  it("S2: reaches a brand through its MOIETY — `clav` must find Augmentin", async () => {
    await seed();
    const hits = await searchMedicines(db, "clav");
    expect(hits.map((h) => h.id)).toEqual(["M2"]);
    expect(hits[0]!.salts).toEqual(["Amoxicillin", "Clavulanic acid"]);
  });

  it("S3: the moiety the market is built around outranks the similar-but-rare one", async () => {
    await seed();
    const hits = await searchMedicines(db, "amox");
    /*
      Both are brand-PREFIX matches, so the first sort key cannot separate them and every key below
      `salt_rank` favours "Amox 50" — it is shorter, more trigram-similar to `amox`, and earlier
      alphabetically. Ranking on those alone is what once put Amoxapine (14 products) above
      Amoxicillin (3,830), measured against the real catalogue. `salt_rank` is the fix, and this is
      the assertion that fails if it is ever dropped from the ORDER BY.
    */
    const prefixed = hits.filter((h) => h.prefix).map((h) => h.id);
    expect(prefixed).toEqual(["M1", "M3"]);
    /* And the moiety-only match — the brand name says nothing about amoxicillin — sorts below both. */
    expect(hits[hits.length - 1]!.id).toBe("M2");
  });

  it("S4: an inactive medicine is never offered", async () => {
    await seed();
    const hits = await searchMedicines(db, "amoxi");
    expect(hits.map((h) => h.id)).not.toContain("M5");
  });

  it("S5: under two characters the route answers nothing rather than everything", async () => {
    await seed();
    expect(await searchMedicines(db, "a")).toEqual([]);
    expect(await searchMedicines(db, " ")).toEqual([]);
  });
});
