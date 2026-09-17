/**
 * ═══ THE MODULE'S EXPORT SURFACE, FROZEN ═══
 *
 * WHAT THIS IS FOR. `listSalts`, `listMedicines` and `listInteractions` were deleted from this
 * module, not capped. They read every row of a table and then asked for the composition with
 * `inArray(medicineId, <every id>)`; drizzle emits one bind parameter per value and the Postgres
 * wire Bind message counts them in an Int16, so past 65,535 rows the count wraps and the server
 * refuses the message outright — reproduced against the loaded national catalogue at 103,383 ids:
 * `08P01 bind message has 37847 parameter formats but 0 parameters`.
 *
 * They were DELETED rather than capped because a capped version leaves "give me the catalogue"
 * spellable, and the next caller spells it and is handed a silently SHORT answer. For the item
 * master importer that is worse than the crash: it would report `unknown_medicine_brand` for every
 * drug past the cap and nobody would see an error. The bounded reads in `reads.ts` replace them by
 * answering the questions callers actually have — these ids, this equivalence, does this id exist,
 * one page of this list.
 *
 * WHY A COMPLETENESS PIN AND NOT AN ABSENCE ASSERTION. The obvious guard is
 * `expect(exports).not.toContain("listMedicines")`, and it is the weaker instrument twice over: it
 * passes if the unbounded read comes back under a different name (`allMedicines`,
 * `listMedicinesV2`), and it says nothing at all when a bounded read silently DISAPPEARS and some
 * module quietly goes back to querying the tables directly. An exact list fails in both
 * directions — when something vanishes AND when something appears — which is the only shape that
 * notices a regression nobody thought to name.
 *
 * WHEN THIS FAILS. It is EXPECTED to fail whenever the surface changes on purpose. That failure is
 * the test working: it is asking you to look at what you just added or removed and say that you
 * meant it. The fix is to read the new list off `index.ts` and update the literal below
 * deliberately — NEVER to loosen the matcher to `arrayContaining`, `toContain`, or a length check.
 * Every one of those turns this file back into a test that cannot see the defect it was written
 * for.
 *
 * Types are absent by construction: `export type` erases at compile time, so this pins the RUNTIME
 * surface — which is the one another module can reach for.
 */

/**
 * A STATIC namespace import, not `await import("./index")`. Under `moduleResolution: nodenext` a
 * dynamic `import()` is always ESM-resolved and so demands an explicit `./index.js` extension
 * (TS2835) — which jest, transpiling this file to CommonJS, could not then resolve. The static
 * form is extensionless on both sides and yields the same object: the module's runtime exports.
 */
import * as formulary from "./index";

/** Sorted by `Array.prototype.sort`'s default UTF-16 order, so SCREAMING and Pascal names lead. */
const SURFACE = [
  "ALLERGY_CLASSES", // P22 — the allergy class vocabulary the prescribing check reads
  "FORMULARY_EVENTS",
  "FormularyError",
  "MAX_IDS",
  "MAX_SUGGESTIONS",
  "MIN_QUERY_CHARS",
  "THERAPEUTIC_DUPLICATE_CLASSES", // P23 — the classes the duplicate-therapy notice knows
  "addInteraction",
  "addMedicine",
  "addSalt",
  "admitStaging",
  "adoptAllergyClasses", // P22 — allergy class memberships adopted under a named resolution
  "adoptDecisions",
  "adoptDrugDisease", // P24 — what a diagnosis forbids, adopted under a named resolution
  "adoptInteractions", // P21 — interaction pairs adopted under a named resolution
  "adoptTherapeuticClasses", // P23 — therapeutic classes adopted under a named resolution
  "allergyClassKeys", // P22 — pure: the classes an allergy record names
  "attestSubstance",
  "catalogueCensus",
  "countSalts",
  "equivalentMedicines",
  "formularyHttpStatus",
  "formularyManifest",
  "getStagingRow",
  "isEquivalentMedicine",
  "listInteractionsAmong",
  "medicineExists",
  "medicineIdsByBrandNames",
  "medicinesByIds",
  "normalizeDrugName",
  "pageInteractions",
  "pageMappingWorklist",
  "pageMedicines",
  "pageSalts",
  "projectSubstances",
  "refreshRankSignals",
  "rejectStaging",
  "resolveDrugTexts",
  "resolveMedicines",
  "ruleSubstanceUnmappable",
  "saltIdsByNames",
  "saltsByIds",
  "searchMedicines",
  "searchStaging",
  "suggestDrugs",
  "suggestMoieties",
  "unreviewedSaltIds",
  "updateInteraction",
  "updateMedicine",
  "updateSalt",
  "writeProposals",
];

describe("the formulary module's public surface", () => {
  it("exports exactly this list and nothing else", () => {
    const surface = Object.keys(formulary).sort();

    expect(surface).toEqual(SURFACE);
  });

  /**
   * Not a duplicate of the pin above — it is the pin's REASON, kept legible. If this file is ever
   * read by somebody wondering why the list is exact, these three names are the answer, and the
   * assertion states plainly that their return under their own names is a regression.
   */
  it("does not carry the three unbounded reads that broke on the national catalogue", () => {
    const surface = Object.keys(formulary);

    expect(surface).not.toContain("listSalts");
    expect(surface).not.toContain("listMedicines");
    expect(surface).not.toContain("listInteractions");
  });
});
