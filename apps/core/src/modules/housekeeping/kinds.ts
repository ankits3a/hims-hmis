import { eq } from "drizzle-orm";
import { HK_ROUND_GRACE_MIN, HOUSEKEEPING_KINDS, HOUSEKEEPING_TARGET_MIN } from "@hmis/contracts";
import { resources } from "../../kernel/db/schema";
import { IPD_BEDS_CLEAN, markBedCleanIn } from "../ipd";
import { bedReadyGate } from "../linen";
import { SERVICES_SUPERVISOR_ROLE, SUPPORT_STAFF_ROLE, defineSkill, defineTaskKind } from "../tasks";
import { HOUSEKEEPING_CONFIRM, HOUSEKEEPING_SKILL, HOUSEKEEPING_VERIFY_TERMINAL } from "./names";
import { hkEligible, hkPoolOnly } from "./rota";
import { hkBeforeDone } from "./work";
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
 * HK-1 (#973, decision 0086): every kind the attendants work carries the rota's eligibility (`hkEligible`) and the proof
 * of work (`hkBeforeDone`: a task inside an area finishes only through the scan, checklist and photo); the two bed kinds
 * wait in the floor team's pool while a rota is published (`hkPoolOnly`); `housekeeping.confirm` joins the routine
 * clean's checkers. Three kinds are added: an area's round (checked for classes A and B), and a request at an area.
 */
const WORKED = { eligible: hkEligible, beforeDone: hkBeforeDone } as const;
export { HOUSEKEEPING_SKILL };
export const HOUSEKEEPING_ROUND_SKILL = "housekeeping_round";
defineSkill(HOUSEKEEPING_SKILL, [SUPPORT_STAFF_ROLE]);
defineSkill(HOUSEKEEPING_ROUND_SKILL, [SERVICES_SUPERVISOR_ROLE]);

/**
 * A passed check frees the bed, in the verification's own transaction (ipd's housekeeping seam). A bed that is no
 * longer in cleaning (marked clean by hand at the board, blocked, re-occupied) is left alone: the check still
 * closes the task, and the bed's later state is not overwritten.
 * LD-1 (#978, D3): a bed is ready when it is cleaned AND made. Linen's gate keeps it in cleaning, "waiting for linen",
 * when its ward's shelf is short of a set; the top-up that fills the shelf frees it.
 */
async function bedCleanVerified(tx: Tx, task: TaskRow, actor: Actor, now: Date): Promise<void> {
  if (task.placeResourceId === null) return;
  const bed = (await tx.select({ status: resources.status }).from(resources).where(eq(resources.id, task.placeResourceId)))[0];
  if (bed?.status !== "cleaning") return;
  if (!(await bedReadyGate(tx, actor, task.placeResourceId, now)).ready) return;
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
  verifierPermission: [IPD_BEDS_CLEAN, HOUSEKEEPING_CONFIRM, HOUSEKEEPING_VERIFY_TERMINAL],
  onVerified: bedCleanVerified,
  ...WORKED,
  poolOnly: hkPoolOnly,
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
  ...WORKED,
  poolOnly: hkPoolOnly,
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
  ...WORKED,
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

/** HK-1 — an area's scheduled round, not checked per round (toilets, public areas, support areas). */
export const AREA_ROUND = defineTaskKind({
  kind: HOUSEKEEPING_KINDS.round,
  label: "Area round",
  skill: HOUSEKEEPING_SKILL,
  acceptWithinMin: 10,
  doneWithinMin: 60,
  escalateTo: SERVICES_SUPERVISOR_ROLE,
  proofNeeded: "scan",
  verifyRequired: false,
  // One rung, at the grace: the moment the round is missed, the supervisor is told (plan: keep the ladder short).
  ladderMin: [HK_ROUND_GRACE_MIN],
  ...WORKED,
});

/** HK-1 — a class A or B area's round: the unit side checks it (Pass or Fail). */
export const AREA_ROUND_CHECKED = defineTaskKind({
  kind: HOUSEKEEPING_KINDS.roundChecked,
  label: "Area round (checked)",
  skill: HOUSEKEEPING_SKILL,
  acceptWithinMin: 10,
  doneWithinMin: 60,
  escalateTo: SERVICES_SUPERVISOR_ROLE,
  proofNeeded: "scan",
  verifyRequired: true,
  verifierPermission: [IPD_BEDS_CLEAN, HOUSEKEEPING_CONFIRM, HOUSEKEEPING_VERIFY_TERMINAL],
  ladderMin: [HK_ROUND_GRACE_MIN],
  ...WORKED,
});

/** HK-1 — clean, toilet or bin asked for at an area, by staff or from the door QR. */
export const AREA_REQUEST = defineTaskKind({
  kind: HOUSEKEEPING_KINDS.request,
  label: "Request",
  skill: HOUSEKEEPING_SKILL,
  acceptWithinMin: 5,
  doneWithinMin: 30,
  escalateTo: SERVICES_SUPERVISOR_ROLE,
  proofNeeded: "scan",
  verifyRequired: false,
  ladderMin: [0, 15],
  ...WORKED,
});

/**
 * HK-2 (#974) — the rework a failed random inspection raises at the area: the floor team's pool while a rota is
 * published, proved like any worked task (scan, checklist, photo), then checked by the supervisor — HK-1's fail path, so
 * a failed check reopens it and a second fail puts it in "Needs you".
 */
export const AREA_REWORK = defineTaskKind({
  kind: HOUSEKEEPING_KINDS.rework,
  label: "Rework after inspection",
  skill: HOUSEKEEPING_SKILL,
  acceptWithinMin: 10,
  doneWithinMin: 60,
  escalateTo: SERVICES_SUPERVISOR_ROLE,
  proofNeeded: "scan",
  verifyRequired: true,
  verifierPermission: [HOUSEKEEPING_CONFIRM, HOUSEKEEPING_VERIFY_TERMINAL],
  ladderMin: [0, 30],
  ...WORKED,
  poolOnly: hkPoolOnly,
});
