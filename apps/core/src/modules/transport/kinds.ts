import { TRANSPORT_KINDS, TRANSPORT_TARGET_MIN } from "@hmis/contracts";
import { SERVICES_SUPERVISOR_ROLE, SUPPORT_STAFF_ROLE, defineSkill, defineTaskKind } from "../tasks";
import { patientMoveHandover, patientMoveMayStart } from "./guards";

/**
 * TRANSPORT'S TASK KINDS, defined at import time — the API imports this module for its routes, the worker imports it
 * so the task clock knows the windows and the escalation role (tasks MAP §4). DECIDED by the standard Indian
 * corporate-hospital practice:
 *   · the porter skill is the existing `support_staff` role (ward boys, attendants and porters are one cadre in most
 *     Indian hospitals), so no new role is minted; a hospital with a porter pool rosters them as support staff;
 *   · every kind escalates to `services_supervisor` (the transport / services supervisor);
 *   · a patient move is proven by the wristband SCAN at the destination; a sample or document run by a tap;
 *   · nothing is verified after the fact — the handover scan IS the check.
 */
export const PORTER_SKILL = "porter";
defineSkill(PORTER_SKILL, [SUPPORT_STAFF_ROLE]);

export const PATIENT_MOVE = defineTaskKind({
  kind: TRANSPORT_KINDS.patientMove,
  label: "Patient move",
  skill: PORTER_SKILL,
  acceptWithinMin: TRANSPORT_TARGET_MIN.moveAccept,
  doneWithinMin: TRANSPORT_TARGET_MIN.moveDone,
  escalateTo: SERVICES_SUPERVISOR_ROLE,
  proofNeeded: "scan",
  verifyRequired: false,
  ladderMin: [0, 15],
  beforeStart: patientMoveMayStart,
  beforeDone: patientMoveHandover,
});

export const SAMPLE_RUN = defineTaskKind({
  kind: TRANSPORT_KINDS.sampleRun,
  label: "Sample run",
  skill: PORTER_SKILL,
  acceptWithinMin: TRANSPORT_TARGET_MIN.runAccept,
  doneWithinMin: TRANSPORT_TARGET_MIN.runDone,
  escalateTo: SERVICES_SUPERVISOR_ROLE,
  proofNeeded: "tap",
  verifyRequired: false,
});

export const DOCUMENT_RUN = defineTaskKind({
  kind: TRANSPORT_KINDS.documentRun,
  label: "Document run",
  skill: PORTER_SKILL,
  acceptWithinMin: TRANSPORT_TARGET_MIN.runAccept,
  doneWithinMin: TRANSPORT_TARGET_MIN.runDone,
  escalateTo: SERVICES_SUPERVISOR_ROLE,
  proofNeeded: "tap",
  verifyRequired: false,
});
