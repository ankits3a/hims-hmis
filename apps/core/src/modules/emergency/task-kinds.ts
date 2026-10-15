import { defineSkill, defineTaskKind } from "../tasks";

/**
 * ER lane 2 (#809) — the overdue re-triage as a TASK (spec §0: a breached clock is a task with an owner, never a colour
 * alone). Defined at import time by `index.ts`, which both the API and the worker import (the task clock needs the kind).
 *
 * - skill `er_triage` → the casualty nurse role (`er_nurse`): the pool the task engine dispatches to;
 * - due at the re-triage instant, so it is late at once: the engine's single rung tells the casualty nurses' bell;
 * - the CLIMB past them (15 min after the due instant) is the emergency module's own, through the roster ladder
 *   (`escalationRecipients("er_retriage")`), raised once per due instant by `sweepErTriageClocks`;
 * - closed by the act it asks for: a re-triage, the doctor seeing the patient, or the patient leaving cancel it.
 */
export const ER_RETRIAGE_TASK = "er_retriage";
/** #832 review — door-to-triage (≤ 5 min from the gate, spec §3.2) breached: the same skill, the same ladder. */
export const ER_TRIAGE_DUE_TASK = "er_triage_due";
export const ER_TRIAGE_SKILL = "er_triage";

defineSkill(ER_TRIAGE_SKILL, ["er_nurse"]);
defineTaskKind({
  kind: ER_RETRIAGE_TASK, label: "ER re-triage due", skill: ER_TRIAGE_SKILL,
  acceptWithinMin: 5, doneWithinMin: 15, escalateTo: "er_nurse",
  proofNeeded: "none", verifyRequired: false, ladderMin: [0],
});
defineTaskKind({
  kind: ER_TRIAGE_DUE_TASK, label: "ER triage overdue", skill: ER_TRIAGE_SKILL,
  acceptWithinMin: 2, doneWithinMin: 5, escalateTo: "er_nurse",
  proofNeeded: "none", verifyRequired: false, ladderMin: [0],
});

/**
 * ER lane 4 (#811) — an MLC's police intimation not recorded by its 1-hour target (spec §3.7) becomes a TASK for the
 * people who write it (the ER desk and the casualty nurse), stat, due at the target; 30 minutes past the target it climbs
 * once through the roster ladder (`mlc_intimation`, fallback the duty manager). Recording the intimation cancels it.
 */
export const ER_MLC_INTIMATION_TASK = "er_mlc_intimation";
export const ER_MLC_SKILL = "er_mlc";

defineSkill(ER_MLC_SKILL, ["front_office", "er_nurse"]);
defineTaskKind({
  kind: ER_MLC_INTIMATION_TASK, label: "MLC police intimation due", skill: ER_MLC_SKILL,
  acceptWithinMin: 5, doneWithinMin: 30, escalateTo: "duty_manager",
  proofNeeded: "none", verifyRequired: false, ladderMin: [0],
});
