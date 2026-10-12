import { IPD_INTENTS } from "@hmis/contracts";
import { defineWorkflow } from "../../kernel/workflow/definition";
import type { IpdActorKind, IpdAdmissionState, IpdIntentName } from "@hmis/contracts";
import type { WorkflowDefinition } from "../../kernel/workflow/definition";

/**
 * E0.2 (#714) — THE ADMISSION WORKFLOW (spec SPEC-ipd-core §0B; spec v4.6 §10.2: one workflow instance per
 * admission). Every edge names the intent that drives it, so the matrix and the intent catalogue cannot drift.
 *
 * DECIDED (E0.2, standard corporate-hospital practice; no owner ruling needed):
 * - `requested → admitted` exists: a direct admission picks and occupies the bed in one act, no reservation.
 * - `reserved → requested` (release_reservation): a released or lapsed reservation leaves the request alive.
 * - `cancelled` is reached by `cancel_admission`, an intent §0B does not list; the 24-hour advice expiry and
 *   the 2-hour reservation lapse call their intents as the `system` actor (marked `timer`).
 * - `discharging` begins at the gate pass (charges confirmed, summary signed, bill settled) and ends at the
 *   security scan: `discharged`, or `transferred_out` for a refer-out (§4.4: a discharge type).
 * - A patient who worsens after fit returns to `admitted` from `fit_declared` OR `discharging` (§4.7).
 * - Death can end any live stay after admission, including mid-transfer; LAMA and abscond end `admitted` and
 *   `fit_declared`; abscond also ends `discharging` (left with the pass, before the scan).
 * - Change class A (owner + medical superintendent), like the OT and OPD clinical definitions.
 */
export const ADMISSION_WORKFLOW_DEF_KEY = "ipd_admission";

/**
 * Actor kinds → the hospital's role keys. `ward_nurse`, `resident` and `nursing_supervisor` are new roles the
 * ipd-nursing / ipd-rounds lanes seed. A device's act reaches the engine as a `system` move (the intent itself
 * checks the device is registered); an agent never transitions — its proposal is confirmed by a person.
 */
export const IPD_ACTOR_ROLE_KEYS: Record<IpdActorKind, readonly string[]> = {
  desk: ["front_office"],
  nurse: ["ward_nurse"],
  doctor: ["doctor"],
  resident: ["resident"],
  pharmacist: ["pharmacy"],
  billing: ["cashier", "billing_manager"],
  supervisor: ["nursing_supervisor"],
  duty_manager: ["duty_manager"],
  device: ["system"],
  agent: [],
};

export type AdmissionTransition = {
  from: IpdAdmissionState;
  to: IpdAdmissionState;
  intent: IpdIntentName;
  /** Also driven by a timer calling the same intent as the `system` actor. */
  timer?: true;
};

export const ADMISSION_TRANSITIONS: readonly AdmissionTransition[] = [
  // ── before the bed ──
  { from: "requested", to: "reserved", intent: "reserve_bed" },
  { from: "requested", to: "admitted", intent: "admit" },
  { from: "requested", to: "cancelled", intent: "cancel_admission", timer: true },
  { from: "reserved", to: "requested", intent: "release_reservation", timer: true },
  { from: "reserved", to: "admitted", intent: "admit" },
  { from: "reserved", to: "cancelled", intent: "cancel_admission", timer: true },
  // ── the stay ──
  { from: "admitted", to: "transferring", intent: "start_transfer" },
  { from: "transferring", to: "admitted", intent: "accept_handover" },
  { from: "admitted", to: "fit_declared", intent: "declare_fit" },
  { from: "fit_declared", to: "admitted", intent: "cancel_fit" },
  // ── the discharge cascade ──
  { from: "fit_declared", to: "discharging", intent: "issue_gate_pass" },
  { from: "discharging", to: "admitted", intent: "cancel_fit" },
  { from: "discharging", to: "discharged", intent: "scan_gate_pass" },
  { from: "discharging", to: "transferred_out", intent: "scan_gate_pass" },
  // ── the other ways a stay ends ──
  { from: "admitted", to: "lama", intent: "record_lama" },
  { from: "fit_declared", to: "lama", intent: "record_lama" },
  { from: "admitted", to: "absconded", intent: "record_abscond" },
  { from: "fit_declared", to: "absconded", intent: "record_abscond" },
  { from: "discharging", to: "absconded", intent: "record_abscond" },
  { from: "admitted", to: "deceased", intent: "record_death" },
  { from: "transferring", to: "deceased", intent: "record_death" },
  { from: "fit_declared", to: "deceased", intent: "record_death" },
  { from: "discharging", to: "deceased", intent: "record_death" },
];

