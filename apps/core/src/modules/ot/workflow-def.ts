import { defineWorkflow } from "../../kernel/workflow/definition";
import type { WorkflowDefinition } from "../../kernel/workflow/definition";

/**
 * PLAN 15 T3 / DD4 — THE TWO WORKFLOW DEFINITIONS, as JSON constants in the OPD house shape.
 *
 * Both are **Class A** (`CHANGE_CLASS_POLICY.A` = `owner` + `medical_superintendent`), activated by
 * the runbook `opd_visit` used: `POST /workflow/definitions` → two approvals from two DISTINCT
 * users holding those two roles → activation by a user who is not the drafter. Spike Q3 measured
 * that production HAS those two humans (`admin` as `owner`, `anand.rao` as `medical_superintendent`),
 * so this is a runbook step and not a blocked one.
 *
 * ═══ THE STATE IS THE INSTANCE'S; THESE CONSTANTS ARE THE MATRIX ═══
 *
 * `ot_cases` and `ot_case_gates` carry `workflow_instance_id` and no status column (schema/ot.ts's
 * header). `transition()` performs the move as a single-winner conditional UPDATE, which is what
 * makes two concurrent transitions impossible without an optimistic-locking column of our own.
 *
 * ═══ WHAT `defineWorkflow` ENFORCES, AND WHY EVERY STATE HERE CARRIES AN SLA ═══
 *
 * Every NON-terminal state must carry an SLA (spec §10.3, "structure everywhere") and every
 * TERMINAL state must NOT. Every state must be reachable from `initialState` and must be able to
 * reach a terminal (§18, no dangling paths). So the `record_only` SLAs below are not decoration —
 * they are the engine's requirement, and only TWO of them alert:
 *
 *   · **`in_holding`, 45 minutes, ACTIVE, escalating to `ot_incharge`.** A patient in the holding
 *     bay is fasted, cannulated and waiting; 45 minutes is the point at which somebody should be
 *     told rather than the point at which something is wrong.
 *   · **`discharge_ready`, 120 minutes, ACTIVE.** A scored-ready patient still occupying one of two
 *     bays is the KPI of a two-bay unit — it is the state that silently halves the day's capacity.
 *
 * ═══ `listed → ready` AND `in_recovery → discharge_ready` ARE `system` MOVES ═══
 *
 * Neither is a transition a human makes. `evaluateReadiness` performs the first when every required
 * gate is terminal-satisfied; `evaluateDischargeReady` performs the second when the PACU scores
 * meet the active threshold. `transition()` skips the role check for a `system` actor
 * (instances.ts), so `roles: ["system"]` is documentation of intent — the approvals engine's own
 * flow definitions carry the same convention.
 *
 * ═══ THERE IS NO `signed_in → incision` EDGE, AND THAT IS THE MATRIX'S WHOLE JOB ═══
 *
 * The WHO time-out is not a checkbox that can be skipped under pressure; it is a STATE the case
 * must pass through. `workflow-def.test.ts` asserts the absence directly, because "we always do the
 * time-out" is exactly the kind of thing that is true until the day it is not.
 *
 * ═══ `postponed` IS NOT TERMINAL, AND `cancelled` IS ═══
 *
 * A postponed case comes BACK — a new list date, the same encounter, the same deposit (§3A: the
 * deposit stays as a liability, nothing is refunded unless asked). So `postponed → booked` exists
 * and the state carries an SLA like any other live state. A cancelled case does not come back; a
 * new booking is a new case.
 *
 * **`no_sterile_set` is a legal postponement reason today even though the sterile-set GATE is
 * 15c's** (adversarial finding F12). The set can be missing whether or not this system tracks sets,
 * and a reason code that cannot be recorded produces a postponement attributed to nothing.
 */

/** The reasons a postponement may carry. Reason codes are data on the case, not states here. */
export const POSTPONE_REASONS = [
  "no_sterile_set", "surgeon_no_show", "payer_denied", "patient_unfit", "equipment_unavailable",
] as const;

export const DAYCARE_CASE_DEF_KEY = "daycare_case";
export const OT_GATE_DEF_KEY = "ot_gate";

/** Record-only SLA — the engine's structural requirement, with no alert behind it. */
const recordOnly = (minutes: number) => ({ minutes, alerting: "record_only" as const });

