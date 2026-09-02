/**
 * PLAN 16c D8 — THE DISPENSE IS A DEFINITION (the lab `workflow-def.ts` shape), CLASS C.
 *
 * The phase doc wrote "Class-B" (doc 16 §3's default). It ships as C for the reason 17a's lab
 * definitions did: this is a department's own operating procedure — it moves no money and gates
 * nothing legal (the schedule gate is a PERMISSION, `pharmacy.dispense.scheduled`, checked in code)
 * — and Class B's activation needs a `department_head` and a `duty_manager` approval that no seed
 * can supply on a box with one administrator. Recorded in the CLOSE as a deviation, not hidden.
 *
 * Six live states and a terminal pair, projected onto the order envelope by the counter's own
 * writes (`in_progress` at pick, `completed` at hand over, `cancelled` on cancel — DD4's four
 * states stay the kernel's). Roles on transitions are the two this phase declares; `doctor` may
 * cancel a queued dispense because withdrawing an Rx is the doctor's act. SLAs are doc 16 §3.1's
 * (2 min to verify, 3 to pick, 5 to bill) with `record_only` alerting until a pharmacy in-charge
 * exists to escalate to (16d).
 */
export const PHARMACY_DISPENSE_DEF_KEY = "pharmacy_dispense";

export const PHARMACY_DISPENSE_STATES = [
  "queued", "claimed", "verified", "picked", "billed", "handed_over", "cancelled",
] as const;
export type PharmacyDispenseState = (typeof PHARMACY_DISPENSE_STATES)[number];

const COUNTER = ["pharmacy", "pharmacy_assistant"];
const PHARMACIST = ["pharmacy"];

export const PHARMACY_DISPENSE_DEFINITION_JSON = {
  key: PHARMACY_DISPENSE_DEF_KEY,
  title: "Pharmacy dispense (OPD counter)",
  changeClass: "C",
  initialState: "queued",
  states: [
    { name: "queued", sla: { minutes: 120, alerting: "record_only" } },
    { name: "claimed", sla: { minutes: 2, alerting: "record_only" } },
    { name: "verified", sla: { minutes: 3, alerting: "record_only" } },
    { name: "picked", sla: { minutes: 5, alerting: "record_only" } },
    { name: "billed", sla: { minutes: 1440, alerting: "record_only" } },
    { name: "handed_over", terminal: true },
    { name: "cancelled", terminal: true },
  ],
  transitions: [
    { from: "queued", to: "claimed", roles: COUNTER },
    { from: "claimed", to: "verified", roles: COUNTER },
    { from: "verified", to: "picked", roles: COUNTER },
    { from: "picked", to: "billed", roles: COUNTER },
    { from: "billed", to: "handed_over", roles: COUNTER },
    { from: "queued", to: "cancelled", roles: [...COUNTER, "doctor"] },
    { from: "claimed", to: "cancelled", roles: COUNTER },
    { from: "verified", to: "cancelled", roles: COUNTER },
    { from: "picked", to: "cancelled", roles: COUNTER },
    { from: "billed", to: "cancelled", roles: PHARMACIST },
  ],
};
