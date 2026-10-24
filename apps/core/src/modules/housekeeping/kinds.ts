import { eq } from "drizzle-orm";
import { HOUSEKEEPING_KINDS, HOUSEKEEPING_TARGET_MIN } from "@hmis/contracts";
import { resources } from "../../kernel/db/schema";
import { IPD_BEDS_CLEAN, markBedCleanIn } from "../ipd";
import { SERVICES_SUPERVISOR_ROLE, SUPPORT_STAFF_ROLE, defineSkill, defineTaskKind } from "../tasks";
import { HOUSEKEEPING_VERIFY_TERMINAL } from "./names";
import type { Actor } from "@hmis/contracts";
import type { Tx } from "../../kernel/db/client";
import type { TaskRow } from "../tasks";

/**
 * HOUSEKEEPING'S TASK KINDS, defined at import time (the API imports this module for its routes, the worker for its
 * subscription — both must, tasks MAP §4). DECIDED by the standard Indian corporate-hospital (NABH housekeeping and
 * infection-control) practice:
 *   · the cleaning skill is the existing `support_staff` role (ward attendants and housekeeping staff), so no new
 *     role is minted; a room inspection is the services supervisor's own round;
 *   · every kind escalates to `services_supervisor` (the housekeeping supervisor);
 *   · proof is a tap today (the photo arrives with document capture); a bed clean is CHECKED before the bed is free.
 */
export const HOUSEKEEPING_SKILL = "housekeeping";
export const HOUSEKEEPING_ROUND_SKILL = "housekeeping_round";
defineSkill(HOUSEKEEPING_SKILL, [SUPPORT_STAFF_ROLE]);
defineSkill(HOUSEKEEPING_ROUND_SKILL, [SERVICES_SUPERVISOR_ROLE]);

/**
 * A passed check frees the bed, in the verification's own transaction (ipd's housekeeping seam). A bed that is no
 * longer in cleaning (marked clean by hand at the board, blocked, re-occupied) is left alone: the check still
 * closes the task, and the bed's later state is not overwritten.
 */
async function bedCleanVerified(tx: Tx, task: TaskRow, actor: Actor, now: Date): Promise<void> {
  if (task.placeResourceId === null) return;
  const bed = (await tx.select({ status: resources.status }).from(resources).where(eq(resources.id, task.placeResourceId)))[0];
  if (bed?.status !== "cleaning") return;
  await markBedCleanIn(tx, actor, task.placeResourceId, now);
}

export const BED_CLEAN_ROUTINE = defineTaskKind({
  kind: HOUSEKEEPING_KINDS.routine,
  label: "Bed clean",
  skill: HOUSEKEEPING_SKILL,
  acceptWithinMin: 5,
  doneWithinMin: HOUSEKEEPING_TARGET_MIN.routine,
  escalateTo: SERVICES_SUPERVISOR_ROLE,
  proofNeeded: "tap",
  verifyRequired: true,
  // DECIDED (brief §5): the ward nurse side (holders of `ipd.beds.clean`) or the housekeeping supervisor.
  verifierPermission: [IPD_BEDS_CLEAN, HOUSEKEEPING_VERIFY_TERMINAL],
  onVerified: bedCleanVerified,
});

export const BED_CLEAN_TERMINAL = defineTaskKind({
  kind: HOUSEKEEPING_KINDS.terminal,
  label: "Terminal clean",
  skill: HOUSEKEEPING_SKILL,
  acceptWithinMin: 5,
  doneWithinMin: HOUSEKEEPING_TARGET_MIN.terminal,
  escalateTo: SERVICES_SUPERVISOR_ROLE,
  proofNeeded: "tap",
  verifyRequired: true,
  // Infection control: the housekeeping supervisor alone.
  verifierPermission: [HOUSEKEEPING_VERIFY_TERMINAL],
  onVerified: bedCleanVerified,
});

export const SPILL = defineTaskKind({
  kind: HOUSEKEEPING_KINDS.spill,
  label: "Spill clean",
  skill: HOUSEKEEPING_SKILL,
  acceptWithinMin: 3,
  doneWithinMin: HOUSEKEEPING_TARGET_MIN.spill,
  escalateTo: SERVICES_SUPERVISOR_ROLE,
  proofNeeded: "tap",
  verifyRequired: false,
  ladderMin: [0, 10],
});

export const ROOM_INSPECTION = defineTaskKind({
  kind: HOUSEKEEPING_KINDS.inspection,
  label: "Room inspection",
  skill: HOUSEKEEPING_ROUND_SKILL,
  acceptWithinMin: 30,
  doneWithinMin: 240,
  escalateTo: SERVICES_SUPERVISOR_ROLE,
  proofNeeded: "tap",
  verifyRequired: false,
});