export const daycareCaseDefinition: WorkflowDefinition = defineWorkflow({
  key: DAYCARE_CASE_DEF_KEY,
  title: "Day-care surgical case",
  changeClass: "A",
  initialState: "booked",
  states: [
    { name: "booked", sla: recordOnly(2880) },
    { name: "listed", sla: recordOnly(1440) },
    { name: "ready", sla: recordOnly(1440) },
    {
      name: "in_holding",
      sla: { minutes: 45, alerting: "active", escalation: [{ afterMinutes: 45, toRole: "ot_incharge" }] },
    },
    { name: "signed_in", sla: recordOnly(60) },
    { name: "timed_out", sla: recordOnly(30) },
    { name: "incision", sla: recordOnly(240) },
    { name: "closing", sla: recordOnly(60) },
    { name: "signed_out", sla: recordOnly(30) },
    { name: "in_recovery", sla: recordOnly(360) },
    { name: "discharge_ready", sla: { minutes: 120, alerting: "active" } },
    { name: "postponed", sla: recordOnly(2880) },
    { name: "discharged", terminal: true },
    { name: "cancelled", terminal: true },
    { name: "converted", terminal: true },
    { name: "absconded", terminal: true },
    { name: "deceased", terminal: true },
  ],
  transitions: [
    // ── the spine ──
    { from: "booked", to: "listed", roles: ["ot_incharge", "daycare_coordinator"] },
    { from: "listed", to: "ready", roles: ["system"] },
    { from: "ready", to: "in_holding", roles: ["ot_incharge", "ot_nurse", "daycare_coordinator"] },
    // The actor must ALSO be the case's assigned anaesthetist, or emit `anaesthetist.substituted`
    // (DD4/F18). The engine can only check a ROLE; `signIn` checks the identity.
    { from: "in_holding", to: "signed_in", roles: ["anaesthetist"] },
    { from: "signed_in", to: "timed_out", roles: ["ot_incharge", "ot_nurse"] },
    { from: "timed_out", to: "incision", roles: ["surgeon"] },
    { from: "incision", to: "closing", roles: ["surgeon"] },
    { from: "closing", to: "signed_out", roles: ["ot_incharge", "ot_nurse"] },
    { from: "signed_out", to: "in_recovery", roles: ["ot_incharge", "ot_nurse", "recovery_nurse"] },
    { from: "in_recovery", to: "discharge_ready", roles: ["system"] },
    { from: "discharge_ready", to: "discharged", roles: ["ot_incharge", "recovery_nurse"] },

    // ── cancellation: any pre-`signed_in` state, INCLUDING `in_holding` (DD4) ──
    { from: "booked", to: "cancelled", roles: ["ot_incharge", "daycare_coordinator"] },
    { from: "listed", to: "cancelled", roles: ["ot_incharge", "daycare_coordinator"] },
    { from: "ready", to: "cancelled", roles: ["ot_incharge", "daycare_coordinator"] },
    { from: "in_holding", to: "cancelled", roles: ["ot_incharge", "daycare_coordinator"] },
    { from: "postponed", to: "cancelled", roles: ["ot_incharge", "daycare_coordinator"] },

    // ── postponement, and the way back ──
    { from: "booked", to: "postponed", roles: ["ot_incharge", "daycare_coordinator"] },
    { from: "listed", to: "postponed", roles: ["ot_incharge", "daycare_coordinator"] },
    { from: "ready", to: "postponed", roles: ["ot_incharge", "daycare_coordinator"] },
    { from: "in_holding", to: "postponed", roles: ["ot_incharge", "daycare_coordinator"] },
    { from: "postponed", to: "booked", roles: ["ot_incharge", "daycare_coordinator"] },

    // ── the three recovery exits (DD10) ──
    { from: "in_recovery", to: "converted", roles: ["ot_incharge", "recovery_nurse"] },
    { from: "discharge_ready", to: "converted", roles: ["ot_incharge", "recovery_nurse"] },
    { from: "in_recovery", to: "absconded", roles: ["ot_incharge", "recovery_nurse"] },
    { from: "discharge_ready", to: "absconded", roles: ["ot_incharge", "recovery_nurse"] },

    // ── death on the table (R-3.22): reachable from sign-in to recovery, and nowhere else ──
    { from: "signed_in", to: "deceased", roles: ["ot_incharge", "surgeon", "anaesthetist"] },
    { from: "timed_out", to: "deceased", roles: ["ot_incharge", "surgeon", "anaesthetist"] },
    { from: "incision", to: "deceased", roles: ["ot_incharge", "surgeon", "anaesthetist"] },
    { from: "closing", to: "deceased", roles: ["ot_incharge", "surgeon", "anaesthetist"] },
    { from: "signed_out", to: "deceased", roles: ["ot_incharge", "surgeon", "anaesthetist"] },
    { from: "in_recovery", to: "deceased", roles: ["ot_incharge", "surgeon", "anaesthetist"] },
  ],
});

/**
 * DD5 — **A GATE IS A CHILD INSTANCE, NOT A BOOLEAN** (doc 15 §3.2), so its history is the engine's.
 *
 * All three exits are terminal, which is what makes "is this gate still open?" a question with one
 * answer. `overridden` is reachable ONLY by `surgeon` or `anaesthetist` — the two-actor override's
 * role half; `overrideGate` supplies the rest (two DISTINCT ids, both role-checked, refused outright
 * for `escort` and refused for `deposit` without a granted exception).
 */
export const otGateDefinition: WorkflowDefinition = defineWorkflow({
  key: OT_GATE_DEF_KEY,
  title: "Day-care pre-operative gate",
  changeClass: "A",
  initialState: "open",
  states: [
    { name: "open", sla: recordOnly(1440) },
    { name: "satisfied", terminal: true },
    { name: "waived", terminal: true },
    { name: "overridden", terminal: true },
  ],
  transitions: [
    {
      from: "open",
      to: "satisfied",
      roles: ["ot_incharge", "daycare_coordinator", "surgeon", "anaesthetist", "ot_nurse", "recovery_nurse"],
    },
    // Only the kinds the criteria definition marks `waivable` (DD5) — `waiveGate` enforces that.
    { from: "open", to: "waived", roles: ["ot_incharge", "daycare_coordinator"] },
    // The two-actor clinical lane, and no other role can reach this state at all.
    { from: "open", to: "overridden", roles: ["surgeon", "anaesthetist"] },
  ],
});

/** Both definitions, for the seed and the runbook to install from one list. */
export const OT_WORKFLOW_DEFINITIONS: readonly WorkflowDefinition[] = [
  daycareCaseDefinition, otGateDefinition,
];
