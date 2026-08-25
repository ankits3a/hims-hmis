/**
 * THE cross-module interface of the patients module (spec §4). Later modules import from
 * here or consume events — never internals; the module-isolation lint rule enforces it.
 * Everything else in this folder is private.
 */
export { patientsManifest } from "./manifest";
export { PatientsModule } from "./patients.module";
export { getPatient, registerPatient, resolvePatientId, updatePatient } from "./registration";
export type { GuardianInput, PatientPatch, PatientRow, RegisterPatientInput } from "./registration";
export { getPatientSummaries, listMergedLoserIds } from "./registration"; // Plan 07 read helpers
export type { PatientSummary } from "./registration";
export { listAllergies } from "./allergies";
export type { AllergyRow } from "./allergies";
export { searchPatients, visiblePatientIds } from "./search";
export type { PatientSearchResult } from "./search";
export { NO_AUTHORITY, effectiveGuardianAuthority, sweepGuardianMajority } from "./guardians";
export type { GuardianAuthority, GuardianRow } from "./guardians";
export { isValidUhid, PatientError } from "./uhid";
export type { PatientErrorCode } from "./uhid";
export * from "./events";
