import { IPD_REFUSALS } from "@hmis/contracts";
import type { IpdRefusalCode } from "@hmis/contracts";

/**
 * The ipd module's error vocabulary. Same shape as the other modules' errors: a stable `code` a caller
 * maps, a sentence a person reads, and `detail` carrying the data the sentence names.
 */
export type IpdErrorCode =
  /** #787 — a return would credit more units than the pharmacy line carries; nothing is capped silently. */
  | "credit_exceeds_line"
  /** #787 — a pharmacy line could neither be inserted nor found: the posting is refused, never dropped. */
  | "charge_line_not_posted"
  /** A bed-layout file failed validation or disagrees with the registry; nothing was written. */
  | "bed_layout_invalid"
  /** `apply` by an actor who does not hold the bed-layout permission; nothing was written. */
  | "bed_layout_forbidden"
  /** E1.1 — a bed act by an actor who does not hold its permission (the route guard's check, re-made inside). */
  | "ipd_forbidden"
  /** E1.2 — the admission workflow definition is not active yet (a go-live governance step activates it). */
  | "admission_workflow_inactive"
  /** E1.2 — a tender the billing ledger does not take (it takes cash, UPI and card). */
  | "tender_not_supported"
  /** E1.2 — the approval type an act needs is not registered yet (a go-live step registers it). */
  | "approval_type_missing"
  /** E1.2 review — a non-covered line asked without its amount. */
  | "non_covered_amount_required"
  /** E2.1 — the nightly charge run failed for at least one admission (the others posted); `detail.failed`. */
  | "charges_post_failed"
  /** E2.1 — a reversal without a reason. */
  | "reversal_reason_required"
  /** E2.1 — no charge line with that id. */
  | "charge_line_not_found"
  /** E2.1 — a reversal line cannot itself be reversed. */
  | "charge_line_is_reversal"
  /** E2.1 — the line already has its reversal (`detail.reversalLineId`). */
  | "charge_line_already_reversed"
  /** E2.2 (#726) — the non-payables list: a live row already matches; no live row with that id. */
  | "non_payable_exists"
  | "non_payable_not_found"
  /** E5.4 (#741) — a signing act named a copilot draft that is not this admission's (or not of that kind). */
  | "shift_handover_draft_not_found"
  | "summary_draft_not_found"
  /** E5.4 review — the records changed after the draft was built (build again); after the summary was last saved (open, check, save). */
  | "shift_handover_draft_stale"
  | "summary_draft_stale"
  | "summary_records_changed"
  /** E3.2 (#730) — a signed summary is immutable; an addendum is a later lane's. */
  | "summary_already_signed"
  /** E3.2 — no draft to sign yet. */
  | "summary_not_found"
  /** E3.2 — the diagnosis names an ICD-10 code the catalogue does not carry. */
  | "icd10_unknown"
  /** E3.2 — the tenders exceed the patient's bill: record what is applied and give the change. */
  | "tender_exceeds_bill"
  /** E3.2 — the mortuary register: no such row; the act does not fit its status; the two-person check needs two people. */
  | "mortuary_entry_not_found"
  | "mortuary_wrong_state"
  | "identity_check_same_person"
  /**
   * #763 — the supplementary bill and the void: a reversal of a line a settled bill took (void the bill first); no live
   * bill with that id on the admission; already voided; a newer live bill must be voided first; the void needs a granted
   * `ipd_bill_void` approval decided by someone other than its requester; the bill's refund voucher is already issued
   * (the money is out — the void is refused); no charge waits for a supplementary bill.
   */
  | "charge_line_billed"
  | "bill_not_found"
  | "bill_already_voided"
  | "void_newer_bill_first"
  | "void_needs_approval"
  | "refund_issued"
  | "nothing_to_bill"
  /** #763 review — a void while an issued gate pass is not yet scanned (⚖); the payer has settled the bill's claim. */
  | "gate_pass_live"
  | "payer_claim_settled"
  /** #604 review — a void while the bill's claim is filed with the payer: its settlement could never be recorded. */
  | "payer_claim_filed"
  /** E3.2 — ⚖ an MLC body is released only after the police clearance is recorded. */
  | "police_clearance_required"
  /** E3.3 (#731) — the family link: refused for this admission (`detail.reason`: sealed, mlc, family_off, no_attendant_phone,
   * stay_ended); no such link or callback; the public side's refusals (closed link, OTP limits, wrong or stale code, no
   * session, the attendant's phone changed since issue, the SMS could not be sent). */
  | "family_link_refused"
  /** #761 — consent or stop for the daily totals refused (`detail.reason`: stay_ended, no_attendant_phone). */
  | "attendant_messages_refused"
  | "family_link_not_found"
  | "family_callback_not_found"
  | "family_link_closed"
  | "family_otp_limit"
  | "family_otp_invalid"
  | "family_otp_unavailable"
  | "family_phone_changed"
  | "family_session_required"
  | "family_callback_limit"
  /** E4.1 (#733) — nursing: no such shift handover; it was accepted or superseded; its giver cannot accept it; no such
   * early-warning alert; the alert already cleared. */
  | "shift_handover_not_found"
  | "shift_handover_not_open"
  | "shift_handover_own"
  | "ews_alert_not_found"
  | "ews_alert_closed"
  /**
   * WM-1 (#982) — the ward's nurses: no such ward or map; the map is already live (change it bed by bed); a bed not on
   * the ward; a person who may not be on the map as that kind; an occupied bed with no nurse at publish (`detail.bedIds`);
   * a student as a bed's only nurse (`detail.bedIds`); a reassignment without a reason; no live map for the shift; end
   * of duty (or a float move) while holding beds (`detail.bedIds`); end of duty by someone not on the map; acuity for a
   * patient not on a ward bed.
   */
  | "ward_not_found"
  | "shift_map_not_found"
  | "shift_map_not_draft"
  | "bed_not_on_ward"
  | "staff_not_eligible"
  | "bed_unassigned"
  | "student_alone"
  | "reassign_reason_required"
  | "no_live_shift_map"
  | "beds_still_assigned"
  | "not_on_shift"
  | "acuity_admission_not_on_ward"
  /**
   * WM-2 (#983, decisions 0089 / 0091) — ward safety and stock: the patient is not on a ward bed; a care plan, restraint,
   * line or crash cart that does not exist, or is over; a restraint whose 24 hours ran out without a doctor's review
   * (a new order is needed); a psychiatric ward's restraint not ordered by a psychiatrist (MHCA s.97); a crash cart
   * whose seal changed (or that was used in a code) checked without a full recount (`detail.missing`); a cart code taken;
   * an agency or student nurse taking the narcotic keys, or an agency nurse counting or witnessing a narcotic count; ward
   * stock with no ward store set, a lot not at the ward or past its expiry, wastage without a reason, a waiver by
   * someone who is not the in-charge, and an indent with nothing short of par; a line infection without its line.
   */
  | "patient_not_on_ward"
  | "care_plan_not_found"
  | "care_plan_ended"
  | "restraint_not_found"
  | "restraint_not_active"
  | "restraint_lapsed"
  | "restraint_psychiatrist_required"
  | "line_not_found"
  | "line_removed"
  | "line_time_invalid"
  | "crash_cart_not_found"
  | "crash_cart_code_taken"
  | "crash_cart_recount_required"
  | "crash_cart_restock_required"
  | "agency_no_narcotic_keys"
  | "student_no_narcotic_keys"
  | "agency_no_narcotic_count"
  | "ward_store_not_set"
  | "ward_stock_not_at_ward"
  | "ward_stock_lot_expired"
  | "waste_reason_required"
  | "waive_needs_incharge"
  | "nothing_to_indent"
  /** #1010 — no lot at the ward is expiring within 30 days (or the named ones are not). */
  | "nothing_to_return"
  /** #1009 — an agency nurse as second-check witness with no verified, in-date council registration; a verify for a non-nurse. */
  | "agency_witness_unverified"
  | "not_a_nurse"
  | "safety_event_line_required"
  /** #604 (decision 0075) — the scheme package file failed validation (`detail.problems`, line by line); nothing was written. */
  | "package_import_invalid";

