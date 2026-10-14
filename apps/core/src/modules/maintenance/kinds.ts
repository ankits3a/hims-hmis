import { MAINTENANCE_KINDS, MAINTENANCE_RETURN_HOURS } from "@hmis/contracts";
import { IPD_BEDS_CLEAN } from "../ipd";
import { SERVICES_SUPERVISOR_ROLE, defineSkill, defineTaskKind } from "../tasks";
import { BIOMEDICAL_ENGINEER_ROLE, MAINTENANCE_CONFIRM, MAINTENANCE_STAFF_ROLE } from "./names";
import { ticketsClosedIn, ticketsFixedIn } from "./hooks";

/**
 * MAINTENANCE'S TASK KINDS, defined at import time (the API imports this module for its routes, the worker for the
 * task clock's windows and escalation role — tasks MAP §4). DECIDED by the standard Indian corporate-hospital
 * split between the ENGINEERING department (electrical, plumbing, HVAC, carpentry — `maintenance_staff`, a new
 * role) and BIOMEDICAL ENGINEERING (patient equipment — the existing `biomedical_engineer` role):
 *   · the technician's DONE marks the ticket fixed (`onDone`); the CHECK is the nurse's confirmation — a holder of
 *     `ipd.beds.clean` (the ward side) or `maintenance.confirm` — and closes the ticket and, for a bed, ends its
 *     block in the same transaction (`onVerified`); after maintenance the beds rule sends the bed to cleaning;
 *   · both kinds escalate to `services_supervisor`; proof is a tap today (the photo arrives with document capture);
 *   · the done window is the routine SLA; each ticket passes its own due time from its urgency.
 */
export const MAINTENANCE_SKILL = "maintenance";
export const BIOMEDICAL_SKILL = "biomedical";
defineSkill(MAINTENANCE_SKILL, [MAINTENANCE_STAFF_ROLE]);
defineSkill(BIOMEDICAL_SKILL, [BIOMEDICAL_ENGINEER_ROLE]);

const common = {
  acceptWithinMin: 10,
  doneWithinMin: MAINTENANCE_RETURN_HOURS.routine * 60,
  escalateTo: SERVICES_SUPERVISOR_ROLE,
  proofNeeded: "tap",
  verifyRequired: true,
  verifierPermission: [IPD_BEDS_CLEAN, MAINTENANCE_CONFIRM],
  onDone: ticketsFixedIn,
  onVerified: ticketsClosedIn,
} as const;

export const REPAIR_GENERAL = defineTaskKind({
  ...common, kind: MAINTENANCE_KINDS.general, label: "Repair", skill: MAINTENANCE_SKILL,
});

export const REPAIR_BIOMEDICAL = defineTaskKind({
  ...common, kind: MAINTENANCE_KINDS.biomedical, label: "Equipment repair", skill: BIOMEDICAL_SKILL,
});
