import { IPD_BED_STATUSES, IPD_INTENTS } from "@hmis/contracts";
import type { IpdActorKind, IpdIntentName } from "@hmis/contracts";

/**
 * E0.5 (#717) — THE NAMES THE GOAL QUERIES READ.
 *
 * Every event an intent already emits is taken from `IPD_INTENTS[...].events`, never retyped: if an intent's
 * event is renamed in the contract, `intentEvent` throws at load and the goal queries cannot go on counting a
 * name nobody writes any more. `IPD_GOAL_EVENTS` holds ONLY the instrument events the plan's §1 table needs and
 * no intent emits yet (census job, rent posting, early-warning alerts, client timing, tracker link); the
 * acceptance test proves none of them collides with an intent's event.
 */
export function intentEvent(intent: IpdIntentName, contains?: string): string {
  const events = IPD_INTENTS[intent].events;
  const hits = contains === undefined ? events : events.filter((e) => e.includes(contains));
  if (hits.length !== 1) {
    throw new Error(`goal query: intent "${intent}" has ${hits.length} events matching "${contains ?? "*"}", expected 1`);
  }
  return hits[0]!;
}

export const EV = {
  admissionRequested: intentEvent("request_admission"),
  bedReserved: intentEvent("reserve_bed", "bed.reserved"),
  bedAssigned: intentEvent("assign_bed", "bed.assigned"),
  admitted: intentEvent("admit", "admission.admitted"),
  payerAuthRecorded: intentEvent("record_payer_auth"),
  fitDeclared: intentEvent("declare_fit"),
  gatePassScanned: intentEvent("scan_gate_pass", "gate_pass.scanned"),
  discharged: intentEvent("scan_gate_pass", "admission.discharged"),
  doseGiven: intentEvent("administer_dose"),
} as const;

/** Every event any IPD intent emits: the population of "acts" G11b audits. */
export const IPD_ACT_EVENTS: readonly string[] = [
  ...new Set(Object.values(IPD_INTENTS).flatMap((d) => [...d.events])),
];

/**
 * Instrument events the plan needs that no intent emits yet. Payloads (DECIDED, E0.5; the emitting lane owns
 * the producer):
 * - `ipd.census.taken` — midnight census job: `{ censusDate, hmisAdmissions, incumbentAdmissions,
 *   incumbentOccupiedBeds }` (new admissions that day in each system; beds still on the incumbent).
 * - `ipd.charge.rent_posted` — nightly rent line: `{ admissionId, rentDate, chargeLineId }`.
 * - `ipd.ews.breached` — early-warning breach alert: `{ alertId, admissionId, wardId? }`.
 * - `ipd.ews.acknowledged` — a breach acknowledged: `{ alertId, byKind }`, `byKind` an `IpdActorKind`.
 * - `ipd.intent.timed` — client timing of one act: `{ intent, durationMs, taps?, inputMode? }`.
 * - `ipd.tracker.opened` — family opened the discharge tracker link: `{ admissionId }`.
 */
export const IPD_GOAL_EVENTS = {
  censusTaken: "ipd.census.taken",
  rentPosted: "ipd.charge.rent_posted",
  ewsBreached: "ipd.ews.breached",
  ewsAcknowledged: "ipd.ews.acknowledged",
  intentTimed: "ipd.intent.timed",
  trackerOpened: "ipd.tracker.opened",
} as const;

/** The notify template the daily-totals message to the family goes out on (G10). */
export const IPD_GOAL_TEMPLATES = { dailyTotals: "ipd.daily_totals" } as const;

/** The reason the bed lane writes on a bed's move to cleaning when the clean is terminal (G3); else routine. */
export const IPD_GOAL_CLEAN_REASONS = { terminal: "clean:terminal", routine: "clean:routine" } as const;

type BedStatus = (typeof IPD_BED_STATUSES)[number];
export const BED_CLEANING: BedStatus = "cleaning";
export const BED_AVAILABLE: BedStatus = "available";

/** Who may acknowledge an early-warning breach for G7: a doctor (residents are the duty doctors). */
export const EWS_ACK_KINDS: readonly IpdActorKind[] = ["doctor", "resident"];

export const TIMED_INTENTS = {
  admit: "admit",
  dose: "administer_dose",
  vitals: "record_vitals",
} as const satisfies Record<string, IpdIntentName>;
