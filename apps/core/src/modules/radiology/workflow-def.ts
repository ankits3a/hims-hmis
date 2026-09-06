import { defineWorkflow } from "../../kernel/workflow/definition";
import type { WorkflowDefinition } from "../../kernel/workflow/definition";

/**
 * PLAN 18a T2 / DD7 — THE TWO WORKFLOW DEFINITIONS, as JSON constants in the OPD/OT house shape.
 *
 * Both are **Class A** (`CHANGE_CLASS_POLICY.A` = `owner` + `medical_superintendent`), activated by
 * the runbook `opd_visit` and `daycare_case` used: `POST /workflow/definitions` → two approvals from
 * two DISTINCT users holding those two roles → activation by a user who is not the drafter.
 *
 * ═══ THE STATE IS THE INSTANCE'S; `imaging_studies.status` IS ITS INDEXABLE PROJECTION ═══
 *
 * This differs by one word from the OT, and the difference is deliberate rather than sloppy.
 * `ot_cases` carries `workflow_instance_id` and NO status column. `imaging_studies` carries both,
 * because the radiologist's worklist is *"every unread stat study, oldest first"* across the whole
 * hospital — a query that would otherwise join `workflow_instances` once per row, on the screen a
 * technologist refreshes all day. The column is written only by the same functions that call
 * `transition()`, in the same transaction, and `read.ts` never writes it.
 *
 * ═══ WHY EVERY NON-TERMINAL STATE CARRIES AN SLA ═══
 *
 * `defineWorkflow` requires it (spec §10.3): every non-terminal state must carry an SLA, every
 * terminal state must not, every state must be reachable from `initialState` and must be able to
 * reach a terminal (§18, no dangling paths). So the `record_only` SLAs below are the engine's
 * requirement rather than decoration — **and in this slice NONE of them alerts.**
 *
 * That is DD7's ruling and §1.3's line: the unread-study and critical-acknowledgement escalation
 * ladder is 18a-iii's, and an `alerting: "active"` state here would page a human through a channel
 * this phase has not built. Plan 15's `recordOnly` pattern, used for the same reason: **record the
 * clock now so the phase that builds the ladder has history to tune it against.**
 */

export const IMAGING_STUDY_DEF_KEY = "imaging_study";
export const IMAGING_GATE_DEF_KEY = "imaging_gate";

/** Record-only SLA — the engine's structural requirement, with no alert behind it (§1.3). */
const recordOnly = (minutes: number) => ({ minutes, alerting: "record_only" as const });

/**
 * THE STUDY'S ARC. Seven live states and three terminals, and the two that project onto the
 * ENVELOPE are named in DD4: `in_acquisition` is where `advanceOrderItem(… 'in_progress')` fires
 * (the patient is on the table), `published` is where `'completed'` does (a signed report is
 * visible in the app).
 *
 * **`checked_in` and `ready` are two states rather than one**, and B7 is why: a patient can be
 * physically present with an open gate — the creatinine has not come back — and the two facts must
 * be distinguishable on a worklist, because one of them is the technologist's problem and the other
 * is the lab's. `evaluateReadiness` is the only thing that moves `checked_in → ready`, which is why
 * that transition is the `system`'s.
 */
export const imagingStudyDefinition: WorkflowDefinition = defineWorkflow({
  key: IMAGING_STUDY_DEF_KEY,
  title: "Imaging study",
  changeClass: "A",
  initialState: "scheduled",
  states: [
    { name: "scheduled", sla: recordOnly(2880) },
    { name: "checked_in", sla: recordOnly(240) },
    { name: "ready", sla: recordOnly(120) },
    { name: "in_acquisition", sla: recordOnly(120) },
    { name: "acquired", sla: recordOnly(1440) },
    // The unread window. 18a-iii turns this SLA active and hangs the Unread Watchman off it.
    { name: "reported", sla: recordOnly(1440) },
    { name: "published", terminal: true },
    { name: "cancelled", terminal: true },
    { name: "no_show", terminal: true },
    { name: "rescheduled", terminal: true },
  ],
  transitions: [
    // ── the spine ──
    { from: "scheduled", to: "checked_in", roles: ["radiographer", "radiology_receptionist"] },
    // `evaluateReadiness` alone: every opened gate terminal and not open (T5 A6).
    { from: "checked_in", to: "ready", roles: ["system"] },
    { from: "ready", to: "in_acquisition", roles: ["radiographer", "radiologist"] },
    { from: "in_acquisition", to: "acquired", roles: ["radiographer", "radiologist"] },
    /**
     * ═══ 18a-iii T4 / D5 — THE OUTSIDE STUDY'S ONE EDGE, AND WHY IT IS DECLARED RATHER THAN FAKED ═══
     *
     * A film from another centre has no check-in, no gate set, no machine and no exposure. The only
     * route to a reportable state was `scheduled → checked_in → ready → in_acquisition → acquired`,
     * and walking a study through four states that did not happen would put a journey in the audit
     * log that no human performed — and, worse, would reach `recordAcquired`, which for an ionising
     * study type DEMANDS a dose and WRITES the AERB radiation dose register. That would attribute
     * **another hospital's exposure to our machine, in the register an inspector reads.**
     *
     * So the arc gains one honest edge that says what it is, rather than hiding the same act behind
     * four fictional hops. `registerOutsideStudy` is its only caller — `outside.test.ts` pins that
     * by grep, the `stock_ledger` append-only idiom — and that function refuses any study carrying a
     * device, a slot or an acquisition start, writes the provenance row in the same transaction, and
     * records no dose at all.
     *
     * The roles are the desk's and the radiologist's, NOT the radiographer's: registering somebody
     * else's film is a reception act, and the technologist's permission is for the machine.
     */
    { from: "scheduled", to: "acquired", roles: ["radiology_receptionist", "radiologist"] },
    { from: "acquired", to: "reported", roles: ["radiologist"] },
    { from: "reported", to: "published", roles: ["radiologist", "system"] },

    /**
     * ── the way back out of acquisition, and it is NOT a cancel ──
     * `abortAcquisition` (T7): the patient could not tolerate the scan, the machine faulted
     * mid-series. The study returns to `ready` and keeps its slot, its accession and its gates.
     */
    { from: "in_acquisition", to: "ready", roles: ["radiographer", "radiologist"] },

    // ── cancellation, from every pre-acquisition state (T4) ──
    { from: "scheduled", to: "cancelled", roles: ["radiology_receptionist", "radiologist", "doctor"] },
    { from: "checked_in", to: "cancelled", roles: ["radiology_receptionist", "radiologist", "doctor"] },
    { from: "ready", to: "cancelled", roles: ["radiology_receptionist", "radiologist", "doctor"] },
    // B6 — cancelled while on the table. `cancelStudy` requires a REASON from here, and raises a
    // `performed_then_cancelled` bill decision when `acquired_at` is already set.
    { from: "in_acquisition", to: "cancelled", roles: ["radiologist", "radiographer"] },

    // ── the two the reception drives ──
    { from: "scheduled", to: "no_show", roles: ["radiology_receptionist", "radiographer"] },
    { from: "checked_in", to: "no_show", roles: ["radiology_receptionist", "radiographer"] },
    // A reschedule CLOSES this row and opens a new one (DD5): two rows answer "when was this
    // moved, and off what slot", where one rewritten `scheduled_at` answers neither.
    { from: "scheduled", to: "rescheduled", roles: ["radiology_receptionist"] },
    { from: "checked_in", to: "rescheduled", roles: ["radiology_receptionist"] },
  ],
});

