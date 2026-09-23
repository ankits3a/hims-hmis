/**
 * The CDS module's cross-module interface. It is a LIBRARY and not a Nest module: the co-pilot has
 * no screen and no routes of its own, because it exists inside the consultation — `opd` mounts the
 * two read routes under its own `opd.consult` grant, which is the authority a doctor writing the
 * note already holds. A permission of its own would be a second name for the same thing, and
 * `seed-roles.ts` pins the count.
 */
export { KNOWLEDGE, rulesOf, syndromeByKey } from "./knowledge";
export type { CdsRule, Dosing, Knowledge, RegimenLine, Syndrome } from "./knowledge";
export { allSyndromes, rankSyndromes } from "./matcher";
export type { SyndromeHit } from "./matcher";
export { bandFor, buildRegimen, doseFor } from "./regimen";
export type { BuiltLine, BuiltRegimen, DoseVerdict, PatientBand, PatientFacts } from "./regimen";
export { cardsFor } from "./guardrails";
export type { Card } from "./guardrails";
export { durationDaysOf, frequencyOf, toRxDraft } from "./rx";
/** Each regimen label as a composition, so the fill can carry a real medicine (2026-09-23). */
export { productSpecFor } from "./products";
export type { RxDraftLine } from "./rx";
export { completeComplaint, complaintVocabulary, ghostFor } from "./vocabulary";
export type { ComplaintTerm } from "./vocabulary";
export { MIN_QUERY_CHARS as ICD10_MIN_QUERY_CHARS, searchIcd10 } from "./icd10";
export type { Icd10Hit } from "./icd10";
export { ALLERGEN_MIN_CHARS, matchesAKnownAllergen, searchAllergens } from "./allergens";
export type { AllergenHit } from "./allergens";
