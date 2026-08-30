import { defineWorkflow } from "../../kernel/workflow/definition";
import type { WorkflowDefinition } from "../../kernel/workflow/definition";

/**
 * PLAN 17a T4 / DD4 — THE TWO LAB STATE MACHINES, AS WORKFLOW-DEFINITION DATA.
 *
 * ═══ WHY TWO, AND WHY THE ENVELOPE'S FOUR ARE NOT ENOUGH ═══
 *
 * `order_items.status` carries the envelope's four words — `pending`, `in_progress`, `completed`,
 * `cancelled` — and DD4 keeps them: they are what a WARD reads, and a ward has no business knowing
 * whether a tube is centrifuged. The lab's own eleven stages live here, and the two are joined at
 * exactly THREE projection points (DD4). **This phase owns the first**: `accessioned` on the item
 * projects `in_progress` on the envelope, at `receive`, which is also where the TAT clock starts.
 *
 * The SPECIMEN needs its own machine because a tube is not a test: one tube serves several items
 * and one item is served by several tubes over its life (a haemolysed draw is rejected and redrawn
 * without cancelling anything). A single machine would have to say "collected" about an item whose
 * two analytes sit in two different tubes, which is a sentence with no true reading.
 *
 * ═══ FILES-LIST DEVIATION, DISCLOSED (finding F8) ═══
 *
 * §5 T4's Files list names `definitions/lab_item.json` and `definitions/lab_specimen.json`. **This
 * repository cannot import a `.json` module**: `tsconfig.base.json` sets neither `resolveJsonModule`
 * nor `allowJson`, and the only shipped precedent — `modules/opd/workflow-def.ts`'s
 * `OPD_VISIT_DEFINITION_JSON` — is a TypeScript const for that reason. Shipping the JSON files too
 * would put two hand-maintained copies of one definition in the tree (§2.54's mechanism at file
 * scope), and shipping them INSTEAD would need a compiler-option change in a file this task does
 * not own. So the definitions are consts here, `createDraft` takes them as `unknown` exactly as it
 * takes the OPD one, and the deviation is reported rather than worked around.
 *
 * ═══ `verify` DECLARES `pathologist`, AND THAT IS NOT 17b's SoD GUARD ═══
 *
 * Plan 17 §9.3 S4: the ENGINE checks that a `user` actor holds one of a transition's declared
 * roles. So the role half of "only a pathologist signs" is expressed here and 17b does not re-check
 * it. What 17b DOES add is a different claim entirely — *the verifier is not the person who keyed
 * the result* — which is a fact about the RESULT ROW that no role list can express.
 */

export const LAB_ITEM_DEF_KEY = "lab_item";
export const LAB_SPECIMEN_DEF_KEY = "lab_specimen";

export const LAB_ITEM_STATES = [
  "ordered", "awaiting_collection", "collected", "accessioned", "in_analysis",
  "resulted", "verified", "published", "recollection_pending", "sent_out", "cancelled",
] as const;
export type LabItemState = (typeof LAB_ITEM_STATES)[number];

/**
 * **THESE ARE THE `lab_specimens_status_ck` WORDS, AND `specimens.test.ts` PROVES IT BY READING THE
 * SCHEMA** — close review pass 1, MAJOR 8.
 *
 * F15 claimed the definition was pinned against the table's vocabulary "so the two cannot drift".
 * It was not: the test compared the definition against this constant, twelve lines above it in the
 * same file, and never read the CHECK. The two had already drifted — this list said
 * `awaiting_collection` where the CHECK says `labelled`, and `printLabels` writes `labelled`. So a
 * tube's real first state was absent from its own state machine and the machine's initial state was
 * a value the database would have refused.
 */
export const LAB_SPECIMEN_STATES = [
  "labelled", "collected", "in_transit", "received", "stored", "rejected", "disposed",
] as const;
export type LabSpecimenState = (typeof LAB_SPECIMEN_STATES)[number];

/**
 * THE ITEM. Class C — a departmental operating flow, activated by the lab's own head rather than by
 * the owner-plus-MS two-key an OPD visit needs (that one is a patient-journey flow, D-15).
 *
 * **There is no `ordered → resulted` transition and nothing reaches `verified` except `resulted`**
 * (T4 A8). Both are load-bearing rather than tidy: the first is what makes "a result exists for a
 * specimen nobody accessioned" unrepresentable (E43), and the second is what stops a verified
 * signature appearing on a stage that never produced a number.
 *
 * `sent_out` is RESERVED for 17-M (the referral lab) and `recollection_pending` for T5's reject
 * path. Both are declared here because `defineWorkflow` refuses an unreachable state and refuses a
 * state that cannot reach a terminal — a stage added later would be a definition VERSION, and a
 * version bump on a live machine is a migration of every open instance. Declaring them now costs
 * two rows and saves that.
 */
