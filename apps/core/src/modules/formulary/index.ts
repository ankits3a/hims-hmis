/**
 * PLAN 16a — the formulary module's public surface.
 *
 * OTHER MODULES IMPORT FROM HERE AND FROM NOWHERE ELSE (DD1, and the `listAllergies` precedent):
 * `modules/opd` consumes the resolution read helpers T3 adds below; it never imports
 * `kernel/db/schema/formulary` and never queries these tables itself.
 */
export { formularyManifest } from "./manifest";
export { FormularyError, formularyHttpStatus } from "./errors";
export type { FormularyErrorCode } from "./errors";
export { FORMULARY_EVENTS } from "./events";
export {
  addInteraction, addMedicine, addSalt, updateInteraction, updateMedicine, updateSalt,
} from "./masters";
export type { InteractionRow, MedicineWithSalts, MedicineRow, RouteClass, SaltRow, Severity } from "./masters";
/**
 * T3 — THE BOUNDARY `modules/opd` ACTUALLY CONSUMES. Everything above is the curation surface;
 * these four are what the prescription pipeline calls at issue time. DD2 lives in
 * `resolveDrugTexts`: exact resolution only, `null` for anything else.
 */
export { listInteractionsAmong, normalizeDrugName, resolveDrugTexts, resolveMedicines } from "./resolve";
export type { InteractionPair, ResolvedDrug, SaltRef } from "./resolve";
/**
 * THE BOUNDED READS, AND THEY ARE THE ONLY READS.
 *
 * `listMedicines`, `listSalts` and `listInteractions` used to sit in the block above and answer
 * "give me the whole table" — a question no caller ever actually had, and which THROWS on the wire
 * past 65,535 rows (`kernel/db/any-of.ts`). They were DELETED rather than capped, because a capped
 * version leaves the unbounded question spellable and the next caller spells it.
 *
 * These answer the questions the callers do have, and each NAME carries its bound: these ids, this
 * page, this count, this equivalence, does this id exist. `index.test.ts` freezes this list, so an
 * unbounded read cannot quietly return under another name.
 */
export {
  MAX_IDS, catalogueCensus, countSalts, medicineExists, medicineIdsByBrandNames, medicinesByIds,
  pageInteractions, pageMedicines, pageSalts, saltIdsByNames, saltsByIds, suggestMoieties, unreviewedSaltIds,
} from "./reads";
export type { CatalogueCensus, MoietySuggestion } from "./reads";
export { equivalentMedicines, isEquivalentMedicine } from "./equivalence";
export type { EquivalentMedicine } from "./equivalence";
/** T7 — staging admission. `searchStaging` may match generously; nothing here resolves anything. */
export { MAX_SUGGESTIONS, MIN_QUERY_CHARS, suggestDrugs } from "./suggest";
export type { DrugSuggestion } from "./suggest";
export { admitStaging, getStagingRow, rejectStaging, searchStaging } from "./staging";
export type { StagingRow } from "./staging";

export { searchMedicines } from "./search";
/**
 * The CDS regimen fill's door: a composition (moieties + strengths + form) to ONE catalogue
 * product — a stocked one first, else a generic — or null. Exact, never nearest. See `products.ts`.
 */
export { MAX_PRODUCT_SPECS, matchProducts } from "./products";
export type { FormClass, ProductMatch, ProductSpec } from "./products";
export type { MedicineHit } from "./search";
/**
 * PHASE 2 — THE MAPPING LOOP. `attestSubstance` and `ruleSubstanceUnmappable` are the only writers
 * of a release substance's decision. `projectSubstances` and `refreshRankSignals` are exported for
 * the catalogue importer, which writes rows a projection must place, and they are catalogue writes:
 * no request handler outside this module has a reason to call them. `writeProposals` is the
 * drafter's door. It writes advice, never a decision.
 */
export {
  attestSubstance, pageMappingWorklist, projectSubstances, refreshRankSignals, ruleSubstanceUnmappable,
  writeProposals,
} from "./mapping";
/**
 * PHASE 3 — ADOPTION. The owner's ruling (phase-3 doc §1): every pending substance decided under
 * one named resolution, by a person, through the two writers above. A script's door, not a route's.
 */
export { adoptDecisions } from "./adoption";
export type { AdoptionItem, AdoptionReport } from "./adoption";
/** P21 — interaction pairs adopted from a reference under a named resolution. */
export { adoptInteractions } from "./interaction-adoption";
export type { InteractionAdoptionReport, InteractionRule } from "./interaction-adoption";
/**
 * P22 — allergy classes: the vocabulary the prescribing check reads (pure), and the memberships
 * adopted from the clinical master under a named resolution.
 */
export { ALLERGY_CLASSES, adoptAllergyClasses, allergyClassKeys } from "./allergy-classes";
export type { AllergyClassAdoptionReport, AllergyClassEntry, AllergyClassKey } from "./allergy-classes";
/** P23 — therapeutic classes for duplicate-therapy notices, adopted under a named resolution. */
export { THERAPEUTIC_DUPLICATE_CLASSES, adoptTherapeuticClasses } from "./therapeutic-classes";
export type { TherapeuticClassAdoptionReport, TherapeuticClassEntry } from "./therapeutic-classes";
export type {
  AttestTarget, MappingDecision, ProjectionResult, ProposalBasis, ProposalInput, ProposalWriteResult,
  WorklistItem, WorklistProposal, WorklistStatus,
} from "./mapping";

/** P24 — what a patient's diagnosis forbids, adopted from a reference under a named resolution. */
export { adoptDrugDisease } from "./drug-disease-adoption";
export type { DrugDiseaseAdoptionReport, DrugDiseaseRule } from "./drug-disease-adoption";
export { listDrugDiseaseFor } from "./resolve";
export type { DrugDiseaseRow } from "./resolve";
/** The offer a drug-disease alert carries. Declared with the table; the checks read it here. */
export type { DrugDiseaseAlternative } from "../../kernel/db/schema";
/**
 * PHARMACY P6 — the NDPS Act's classes on the moieties: the cited list, the medicine's strictest class,
 * and the classification (a script's door, `classify-ndps-salts`).
 */
export { NDPS_CLASSES, NDPS_LIST, classifyNdpsSalts, ndpsClassByMedicine } from "./ndps";
export type { NdpsClass, NdpsClassificationReport, NdpsEntry } from "./ndps";
