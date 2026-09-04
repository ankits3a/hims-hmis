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
};

export function pharmacyHttpStatus(code: PharmacyErrorCode): number {
  return STATUS[code];
}
