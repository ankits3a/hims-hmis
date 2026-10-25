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
  "ALIAS_POOL_SIZE", // decision 0051 — how many catalogue rows the alias pipeline is shown for one term
  "ALIAS_WORD_SIMILARITY", // decision 0051 — the trigram line a candidate must reach
  "ALLERGY_CLASSES", // P22 — the allergy class vocabulary the prescribing check reads
  "AWARE_LIST", // PHARMACY STAGE D5 — the cited WHO AWaRe 2023 list, by moiety set and route
  "DDINTER_LICENCE", // #617 (decision 0052) — the share-alike notice that travels with the DDInter rows
  "DDINTER_SOURCE", // #617 — the source every DDInter reference row and alert names
  "FORMULARY_EVENTS",
  "FormularyError",
  "MAX_IDS",
  "MAX_PRODUCT_SPECS", // the CDS regimen fill's bound: one regimen, not a catalogue
  "MAX_SUGGESTIONS",
  "MIN_QUERY_CHARS",
  "NDPS_CLASSES", // PHARMACY P6 — the NDPS Act's two classes
  "NDPS_LIST", // PHARMACY P6 — the cited list of controlled moieties
  "REFERENCE_INTERACTION_LABEL", // #617 — "Reference interaction (DDInter)", the first words of every reference alert
  "REFERENCE_SECTIONS", // #616 (decision 0051) — the FDA label reference sections, in reading order
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
  "aliasCandidatePool", // decision 0051 — the rows an unmatched term could mean; offline, never a typeahead
  "allergyClassKeys", // P22 — pure: the classes an allergy record names
  "attestSubstance",
  "brandTitle", // owner 2026-10-04 — pure: a vendor brand in the catalogue's case
  "catalogueCensus",
  "catalogueTwinForm", // pure: a catalogue form on the twin scale
  "classifyAwareMedicines", // PHARMACY STAGE D5 — the list written onto products whose class is null (aware:classify, the go-live act; never seed:pharmacy)
  "classifyNdpsSalts", // PHARMACY P6 — the cited list written onto the catalogue (a script's door)
  "compositionAgrees", // owner 2026-10-04 — does a brand-name match say what the vendor's composition says
  "compositionTwins", // owner 2026-10-04 — a vendor brand the catalogue lacks → the medicine of its composition, one spec at a time
  "counsellingByMedicine", // the counter's reader: what to tell the patient, from reviewed monographs only
  "counsellingOf",
  "countReferenceInteractions", // #617 — live DDInter reference pairs, for the replay script
  "countSalts",
  "ddinterReferenceEnabled", // #617 — the kill switch DDINTER_REFERENCE_ENABLED; ships OFF, only "true" turns it on
  "equivalentMedicines",
  "formularyHttpStatus",
  "formularyManifest",
  "getMonograph", // the drug monograph (owner 2026-10-02): reviewed text only, unless the curation door asks
  "getStagingRow",
  "importDdinterInteractions", // #617 — the DDInter importer (a script's door): Major only, dry run unless applied
  "importReferenceLabels", // #616 — the FDA label importer (a script's door); dry run unless applied
  "interactionRulesPresent", // IPD E4.3 (#735) — the verify queue says "no interaction data" when no pair is adopted
  "isEquivalentMedicine",
  "linkMedicinesToGenerics", // owner 2026-10-02: fills a product's empty generic link from the bundle's pairs
  "listDrugDiseaseFor", // P24 — the rules that reach these moieties and these diagnosis codes
  "listInteractionsAmong",
  "listInteractionsForCheck", // #617 — what the prescription check reads: curated, plus reference pairs only when switched on
  "listReferenceInteractionsAmong", // #617 — live reference pairs the curated book does not hold (the replay reads it OFF)
  "matchProducts", // the CDS regimen fill: a composition to one stocked-or-generic product, exact
  "medicineExists",
  "medicineHitById", // decisions 0051/0055 — one catalogue row in the search's own shape, for a learned nickname's medicine
  "medicineIdsByBrandNames",
  "medicinesByBrandPrefix", // owner 2026-10-04 — a vendor price list's brand stem, read for the pharmacy's import
  "medicinesByIds",
  "monographForMedicine", // the reviewed monograph a stocked product reaches through its generic link
  "ndpsClassByMedicine", // PHARMACY P6 — bounded by MAX_IDS, the strictest class of each medicine's moieties
  "ndpsClassOfMoieties", // #613 — pure: stored class, else the cited list, strictest across moieties (learned nicknames)
  "ndpsListEntryOf", // #613 — pure: the cited NDPS entry a moiety name is, or null
  "normalizeDrugName",
  "pageInteractions",
  "pageMappingWorklist",
  "pageMedicines",
  "pageSalts",
  "parseComposition",
  "parseDdinterCsv", // #617 — pure: a DDInter export → its Major pairs and the counts of the rest // pure: a vendor's composition column into moieties and strengths
  "planReferenceImport", // #616 — pure: the coverage choices + label lines → rows, names, missing
  "projectSubstances",
  "referenceForGeneric", // #616 — the US FDA label reference for a generic; reference only, never a dose or a check
  "referenceSectionsOf", // #616 — pure: one openFDA label → its reference sections
  "refreshRankSignals",
  "registerNicknameLookup", // decisions 0051/0055 — OPD registers its nickname reader with the prescriber's search
  "rejectStaging",
  "renalDoseFor",
  "renalRulesByMedicine", // #621 — each product's REVIEWED renal bands, for the opd renal dose check
  "replayReferenceInteractions", // #617 — stored prescriptions replayed with and without the reference layer; reads only
  "resolveDrugTexts",
  "resolveMedicines",
  "restrictedAntimicrobialExists", // PHARMACY STAGE D5 — the office's "no steward appointed" row asks it
  "reviewMonograph",
  "ruleSubstanceUnmappable",
  "saltIdsByNames",
  "saltsByIds",
  "saveMonograph",
  "searchGenerics", // the monograph curation door's typeahead
  "searchMedicines",
  "searchMedicinesForPrescribing", // decisions 0051/0055 — the catalogue's answer plus a learned nickname's row
  "searchStaging",
  "suggestDrugs",
  "suggestMoieties",
  "tidyCatalogueName", // pure: the SNOMED sentence in a label's words
  "twinFormAgrees", // pure
  "twinFormOf", // pure: the form a vendor's row names
  "twinName", // pure: the catalogue name a vendor brand gets
  "twinStrengthAgrees", // pure: each component its own strength
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
