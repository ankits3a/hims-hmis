import type { Actor } from "@hmis/contracts";

/** The module's names, in one leaf file so the manifest, the kinds and the intents import no cycle. */
export const TRANSPORT_REQUEST = "transport.request";
export const TRANSPORT_WORK = "transport.work";
export const TRANSPORT_MANAGE = "transport.manage";
/** Who acts when an IPD lane asks for a move on the hospital's behalf. */
export const TRANSPORT_ACTOR: Actor = { type: "system", id: "transport" };

/**
 * Who may ESCORT a patient: a nurse or a doctor. DECIDED (spec §6, standard Indian corporate-hospital practice):
 * every clinical role this tree seeds or plans — the doctor roles and the nursing roles. `ward_nurse`,
 * `nursing_supervisor` and `resident` are the IPD roles the nursing lane brings (admission-workflow.ts); naming them
 * now lets their holders escort the day they exist.
 */
export const ESCORT_ROLE_KEYS: readonly string[] = [
  "doctor", "surgeon", "anaesthetist", "radiology_resident", "resident",
  "nurse", "ward_nurse", "nursing_supervisor", "ot_nurse", "recovery_nurse", "radiology_nurse",
];