export const LAB_ITEM_DEFINITION_JSON = {
  key: LAB_ITEM_DEF_KEY,
  title: "Lab item",
  changeClass: "C",
  initialState: "ordered",
  states: [
    { name: "ordered", sla: { minutes: 30, alerting: "record_only" } },
    {
      name: "awaiting_collection",
      sla: {
        minutes: 120, alerting: "active",
        escalation: [{ afterMinutes: 60, toRole: "lab_technician" }, { afterMinutes: 120, toRole: "pathologist" }],
      },
    },
    { name: "collected", sla: { minutes: 60, alerting: "active", escalation: [{ afterMinutes: 60, toRole: "lab_technician" }] } },
    { name: "accessioned", sla: { minutes: 30, alerting: "record_only" } },
    { name: "in_analysis", sla: { minutes: 240, alerting: "active", escalation: [{ afterMinutes: 240, toRole: "pathologist" }] } },
    { name: "resulted", sla: { minutes: 120, alerting: "active", escalation: [{ afterMinutes: 120, toRole: "pathologist" }] } },
    { name: "verified", sla: { minutes: 60, alerting: "record_only" } },
    /** The 7-day non-return clock (T5 A4 / DD20) measures the age of THIS state. */
    { name: "recollection_pending", sla: { minutes: 1440, alerting: "active", escalation: [{ afterMinutes: 1440, toRole: "lab_reception" }] } },
    { name: "sent_out", sla: { minutes: 4320, alerting: "record_only" } },
    { name: "published", terminal: true },
    { name: "cancelled", terminal: true },
  ],
  transitions: [
    { from: "ordered", to: "awaiting_collection", roles: ["lab_reception", "lab_technician", "phlebotomist"] },
    { from: "awaiting_collection", to: "collected", roles: ["phlebotomist", "lab_technician", "nurse"] },
    { from: "collected", to: "accessioned", roles: ["lab_technician"] },
    { from: "accessioned", to: "in_analysis", roles: ["lab_technician"] },
    /** 17-M's referral lane, declared and driven by nobody in this phase. */
    { from: "accessioned", to: "sent_out", roles: ["lab_technician", "pathologist"] },
    { from: "sent_out", to: "resulted", roles: ["lab_technician", "pathologist"] },
    { from: "in_analysis", to: "resulted", roles: ["lab_technician", "pathologist"] },
    /** THE RERUN LOOP — a pathologist sends a number back to the bench without a new order. */
    { from: "resulted", to: "in_analysis", roles: ["lab_technician", "pathologist"] },
    /** THE ONLY WAY INTO `verified`, and the engine checks the role itself (S4). */
    { from: "resulted", to: "verified", roles: ["pathologist"] },
    { from: "verified", to: "published", roles: ["pathologist", "lab_reception"] },
    /** T5's reject path: the tube was bad, the ORDER stands, a new tube is owed. */
    { from: "collected", to: "recollection_pending", roles: ["lab_technician", "pathologist"] },
    { from: "accessioned", to: "recollection_pending", roles: ["lab_technician", "pathologist"] },
    { from: "recollection_pending", to: "awaiting_collection", roles: ["lab_reception", "lab_technician", "phlebotomist"] },
    { from: "ordered", to: "cancelled", roles: ["lab_reception", "pathologist", "doctor"] },
    { from: "awaiting_collection", to: "cancelled", roles: ["lab_reception", "pathologist", "doctor"] },
    { from: "collected", to: "cancelled", roles: ["lab_reception", "pathologist"] },
    { from: "accessioned", to: "cancelled", roles: ["pathologist"] },
    { from: "in_analysis", to: "cancelled", roles: ["pathologist"] },
    /** DD20's non-return sweep cancels from HERE, as `system`, which bypasses the role check (S4). */
    { from: "recollection_pending", to: "cancelled", roles: ["lab_reception", "pathologist"] },
  ],
};

/**
 * THE TUBE. Class C for the same reason as the item.
 *
 * `rejected` is TERMINAL and that is DD5 read strictly: a rejected tube is never un-rejected — the
 * items get a NEW `lab_specimens` row with its own `S` number (T5 A3), which is what makes "the lab
 * dropped the tube" cost the patient nothing and still leave an auditable pair of rows.
 */
export const LAB_SPECIMEN_DEFINITION_JSON = {
  key: LAB_SPECIMEN_DEF_KEY,
  title: "Lab specimen",
  changeClass: "C",
  initialState: "labelled",
  states: [
    { name: "labelled", sla: { minutes: 120, alerting: "active", escalation: [{ afterMinutes: 120, toRole: "lab_technician" }] } },
    { name: "collected", sla: { minutes: 60, alerting: "active", escalation: [{ afterMinutes: 60, toRole: "lab_technician" }] } },
    { name: "in_transit", sla: { minutes: 120, alerting: "active", escalation: [{ afterMinutes: 120, toRole: "lab_technician" }] } },
    { name: "received", sla: { minutes: 30, alerting: "record_only" } },
    /** The retention clock DD5 gives a run sample; `disposed_at` is what refuses an add-on (E14). */
    { name: "stored", sla: { minutes: 10080, alerting: "record_only" } },
    { name: "rejected", terminal: true },
    { name: "disposed", terminal: true },
  ],
  transitions: [
    { from: "labelled", to: "collected", roles: ["phlebotomist", "lab_technician", "nurse"] },
    { from: "collected", to: "in_transit", roles: ["phlebotomist", "lab_technician", "nurse"] },
    { from: "collected", to: "received", roles: ["lab_technician"] },
    { from: "in_transit", to: "received", roles: ["lab_technician"] },
    { from: "received", to: "stored", roles: ["lab_technician"] },
    { from: "labelled", to: "rejected", roles: ["lab_technician", "pathologist"] },
    { from: "collected", to: "rejected", roles: ["lab_technician", "pathologist"] },
    { from: "in_transit", to: "rejected", roles: ["lab_technician", "pathologist"] },
    { from: "received", to: "rejected", roles: ["lab_technician", "pathologist"] },
    { from: "stored", to: "disposed", roles: ["lab_technician"] },
  ],
};

/** Validated DATA, not a schema: `defineWorkflow` throws with every problem at once. */
export function labItemDefinition(): WorkflowDefinition {
  return defineWorkflow(LAB_ITEM_DEFINITION_JSON);
}

export function labSpecimenDefinition(): WorkflowDefinition {
  return defineWorkflow(LAB_SPECIMEN_DEFINITION_JSON);
}