/** The intent that drives `from → to`, or null when the move does not exist. */
export function admissionIntentFor(from: string, to: string): IpdIntentName | null {
  return ADMISSION_TRANSITIONS.find((t) => t.from === from && t.to === to)?.intent ?? null;
}

const rolesFor = (t: AdmissionTransition): string[] => {
  const roles = new Set(IPD_INTENTS[t.intent].actors.flatMap((a) => IPD_ACTOR_ROLE_KEYS[a]));
  if (t.timer) roles.add("system");
  return [...roles];
};

const DAY_MINUTES = 1440;

/**
 * PR #745 review — the `requested` budget for one admission. The kernel lays an SLA from STATE ENTRY and has no
 * deferred start, but `rescheduleBudget(tx, instanceId, minutes)` re-lays it from that same anchor. So an advance
 * booking keeps its clock honest by the ipd-admit lane calling, right after `startInstance`:
 *   `rescheduleBudget(tx, instanceId, requestedBudgetMinutes(requestedAt, plannedFor))`
 * which ends the clock at plannedFor + 24 h (the advice expiry), never at request time + 24 h. Same-day: 24 h.
 */
export function requestedBudgetMinutes(requestedAt: Date, plannedFor?: Date): number {
  const ahead = plannedFor === undefined ? 0 : plannedFor.getTime() - requestedAt.getTime();
  return ahead > 0 ? Math.ceil(ahead / 60_000) + DAY_MINUTES : DAY_MINUTES;
}

const recordOnly = (minutes: number) => ({ minutes, alerting: "record_only" as const });

export const admissionWorkflowDefinition: WorkflowDefinition = defineWorkflow({
  key: ADMISSION_WORKFLOW_DEF_KEY,
  title: "Inpatient admission",
  changeClass: "A",
  initialState: "requested",
  states: [
    // Advice expires 24 h after its planned date; the expiry is a timer calling cancel_admission.
    { name: "requested", sla: recordOnly(DAY_MINUTES) }, // advance bookings: requestedBudgetMinutes
    // A reservation lapses after 2 h; the lapse is a timer calling release_reservation.
    { name: "reserved", sla: recordOnly(120) },
    { name: "admitted", sla: recordOnly(10080) },
    // §4.4: no acceptance in 30 minutes escalates.
    { name: "transferring", sla: { minutes: 30, alerting: "active", ladder: [{ atPercent: 100, toRole: "nursing_supervisor" }] } },
    // §4.7: 3-hour discharge target for cash; the duty manager hears at the target.
    { name: "fit_declared", sla: { minutes: 180, alerting: "active", ladder: [{ atPercent: 100, toRole: "duty_manager" }] } },
    // Gate pass issued, not yet scanned: shown to security at day end, not an alert.
    { name: "discharging", sla: recordOnly(240) },
    { name: "discharged", terminal: true },
    { name: "lama", terminal: true },
    { name: "absconded", terminal: true },
    { name: "deceased", terminal: true },
    { name: "transferred_out", terminal: true },
    { name: "cancelled", terminal: true },
  ],
  transitions: ADMISSION_TRANSITIONS.map((t) => ({ from: t.from, to: t.to, roles: rolesFor(t) })),
});
