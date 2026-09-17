/**
 * PLAN 16c — the pharmacy module's refusal vocabulary. Closed list, `LAB_ERROR_CODES`' shape:
 * a controller maps a code to a status, a screen renders it as a sentence, and a test names it.
 * Later tasks APPEND under their own heading; nothing is renamed.
 */
export const PHARMACY_ERROR_CODES = [
  "permission_denied",
  // ── sale items and the price rule (T2) ──
  "unknown_item",
  "not_a_drug",
  "sale_item_exists",
  "unknown_sale_item",
  "sale_item_inactive",
  "price_unknown",
  "gst_slab_unknown",
  // ── queue, claim, verify (T3) ──
  "unknown_dispense",
  "unknown_line",
  "unknown_prescription",
  "prescription_superseded",
  "dispense_not_in_state",
  "line_not_open",
  "schedule_x_not_dispensed_here",
  "unresolved_medicine",
  "substitution_not_allowed",
  "consent_required",
  "allergy_block",
  "interaction_block",
  "qty_required",
  "store_missing",
  "not_found",
  // ── pick, bill, hand over (T4) ──
  "scheduled_needs_pharmacist",
  "identity_confirmation_required",
  "nothing_to_dispense",
  "batch_not_saleable",
  "short_stock",
  "fefo_override_unavailable",
  "identity_mismatch",
  // ── the close review (16c §8.5 pass 1): money before the drug, D8 ──
  "invoice_not_settled",
  // ── the close review, second contract sweep: expired stock ──
  "batch_expired",
  /**
   * ── FD-31, owner ruling 2026-09-12 ──
   *
   * *"The pharmacist will cross confirm the prescription slip (either the photo capture of
   * prescription or physical prescription slip) before generating the medicine bill."*
   *
   * 409 and not 403: the account is allowed to bill, the DISPENSE is not ready to be billed. It is
   * the same animal as `invoice_not_settled` two lines up — a state conflict the pharmacist clears
   * by doing the thing, not an authority they lack.
   */
  "slip_not_confirmed",
  /**
   * THE SAME FACT AS `batch_expired`, A DIFFERENT REMEDY — which is why it is a different code.
   *
   * `batch_expired` is raised at the PICK, where the pharmacist NAMED a carton and can name
   * another; its string says "Choose another batch" and there that is true. This one is raised at
   * HAND OVER, on a line already picked, priced, billed and PAID. There is no batch to choose, the
   * money has moved, and the screen offers no such control. Reusing the code would hand the
   * pharmacist an impossible instruction at the one moment they are facing a patient.
   */
  "batch_expired_before_collection",
  // ── P2: the register of pharmacists (Pharmacy Act 1948 §42) ──
  /** The acting login has no current state council registration on file. */
  "pharmacist_not_registered",
  /** A registration is filed, and ended, by someone other than its holder. */
  "self_registration",
  "invalid_registration",
  "registration_expired",
  "registration_in_use",
  "registration_ended",
  "not_a_pharmacist_role",
  // ── P5: a paid dispense that cannot be collected ──
  /** An act whose record a reviewer will read, attempted without saying why. */
  "reason_required",
  // ── P6: sales returns (doc 16 O-7) ──
  "return_window_closed",
  "return_not_sealed",
  /** A cold-chain, frozen or narcotic item: its storage after it left the counter cannot be vouched for. */
  "return_not_accepted",
  "return_cut_strip",
  "return_short_expiry",
  "return_exceeds_dispensed",
  // ── P7 ──
  "invalid_day",
  // ── P9 ──
  "invalid_range",
  // ── P13 ──
  "scan_unknown",
  "scan_wrong_item",
  "scan_batch_unknown",
  "scan_batch_mismatch",
  // ── P19: walk-in retail sales ──
  /** No Form 20/21 licence is recorded for the retail store (Drugs and Cosmetics Act §18(c)). */
  "retail_licence_missing",
  /** The recorded licence does not cover today. */
  "retail_licence_lapsed",
  "invalid_retail_licence",
  "retail_store_missing",
  /** A Schedule H or H1 line with no outside prescription captured (r.65(9)). */
  "prescription_required",
  "invalid_prescription",
  "registration_not_permitted",
  "duplicate_suspected",
  "unknown_retail_sale",
  /**
   * The prescription photo could not be written (the kernel document store is not writable). The
   * sale is refused whole: a Schedule H sale without its prescription on file is not a sale.
   */
  "document_store_unavailable",
  // ── P20: paper dispenses entered after an outage ──
  /** Not a downtime kit's receipt sheet, or a serial the kit never reserved. */
  "sheet_invalid",
  "sheet_already_entered",
  /** The time on the sheet is in the future, or before the kit was printed. */
  "invalid_dispense_time",
  /** The time on the sheet fell while the hospital was not in downtime or degraded mode. */
  "not_in_downtime",
  "backfill_window_closed",
  /** A paper line must name the batch written on the sheet. */
  "batch_required",
  /** The person named as handing the medicine over is not pharmacy staff. */
  "unknown_pharmacist",
] as const;

