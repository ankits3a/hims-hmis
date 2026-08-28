import { getPatient } from "../patients";
import { getEncounter } from "./encounters";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 07a T1 — THE READ GATE for encounter-scoped OPD reads.
 *
 * `listVitals` and `listPrescriptions` took an encounter id and NO actor at all, behind
 * `opd.visits.read` alone — a permission `front_office` holds. The confidential flag therefore hid
 * a sealed patient's demographics (`getPatient` existence-hides them) while leaving their vitals
 * and prescriptions readable to the same clerk. `patientTimeline` had the matching hole on the
 * patient-scoped side and is fixed in `encounters.ts` by swapping `resolvePatientId` — whose own
 * docstring says "no gate" — for `getPatient`.
 *
 * ═══ ONE DECISION, IN ONE PLACE ═══
 *
 * The confidentiality decision is `getPatient`'s and is not re-implemented here. That is the whole
 * point: Plan 11h's close fixed this same class in the search lane by routing the chip path through
 * the gate the text path already used, and a second copy of the rule is a second thing to get
 * wrong. This helper only answers "may this actor see the patient behind this encounter".
 *
 * ═══ THE ANSWER FOR A SEALED PATIENT IS THE ANSWER FOR AN ABSENT ONE ═══
 *
 * `false` here, and callers return the SAME empty result they already return for an encounter id
 * that does not exist (07a DD2). A distinct refusal would confirm the patient exists to a caller
 * who may not know that, which is the leak wearing a fix's clothes.
 */
export async function encounterVisibleTo(db: Db, actor: Actor, encounterId: string): Promise<boolean> {
  const encounter = await getEncounter(db, encounterId);
  if (!encounter) return false;
  return (await getPatient(db, actor, encounter.patientId)) !== null;
}
