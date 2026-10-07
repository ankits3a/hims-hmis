import { z } from "zod";

/**
 * ═══ THE GUARDIAN CAME WITH THE REPORTS (owner 2026-10-07) ═══
 *
 * *"When the patient's guardian comes with the report of the patient as a revisit patient, add an
 * option to skip the vitals taking process, as the patient didn't come — his guardian came to show
 * the report to the doctor."*
 *
 * `POST /opd/visits/:encounterId/patient-absent` takes this body; the server decides everything
 * else (a returning patient only, still waiting for vitals, the fee door unchanged — `opd/patient-absent.ts`).
 * Owner 2026-10-07: a RENEWAL may send a guardian too; the fee follows the visit type, and an unpaid
 * visit is refused at the fee door ("take the fee at the counter first").
 * The web bay, Desk One and the doctor's screens read the same list and the same wire shape.
 */
export const GUARDIAN_RELATIONS = [
  "father", "mother", "spouse", "son", "daughter", "brother", "sister", "other_relative", "attendant",
] as const;
export type GuardianRelation = (typeof GUARDIAN_RELATIONS)[number];

/** The visit rule lives in a dependency-free file the phone app can import (see its header). */
export { PATIENT_ABSENT_VISIT_TYPES, guardianMayStandIn } from "./patient-absent-rule";

/** The longest guardian name the desk may type. Trimmed first; blank means "not given". */
export const GUARDIAN_NAME_MAX = 80;

export const patientAbsentBody = z.object({
  relation: z.enum(GUARDIAN_RELATIONS),
  name: z.string().max(200).nullable().optional(), // trimmed and bounded to GUARDIAN_NAME_MAX by the service, with its code
});
export type PatientAbsentBody = z.infer<typeof patientAbsentBody>;

/** What every read model that shows a visit carries: null on a visit the patient came to. */
export type WirePatientAbsent = {
  relation: GuardianRelation;
  name: string | null;
  /** The user id that marked it. */
  by: string;
  /** ISO instant. */
  at: string;
};