export type PharmacyErrorCode = (typeof PHARMACY_ERROR_CODES)[number];

export class PharmacyError extends Error {
  constructor(
    readonly code: PharmacyErrorCode,
    message?: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message ?? `pharmacy refused: ${code}`);
    this.name = "PharmacyError";
  }
}

const STATUS: Record<PharmacyErrorCode, number> = {
  permission_denied: 403,
  unknown_item: 404,
  not_a_drug: 409,
  sale_item_exists: 409,
  unknown_sale_item: 404,
  sale_item_inactive: 409,
  price_unknown: 409,
  gst_slab_unknown: 409,
  unknown_dispense: 404,
  unknown_line: 404,
  unknown_prescription: 404,
  prescription_superseded: 409,
  dispense_not_in_state: 409,
  line_not_open: 409,
  schedule_x_not_dispensed_here: 409,
  unresolved_medicine: 409,
  substitution_not_allowed: 409,
  consent_required: 409,
  allergy_block: 409,
  interaction_block: 409,
  qty_required: 400,
  store_missing: 409,
  not_found: 404,
  scheduled_needs_pharmacist: 403,
  identity_confirmation_required: 409,
  nothing_to_dispense: 409,
  batch_not_saleable: 409,
  short_stock: 409,
  fefo_override_unavailable: 409,
  identity_mismatch: 409,
  invoice_not_settled: 409,
  batch_expired: 409,
  slip_not_confirmed: 409,
  batch_expired_before_collection: 409,
  pharmacist_not_registered: 403,
  self_registration: 403,
  invalid_registration: 400,
  registration_expired: 409,
  registration_in_use: 409,
  registration_ended: 409,
  not_a_pharmacist_role: 409,
  reason_required: 400,
  return_window_closed: 409,
  return_not_sealed: 409,
  return_not_accepted: 409,
  return_cut_strip: 409,
  return_short_expiry: 409,
  return_exceeds_dispensed: 409,
  invalid_day: 400,
  invalid_range: 400,
  scan_unknown: 409,
  scan_wrong_item: 409,
  scan_batch_unknown: 409,
  scan_batch_mismatch: 409,
  retail_licence_missing: 409,
  retail_licence_lapsed: 409,
  invalid_retail_licence: 400,
  retail_store_missing: 409,
  prescription_required: 409,
  invalid_prescription: 400,
  registration_not_permitted: 403,
  duplicate_suspected: 409,
  unknown_retail_sale: 404,
  document_store_unavailable: 503,
  sheet_invalid: 409,
  sheet_already_entered: 409,
  invalid_dispense_time: 400,
  not_in_downtime: 409,
  backfill_window_closed: 409,
  batch_required: 400,
  unknown_pharmacist: 409,
};

export function pharmacyHttpStatus(code: PharmacyErrorCode): number {
  return STATUS[code];
}
