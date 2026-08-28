export type BillingErrorCode =
  | "billing_not_configured" | "invalid_paise" | "unsettled_issue_refused"
  | "credit_permission_required" | "credit_approval_required" | "outstanding_cap_exceeded"
  | "discount_approval_missing" | "approval_subject_mismatch"
  | "change_exceeds_surplus" | "change_without_cash"
  | "unknown_invoice" | "unknown_receipt" | "unknown_line"
  | "over_allocation" | "allocation_exceeds_advance" | "allocation_reversed_already"
  | "no_open_session" | "session_already_open" | "session_state_conflict" | "variance_approval_required"
  | "pan_required" | "cash_threshold_blocked" | "tender_ref_required"
  | "credit_exceeds_line" | "correction_must_exhaust" | "over_cap"
  | "clearance_approval_required" | "clearance_requires_outstanding"
  | "refund_exceeds_received" | "refund_exceeds_advance" | "bank_transfer_required" | "voucher_state_conflict"
  | "approval_not_granted" | "unknown_series" | "eie_already_marked" | "eie_advance_refunded"
  | "recon_parse_failed"
  | "idempotency_key_reused" | "idempotency_key_in_progress"
  | "unknown_encounter" | "fee_not_applicable" | "duplicate_ref";

export class BillingError extends Error {
  constructor(
    readonly code: BillingErrorCode,
    message?: string,
    readonly detail?: unknown, // e.g. asked-vs-cap, threshold hit — carried to the HTTP body
  ) {
    super(message ?? code);
    this.name = "BillingError";
  }
}

/**
 * ═══ THE CODE→STATUS TABLE LIVES WITH THE CODES, BECAUSE IT HAS MORE THAN ONE CALLER ═══
 *
 * This began as a private `billingStatus` inside `billing.controller.ts`, which was correct while
 * billing's own controller was the only place a `BillingError` could surface. Plan 15 T7 gave the
 * OT module a discharge-bill route that calls `issueInvoice` directly, so `OtRecoveryController`
 * became a second caller — and the first run of Plan 15's e2e measured what that cost: a bill
 * larger than the patient's deposit answered **500 Internal Server Error**, the exception escaping
 * an unmapped `catch`, where the right answer is a 409 the cashier can read.
 *
 * This is Plan 09's `membershipHttpStatus` finding again, exactly (billing.controller.ts's own
 * comment records it: T4 wired membership into `issueInvoice` and every MembershipError answered
 * 500 until the status function moved to the module's index). The lesson that generalises is not
 * "add another clause" — it is that a code→status table private to one controller is a latent 500
 * for the second caller, and the second caller arrives whenever a module gains a route that calls
 * another module's write path. Copying the table into OT would be §2.54's two-copies-drift; both
 * controllers import THIS.
 */
const NOT_FOUND_CODES = new Set<BillingErrorCode>([
  "unknown_invoice", "unknown_receipt", "unknown_line", "unknown_encounter", "unknown_series",
]);
const FORBIDDEN_CODES = new Set<BillingErrorCode>(["credit_permission_required"]);
/** Client-input refusals. Everything else is a state/ledger conflict and answers 409. */
const VALIDATION_CODES = new Set<BillingErrorCode>([
  "invalid_paise", "pan_required", "tender_ref_required", "bank_transfer_required",
  "recon_parse_failed", "duplicate_ref",
]);

export function billingHttpStatus(code: BillingErrorCode): number {
  if (NOT_FOUND_CODES.has(code)) return 404;
  if (FORBIDDEN_CODES.has(code)) return 403;
  if (VALIDATION_CODES.has(code)) return 400;
  return 409;
}
