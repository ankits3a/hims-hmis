export { PatientError } from "./uhid";
export type { PatientErrorCode } from "./uhid";

export type Sex = "male" | "female" | "other" | "unknown";
export type PatientLanguage = "hi" | "en";
export type BloodGroup = "A+" | "A-" | "B+" | "B-" | "AB+" | "AB-" | "O+" | "O-";
export type GuardianRelationship = "father" | "mother" | "spouse" | "sibling" | "legal_guardian" | "other";
export type AbhaVerificationStatus = "none" | "self_declared" | "verified";

export const MAJORITY_AGE_YEARS = 18;

/** Whole years between dob and now, UTC, anniversary-aware (Feb-29 birthdays normalize to Mar 1). */
export function yearsBetween(dob: Date, now: Date): number {
  const years = now.getUTCFullYear() - dob.getUTCFullYear();
  const anniversaryNotReached =
    now.getUTCMonth() < dob.getUTCMonth() ||
    (now.getUTCMonth() === dob.getUTCMonth() && now.getUTCDate() < dob.getUTCDate());
  return anniversaryNotReached ? years - 1 : years;
}
