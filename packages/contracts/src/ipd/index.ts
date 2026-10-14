import * as admitIntents from "./intents-admit";
import * as dischargeIntents from "./intents-discharge";
import * as medIntents from "./intents-meds";
import * as roundIntents from "./intents-rounds";
import * as wardIntents from "./intents-ward";
import { IpdIdempotencyKeySchema } from "./common";

export * from "./common";
export * from "./refusals";
export * from "./bed-board";
export {
  IPD_ADMISSION_INCOMPLETE, IPD_CONSENT_METHODS, IPD_DEPOSIT_BASES, IPD_PAYER_KINDS, IpdBandPayloadSchema, IpdBedNeedSchema,
  IpdClassChangeSchema, IpdConsentSchema, IpdPayerKindSchema,
} from "./intents-admit";
export type { IpdAdmissionIncomplete, IpdBandPayload, IpdBedNeed, IpdConsent, IpdPayerKind } from "./intents-admit";
export * from "./admissions";
export * from "./charges";
// E2.2 (#726) — the payer split.
export * from "./payer";
// E3.1 (#729) — the transfer panel and the handover list.
export * from "./transfers";
// E2.3 (#727) — the deposit ladder and the bill desk.
export * from "./bill-desk";
// E3.2 (#730) — discharge: the tracker, the summary, the final bill, the mortuary register.
export * from "./discharge";
// E3.3 (#731) — the family link: OTP to the registered attendant, condition word, totals, tracker, callbacks.
export * from "./family";
// E4.1 (#733) — nursing: the early-warning scores, the nurse station, my shift, the chart, I/O, notes, shift handover.
export * from "./nursing";
// E4.2 (#734) — rounds: the doctor's list, the patient's round page, the order event contract eMAR consumes.
export * from "./rounds";
// E4.3 (#735) — the eMAR: verify queue, the MAR, the bedside, labels, override counts.
export * from "./emar";
// E5.3 (#740), E5.4 (#741) — "Since yesterday", the SBAR draft and the discharge drafter: lines with sources, stamps, flags.
export * from "./copilot";
export { IPD_ALLERGY_OVERRIDE_REASONS, IPD_DRUG_ROUTES, IPD_REISSUE_REASONS, IPD_VERBAL_EMERGENCIES, IpdDrugOrderSchema } from "./intents-meds";
export type { IpdDrugOrder } from "./intents-meds";
export { IPD_ROUND_SOURCES, IpdRoundSoapSchema } from "./intents-ward";
export type { IpdRoundSoap } from "./intents-ward";

/**
 * E0.2 (#714) — THE IPD INTENT CATALOGUE: spec §0B's 38 intents plus `cancel_admission` (DECIDED, see
 * intents-admit.ts), `release_incumbent_bed` (E1.1, DECIDED, same file) and E1.2's `plan_admission`,
 * `emergency_admit`, `backfill_downtime`, `record_consent` and `record_stabilised` (DECIDED, same file), keyed by
 * the name the copilot, HTTP routes and the workflow use.
 */
export const IPD_INTENTS = {
  request_admission: admitIntents.requestAdmission,
  cancel_admission: admitIntents.cancelAdmission,
  reserve_bed: admitIntents.reserveBed,
  release_reservation: admitIntents.releaseReservation,
  admit: admitIntents.admit,
  assign_bed: admitIntents.assignBed,
  print_band: admitIntents.printBand,
  reprint_band: admitIntents.reprintBand,
  record_payer_auth: admitIntents.recordPayerAuth,
  take_deposit: admitIntents.takeDeposit,
  plan_admission: admitIntents.planAdmission,
  emergency_admit: admitIntents.emergencyAdmit,
  backfill_downtime: admitIntents.backfillDowntime,
  record_consent: admitIntents.recordConsent,
  record_stabilised: admitIntents.recordStabilised,
  start_transfer: wardIntents.startTransfer,
  accept_handover: wardIntents.acceptHandover,
  swap_beds: wardIntents.swapBeds,
  change_class: wardIntents.changeClass,
  // E3.1 (#729, DECIDED) — calls a transfer off before acceptance (§4.4 "cancel back").
  cancel_transfer: wardIntents.cancelTransfer,
  block_bed: admitIntents.blockBed,
  unblock_bed: admitIntents.unblockBed,
  mark_bed_clean: admitIntents.markBedClean,
  release_incumbent_bed: admitIntents.releaseIncumbentBed,
  record_nursing_assessment: wardIntents.recordNursingAssessment,
  record_vitals: wardIntents.recordVitals,
  raise_task: wardIntents.raiseTask,
  complete_task: wardIntents.completeTask,
  sign_round: wardIntents.signRound,
  place_ip_order: medIntents.placeIpOrder,
  verify_order: medIntents.verifyOrder,
  issue_med: medIntents.issueMed,
  administer_dose: medIntents.administerDose,
  hold_dose: medIntents.holdDose,
  refuse_dose: medIntents.refuseDose,
  record_infusion_event: medIntents.recordInfusionEvent,
  // E4.2 (#734, DECIDED) — the round's co-sign, the cross-consult, and stopping or cancelling an inpatient order.
  cosign_round: roundIntents.cosignRound,
  request_consult: roundIntents.requestConsult,
  close_consult: roundIntents.closeConsult,
  stop_ip_order: medIntents.stopIpOrder,
  cancel_ip_order: medIntents.cancelIpOrder,
  // E4.3 (#735, DECIDED) — the eMAR's own acts beside §0B's five: miss, re-offer, correction, the second nurse's PIN,
  // the verbal order's signature, narcotic wastage, the return to pharmacy and the allergy flag.
  miss_dose: medIntents.missDose,
  reoffer_held_doses: medIntents.reofferHeldDoses,
  mark_dose_in_error: medIntents.markDoseInError,
  second_check: medIntents.secondCheck,
  sign_verbal_order: medIntents.signVerbalOrder,
  record_narcotic_wastage: medIntents.recordNarcoticWastage,
  return_med: medIntents.returnMed,
  resolve_allergy_flag: medIntents.resolveAllergyFlag,
  decide_allergy_flag: medIntents.decideAllergyFlag,
  declare_fit: dischargeIntents.declareFit,
  cancel_fit: dischargeIntents.cancelFit,
  confirm_charges: dischargeIntents.confirmCharges,
  sign_summary: dischargeIntents.signSummary,
  settle_final_bill: dischargeIntents.settleFinalBill,
  issue_gate_pass: dischargeIntents.issueGatePass,
  scan_gate_pass: dischargeIntents.scanGatePass,
  record_lama: dischargeIntents.recordLama,
  record_abscond: dischargeIntents.recordAbscond,
  record_death: dischargeIntents.recordDeath,
} as const;

export type IpdIntentName = keyof typeof IPD_INTENTS;
export const IPD_INTENT_NAMES = Object.keys(IPD_INTENTS) as IpdIntentName[];

/**
 * The idempotency scope of one request: `ipd:<intent>:<key>`. Two different intents never collide on one key,
 * and a key's case never splits one retry into two acts. Throws on an unknown intent or a malformed key.
 */
export function ipdIdempotencyScope(intent: IpdIntentName, key: string): string {
  if (!Object.prototype.hasOwnProperty.call(IPD_INTENTS, intent)) throw new Error(`unknown IPD intent "${intent}"`);
  const parsed = IpdIdempotencyKeySchema.safeParse(key.toLowerCase());
  if (!parsed.success) throw new Error(`idempotency key for "${intent}" must be a uuid`);
  return `ipd:${intent}:${parsed.data}`;
}
