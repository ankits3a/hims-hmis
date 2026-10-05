export type BillingErrorCode =
  | "billing_not_configured" | "invalid_paise" | "unsettled_issue_refused"
  /** FD-27 — a LIVE invoice already charges one of these services on this visit. */
  | "duplicate_invoice_refused"
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
  | "unknown_encounter" | "fee_not_applicable" | "duplicate_ref"
  /**
   * FD-35 — the draft names a patient and an encounter that belong to two different people. The
   * server does not get to guess which one the cashier meant, so it refuses and names both.
   */
  | "patient_encounter_mismatch"
  // FD-11 — the audited re-count of a mistyped closing count.
  | "unknown_session" | "not_your_session" | "recount_reason_required"
  /** GAP A3 — no credit request (a `billing_credit_owner` approval) with that id. */
  | "unknown_credit_request"
  /**
   * OWNER RULING 2026-09-28 — Aadhaar is never stored: a refund payee's ID is recorded by TYPE only,
   * and a pay call that carries an Aadhaar number (or any 12-digit number) is refused.
   */
  | "aadhaar_not_stored"
  /** UX-AUDIT 2026-09-28 · BOARD — resolving a settlement mismatch (`recon-resolve.ts`). */
  | "unknown_tender" | "tender_not_mismatched" | "not_short_settled" | "recon_already_disputed"
  /**
   * OWNER RULING 2026-09-30 (money) — a rounding rule or a sale discount asked on a bill that is not a
   * pharmacy bill, and a sale discount that cannot be given (no reason, over 100%, over the bill).
   */
  | "pharmacy_bill_only" | "sale_discount_refused"
  /**
   * OWNER 2026-10-05 — the consultation price list (`consult-prices.ts`): a proposal while another
   * waits, a proposal that changes nothing, a revisit price with no revisit service wired, a
   * decision on a version that is not waiting.
   */
  | "consult_price_pending" | "consult_price_unchanged" | "revisit_fee_unwired" | "consult_price_not_pending"
  | "consult_price_reason_required";

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
  "unknown_session", "unknown_credit_request", "unknown_tender",
]);
const FORBIDDEN_CODES = new Set<BillingErrorCode>(["credit_permission_required", "not_your_session"]);
/** Client-input refusals. Everything else is a state/ledger conflict and answers 409. */
const VALIDATION_CODES = new Set<BillingErrorCode>([
  "invalid_paise", "pan_required", "tender_ref_required", "bank_transfer_required",
  "recon_parse_failed", "duplicate_ref", "recount_reason_required",
  /*
    FD-35 — a 400 rather than the default 409, because nothing is in conflict in the LEDGER: the
    request itself is contradictory, two ids naming two people. The code travels in the body, so a
    screen can still tell it apart from a malformed payload and say which two people it was handed.
  */
  "patient_encounter_mismatch",
  // OWNER RULING 2026-09-28 — the request itself carries what the hospital may not keep.
  "aadhaar_not_stored",
  // OWNER RULING 2026-09-30 — the request itself asks for what cannot be given.
  "pharmacy_bill_only", "sale_discount_refused",
  // OWNER 2026-10-05 — a price proposal that changes nothing.
  "consult_price_unchanged", "consult_price_reason_required",
]);

export function billingHttpStatus(code: BillingErrorCode): number {
  if (NOT_FOUND_CODES.has(code)) return 404;
  if (FORBIDDEN_CODES.has(code)) return 403;
  if (VALIDATION_CODES.has(code)) return 400;
  return 409;
}
