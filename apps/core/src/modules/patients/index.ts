/**
 * THE cross-module interface of the patients module (spec §4). Later modules import from
 * here or consume events — never internals; the module-isolation lint rule enforces it.
 * Everything else in this folder is private.
 */
export { patientsManifest } from "./manifest";
export { PatientsModule } from "./patients.module";
export { getPatient, registerPatient, resolvePatientId, updatePatient } from "./registration";
export type { CoverageInput, GuardianInput, PatientPatch, PatientRow, RegisterPatientInput } from "./registration";
export { getPatientSummaries, listMergedLoserIds } from "./registration"; // Plan 07 read helpers
export type { PatientSummary } from "./registration";
/**
 * FD-25 — the read that makes `patient_coverages` not write-only. See the file's header for what
 * that meant: registration has been collecting policy numbers at the counter since FD-12 and the
 * product could not show one to anybody afterwards.
 */
export { listPatientCoverages } from "./coverages";
export type { CoverageRow } from "./coverages";
export { listAllergies } from "./allergies";
export type { AllergyRow } from "./allergies";
export { searchPatients, visiblePatientIds } from "./search";
export type { MatchLane, PatientSearchResult } from "./search";
/** FD-8 — the near-match probe, shared by `POST /patients` and the walk-in. */
export { nearMatches } from "./duplicates";
export type { DuplicateCandidate } from "./duplicates";
export { NO_AUTHORITY, effectiveGuardianAuthority, guardiansWithAuthority, sweepGuardianMajority } from "./guardians";
export type { GuardianAuthority, GuardianRow } from "./guardians";
/**
 * PLAN 15 T5 / A1 — `verifyQrScan` JOINS THIS INDEX. A second one-line cross-module widening with a
 * reason: the mini-OT's holding verification IS a QR scan against a wristband, and it is the same
 * act `patients.controller.ts` already performs at the desk. Reaching into `./qr` would be the §4
 * violation; re-implementing the signature check in the OT module would be a second answer to "is
 * this card genuine", which is the one question that must have exactly one.
 */
export { displayName, displayNameFor } from "./display-name";
export type { NameablePatient } from "./display-name";
export { verifyQrScan } from "./qr";
export type { QrVerifyResult } from "./qr";
export { isValidUhid, PatientError } from "./uhid";
export type { PatientErrorCode } from "./uhid";
export * from "./events";