export class IpdError extends Error {
  constructor(
    readonly code: IpdErrorCode,
    message: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "IpdError";
  }
}

/**
 * E1.1 — A REFUSED IPD ACT (spec §0A principle 5: no dead ends). `code` is a contract refusal code; `rule` and `fix`
 * are its words from `IPD_REFUSALS`; `bedRule` names the bed's own rule when one refused ("Female-only bed").
 * `detail` carries data (the next three rule-valid beds, the live reservation) — the words never carry numbers.
 */
export class IpdRefusal extends Error {
  readonly rule: string;
  readonly fix: string;
  constructor(
    readonly code: IpdRefusalCode,
    readonly bedRule?: string,
    readonly detail?: Record<string, unknown>,
  ) {
    const words = IPD_REFUSALS[code];
    super(bedRule === undefined ? words.rule : `${bedRule}: ${words.rule}`);
    this.rule = words.rule;
    this.fix = words.fix;
    this.name = "IpdRefusal";
  }
}

/** HTTP status of a refusal: unknown things 404, the duty-manager gate 403, every other rule 409. */
export function ipdRefusalStatus(code: IpdRefusalCode): number {
  if (code.endsWith("_not_found")) return 404;
  if (code === "overflow_needs_duty_manager") return 403;
  return 409;
}
