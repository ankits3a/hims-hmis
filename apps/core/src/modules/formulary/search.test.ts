import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { formularyMedicines, formularyMedicineSalts, formularySalts } from "../../kernel/db/schema";
import { searchMedicines } from "./search";
import type { Db } from "../../kernel/db/client";
import { normalizeDrugName } from "./resolve";

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
      { id: "S4", name: "Paracetamol", productCount: 4866, ...AUDIT },
      { id: "S5", name: "Sodium chloride", productCount: 126, ...AUDIT },
      { id: "S6", name: "Metformin hydrochloride", productCount: 1272, ...AUDIT },
    ]);
    await db.insert(formularyMedicines).values([
      { id: "M1", brandName: "Amoxil 500", nameNormalized: normalizeDrugName("Amoxil 500"), form: "Capsule", routeClass: "systemic", saltRank: 3830, ...AUDIT },
      { id: "M2", brandName: "Augmentin 625", nameNormalized: normalizeDrugName("Augmentin 625"), form: "Tablet", routeClass: "systemic", saltRank: 3830, ...AUDIT },
      // DELIBERATELY THE SHORTER NAME. Every tie-break BELOW `salt_rank` — similarity, then
      // length, then alphabetical — prefers this row over "Amoxil 500". So if the assertion in
      // S3 holds, `salt_rank` is the only thing that can have produced it.
      { id: "M3", brandName: "Amox 50", nameNormalized: normalizeDrugName("Amox 50"), form: "Tablet", routeClass: "systemic", saltRank: 14, ...AUDIT },
      // THE ROW THIS SUITE EXISTS FOR: a brand-name match that carries no moiety at all. It is one
      // of the eight the bundle left uncomposed, and nothing downstream can check a line holding it.
      { id: "M4", brandName: "Amoxy Mystery Syrup", nameNormalized: normalizeDrugName("Amoxy Mystery Syrup"), form: "Syrup", routeClass: "systemic", saltRank: 0, ...AUDIT },
      // Inactive: withdrawn, and never offered however well it matches.
      { id: "M5", brandName: "Amoxi Withdrawn", nameNormalized: normalizeDrugName("Amoxi Withdrawn"), form: "Tablet", routeClass: "systemic", saltRank: 3830, active: false, ...AUDIT },
      // THE ROWS THE TOKEN CASES EXIST FOR — shaped like the real catalogue, where the strength is
      // part of the NAME and the words a doctor says are never adjacent in it.
      { id: "M6", brandName: "Paracetamol 500 mg oral tablet", nameNormalized: normalizeDrugName("Paracetamol 500 mg oral tablet"), form: "Tablet", strengthLabel: "500 mg", code: "D0230", routeClass: "systemic", saltRank: 4866, ...AUDIT },
      { id: "M7", brandName: "Paracetamol 650 mg oral tablet", nameNormalized: normalizeDrugName("Paracetamol 650 mg oral tablet"), form: "Tablet", strengthLabel: "650 mg", code: "D0231", routeClass: "systemic", saltRank: 4866, ...AUDIT },
      // Its ONLY `5` is in the catalogue code. `par 5` must not reach it — see S8.
      { id: "M8", brandName: "Paracetamol 100 mg oral tablet", nameNormalized: normalizeDrugName("Paracetamol 100 mg oral tablet"), form: "Tablet", strengthLabel: "100 mg", code: "D9225", routeClass: "systemic", saltRank: 4866, ...AUDIT },
      // S10's pair, shaped exactly as the real catalogue holds them: the ORS brand is a WORD and
      // carries a small molecule's product count; the impostor merely begins with those letters and
      // rides paracetamol's 4,866.
      { id: "M9", brandName: "Ors (glucose and potassium chloride and sodium chloride)", nameNormalized: normalizeDrugName("Ors (glucose and potassium chloride and sodium chloride)"), form: "Sachet", strengthLabel: "13.5 g", code: "D5230", routeClass: "systemic", saltRank: 126, ...AUDIT },
      { id: "M10", brandName: "Orsodic-SP (diclofenac and paracetamol)", nameNormalized: normalizeDrugName("Orsodic-SP (diclofenac and paracetamol)"), form: "Tablet", strengthLabel: "50 mg", routeClass: "systemic", saltRank: 4866, ...AUDIT },
      // S11's three, as the real catalogue holds them: a brand merely SPELT met… riding
      // paracetamol's market share, a met… combination that also carries paracetamol, and the
      // molecule the doctor actually meant.
      { id: "M11", brandName: "Metacin (paracetamol) 500 mg oral tablet", nameNormalized: normalizeDrugName("Metacin (paracetamol) 500 mg oral tablet"), form: "Tablet", strengthLabel: "500 mg", routeClass: "systemic", saltRank: 4866, ...AUDIT },
      { id: "M12", brandName: "Metopar (metoclopramide and paracetamol) 5 mg + 500 mg oral tablet", nameNormalized: normalizeDrugName("Metopar"), form: "Tablet", strengthLabel: "5 mg", routeClass: "systemic", saltRank: 4866, ...AUDIT },
      { id: "M13", brandName: "Metformin hydrochloride 500 mg oral tablet", nameNormalized: normalizeDrugName("Metformin hydrochloride 500 mg oral tablet"), form: "Tablet", strengthLabel: "500 mg", code: "D1246", routeClass: "systemic", saltRank: 1272, ...AUDIT },
      // S12: the release's own phrasing for a generic — 4,921 active rows are named this way.
      // M15 differs from M14 in ONE respect: its name is not behind the release's lead-in. Same
      // moieties, same rank, same strength — so whichever wins, the boilerplate is the only cause.
      { id: "M15", brandName: "Amoxiclav 500 mg oral tablet", nameNormalized: normalizeDrugName("Amoxiclav 500 mg oral tablet"), form: "Tablet", strengthLabel: "500 mg", routeClass: "systemic", saltRank: 3830, ...AUDIT },
      { id: "M14", brandName: "Product containing precisely amoxicillin 500 milligram and clavulanic acid 125 milligram oral tablet", nameNormalized: normalizeDrugName("Product containing precisely amoxicillin"), form: "Tablet", strengthLabel: "500 mg", code: "D5953", routeClass: "systemic", saltRank: 3830, ...AUDIT },
    ]);
    await db.insert(formularyMedicineSalts).values([
      { medicineId: "M1", saltId: "S1", strength: "500 mg", source: "curated" },
      { medicineId: "M2", saltId: "S1", strength: "500 mg", source: "curated" },
      { medicineId: "M2", saltId: "S2", strength: "125 mg", source: "curated" },
      { medicineId: "M3", saltId: "S3", strength: "50 mg", source: "curated" },
      { medicineId: "M5", saltId: "S1", strength: "500 mg", source: "curated" },
      { medicineId: "M6", saltId: "S4", strength: "500 mg", source: "curated" },
      { medicineId: "M7", saltId: "S4", strength: "650 mg", source: "curated" },
      { medicineId: "M8", saltId: "S4", strength: "100 mg", source: "curated" },
      { medicineId: "M9", saltId: "S5", strength: "13.5 g", source: "curated" },
      { medicineId: "M10", saltId: "S4", strength: "50 mg", source: "curated" },
      { medicineId: "M11", saltId: "S4", strength: "500 mg", source: "curated" },
      { medicineId: "M12", saltId: "S4", strength: "500 mg", source: "curated" },
      { medicineId: "M12", saltId: "S6", strength: "5 mg", source: "curated" },
      { medicineId: "M13", saltId: "S6", strength: "500 mg", source: "curated" },
      { medicineId: "M14", saltId: "S1", strength: "500 mg", source: "curated" },
      { medicineId: "M14", saltId: "S2", strength: "125 mg", source: "curated" },
      { medicineId: "M15", saltId: "S1", strength: "500 mg", source: "curated" },
      { medicineId: "M15", saltId: "S2", strength: "125 mg", source: "curated" },
    ]);
  }

  it("S1: never offers a medicine with no moiety, however well its BRAND NAME matches", async () => {
    await seed();
    const hits = await searchMedicines(db, "amox");
    expect(hits.map((h) => h.id)).not.toContain("M4");
    // ...and not because the query found nothing: the composed neighbours are all there.
    expect(hits.map((h) => h.id)).toEqual(expect.arrayContaining(["M1", "M2", "M3"]));
    // The guarantee the screen relies on to fill `medicineId`: every hit can be checked.
    expect(hits.every((h) => h.salts.length > 0)).toBe(true);
  });

  it("S2: reaches a brand through its MOIETY — `clav` must find Augmentin", async () => {
    await seed();
    const hits = await searchMedicines(db, "clav");
    // Both rows carrying clavulanic acid are reached THROUGH THE MOIETY — neither name says `clav`
    // at its start, and M2's does not say it at all.
    expect(hits.map((h) => h.id).sort()).toEqual(["M14", "M15", "M2"]);
    expect(hits.find((h) => h.id === "M2")!.salts).toEqual(["Amoxicillin", "Clavulanic acid"]);
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
    /* The ORDER of these two is the whole assertion — Amoxicillin's market share above Amoxapine's.
       Other prefix matches may join the list (M14/M15 are amoxicillin combinations and belong
       here); what must never change is which of these two comes first. */
    expect(prefixed).toEqual(expect.arrayContaining(["M1", "M3"]));
    expect(prefixed.indexOf("M1")).toBeLessThan(prefixed.indexOf("M3"));
    /* And the moiety-only match — the brand name says nothing about amoxicillin — sorts below both. */
    expect(hits[hits.length - 1]!.id).toBe("M2");
  });

  /**
   * ═══ THE OWNER'S OWN EXAMPLES, 2026-09-17 ═══
   *
   * "para 500" and "par 5". Measured against the real catalogue BEFORE this change, both returned
   * **0 rows** — the words are in "Paracetamol 500 mg oral tablet", the phrase is not, and the
   * search was one substring. A doctor types the molecule and the strength because that is how a
   * drug is said out loud.
   */
  it("S6: `para 500` finds the 500, and `500 para` is the same request", async () => {
    await seed();

    // The pure 500 leads. Brands that merely CARRY paracetamol at 500 mg (M11, M12) match too and
    // belong below it — this assertion is about which row a doctor gets FIRST.
    const typed = await searchMedicines(db, "para 500");
    expect(typed[0]!.id).toBe("M6");

    // Length picks the anchor, not position: a doctor who says the strength first is not punished.
    const reversed = await searchMedicines(db, "500 para");
    expect(reversed[0]!.id).toBe("M6");
  });

  it("S7: every token must match — `para 650` does not offer the 500", async () => {
    await seed();
    const hits = await searchMedicines(db, "para 650");
    expect(hits.map((h) => h.id)).toEqual(["M7"]);
  });

  /**
   * `par 5` with the code in the haystack returned "Paracetamol 100 mg" first, because its code is
   * `D9225`. A bare digit matching a catalogue code is noise dressed as a match.
   */
  it("S8: a loose digit does not reach a row whose only match is its catalogue CODE", async () => {
    await seed();
    const hits = await searchMedicines(db, "par 5");
    expect(hits.map((h) => h.id)).not.toContain("M8");
    // The 500 and the 650 are both reached; M10 joins them legitimately, carrying paracetamol at
    // 50 mg — this assertion is about the row that must NOT be here, not about an exact set.
    expect(hits.map((h) => h.id)).toEqual(expect.arrayContaining(["M6", "M7"]));
  });

  it("S9: a code is still searchable when the doctor types the whole of it", async () => {
    await seed();
    const hits = await searchMedicines(db, "D0230");
    expect(hits.map((h) => h.id)).toEqual(["M6"]);
  });

  /**
   * `ors` used to return `Orsodic-SP` (diclofenac) and friends while the actual rehydration salts
   * sat below the fold. The cause was the RANKING, not the match: both start with those letters, so
   * the prefix test tied and `salt_rank` decided it — paracetamol's market share against ORS's.
   */
  it("S10: a whole word beats an accident of spelling — `ors` is the rehydration salts", async () => {
    await seed();
    const hits = await searchMedicines(db, "ors");
    expect(hits[0]!.id).toBe("M9");
    expect(hits.map((h) => h.id)).toContain("M10"); // the impostor is still reachable, just lower
  });

  /**
   * `met` returned four PARACETAMOL products — Metacin, Metalgin and two combinations — and no
   * metformin, metronidazole or metoprolol at all. 58 moieties begin with `met`, but paracetamol's
   * 4,866 products let any brand merely SPELT that way outrank every one of them.
   */
  it("S11: `met` is the molecule, not a brand that merely starts the same way", async () => {
    await seed();
    const hits = await searchMedicines(db, "met");
    // The molecule the doctor named, above the brand coincidence and above the combination.
    expect(hits[0]!.id).toBe("M13");
    expect(hits.map((h) => h.id)).toContain("M11"); // still reachable, just no longer first
  });

  /**
   * 4,921 active products — 4.8% of the catalogue — are named "Product containing precisely …".
   * The lead-in belongs to the terminology, not to the drug, and it begins with a P, so the prefix
   * test could never fire for any of them however exactly a doctor typed the molecule. Measured,
   * `amox clav` returned ten other strengths and not one of the 1,787 rows carrying amoxicillin
   * 500 + clavulanic acid 125 — the commonest strength dispensed in India. They were never missing;
   * they were behind a phrase nobody types.
   */
  it("S12: the release's boilerplate is not part of the drug's name", async () => {
    await seed();
    // M14 and M15 are the same drug written two ways. With the lead-in read past, both match the
    // prefix and the D-coded generic wins on provenance; with it left in, M14 cannot match the
    // prefix at all and the brand takes the slot.
    const hits = await searchMedicines(db, "amox clav 500");
    expect(hits[0]!.id).toBe("M14");
    // and the stored name is untouched — only the RANKING reads past the lead-in
    expect(hits[0]!.name).toMatch(/^Product containing precisely/);
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
