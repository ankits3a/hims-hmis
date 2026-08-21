export type BillingErrorCode =
  | "billing_not_configured" | "invalid_paise" | "unsettled_issue_refused"
  | "credit_permission_required" | "credit_approval_required" | "outstanding_cap_exceeded"
  | "discount_approval_missing" | "approval_subject_mismatch"
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
