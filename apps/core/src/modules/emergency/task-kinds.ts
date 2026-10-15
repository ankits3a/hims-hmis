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
export const ER_TRIAGE_SKILL = "er_triage";

defineSkill(ER_TRIAGE_SKILL, ["er_nurse"]);
defineTaskKind({
  kind: ER_RETRIAGE_TASK, label: "ER re-triage due", skill: ER_TRIAGE_SKILL,
  acceptWithinMin: 5, doneWithinMin: 15, escalateTo: "er_nurse",
  proofNeeded: "none", verifyRequired: false, ladderMin: [0],
});