/**
 * THE GATE. `ot_gate`'s shape transcribed, with the same three terminal exits — and one difference
 * that is the whole of N2.
 *
 * **`form_f` reaches `waived` and `overridden` through NO code path.** The transitions below exist
 * for the other nine kinds; `waiveGate` and `overrideGate` refuse the `form_f` kind BEFORE they
 * consult any definition, any role or any gate row (T5 A2). Expressing the statutory rule as an
 * absent transition would not be enough: a definition is DATA, republishable by a human, and the
 * one thing the Act does not permit is a bypass that a row could switch on.
 *
 * The override lane is the RADIOLOGIST's alone and needs no second actor, which is where this
 * differs from the OT's two-actor form (DD7): the technologist raised the gate, and the radiologist
 * IS the second clinical opinion on it. `overrideGate` still demands a non-empty reason (T5 A3),
 * because P1's *"benefit outweighs risk"* is a judgement somebody must be willing to write down.
 */
export const imagingGateDefinition: WorkflowDefinition = defineWorkflow({
  key: IMAGING_GATE_DEF_KEY,
  title: "Imaging safety gate",
  changeClass: "A",
  initialState: "open",
  states: [
    { name: "open", sla: recordOnly(1440) },
    { name: "satisfied", terminal: true },
    { name: "waived", terminal: true },
    { name: "overridden", terminal: true },
  ],
  transitions: [
    /**
     * ═══ FINDING F9 — `radiology_receptionist` IS NOT ON THIS EDGE, AND WAS ═══
     *
     * `997ab18` shipped this transition naming the receptionist, in the same commit whose
     * `manifest.ts` states the opposite in as many words: *"The person who books the scan and takes
     * the money does not get to record that the patient is not pregnant."* §5 T2 says it again as
     * the first of three separations the reviewer checks. The two files disagreed and nothing
     * caught it, because neither had a test — the handoff's §3 "treat them as WRITTEN" case,
     * arriving exactly where it said it would.
     *
     * **The seed could not have caught this, and that is the point.** T2 A3 asserts the separation
     * on the PERMISSION registry (`radiology_receptionist` does not hold `radiology.gates.satisfy`),
     * but `advanceInstance` (`kernel/workflow/instances.ts:115`) gates a transition on
     * `actorHoldsAnyRole` against `role_assignments` and consults NO permission at any point. That
     * is Plan 17b's F39 seen from the other side: two enforcement planes, and a separation stated
     * only on the plane that is not consulted is not a separation at all. A receptionist holding
     * the role key would have driven `pregnancy_screen` to `satisfied` with every census green.
     *
     * **One definition covers every gate KIND**, so there is no per-kind role list to retreat to: a
     * role named here can satisfy `pregnancy_screen`, `mri_safety` and `form_f` alike. An
     * administrative gate the receptionist legitimately clears is not expressible on this edge, and
     * the safe direction when it cannot be expressed is to leave the role off.
     *
     * `doctor` stays: the referring clinician takes contrast consent and answers the renal
     * question. `radiologist` stays — T5 A5 requires it (`prior_contrast_reaction` is satisfiable
     * only with a radiologist's reason).
     */
    {
      from: "open",
      to: "satisfied",
      roles: ["radiographer", "radiologist", "doctor", "system"],
    },
    // Only the kinds the active `study_types` body marks `waivable` — `waiveGate` enforces that,
    // and `identity_two_factor` and `form_f` are never among them (T5 A6, T5 A2).
    { from: "open", to: "waived", roles: ["radiologist"] },
    // P1. The radiologist alone, with a reason, and never for `form_f`.
    { from: "open", to: "overridden", roles: ["radiologist"] },
  ],
});

/** Both definitions, for the seed and the runbook to install from one list. */
export const RADIOLOGY_WORKFLOW_DEFINITIONS: readonly WorkflowDefinition[] = [
  imagingStudyDefinition, imagingGateDefinition,
];
