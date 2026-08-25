/**
 * The membership module's error vocabulary.
 *
 * ═══ THIS UNION IS CLOSED FOR THE WHOLE OF PLAN 09, AND THAT IS A FACT ABOUT THE PIPELINE ═══
 *
 * `errors.ts` is named in T1's Files list and in NO other task's. T2–T5 all modify
 * `modules/membership/index.ts`, and several modify `manifest.ts`, `events.ts` and the controller
 * — but none of them may commit a change here. So every refusal this phase can make is spelled
 * below, ahead of its caller, rather than one code at a time as each lane lands. A later task
 * that needs a code this union does not carry has found a PLAN DEFECT and reports it; it does not
 * widen the union, and it does not smuggle the refusal through a neighbouring code.
 *
 * The shape (a `code` the HTTP layer maps, an optional `detail` carried to the body) is
 * `BillingError`'s, deliberately: the counter already knows how to render one of these.
 */
export type MembershipErrorCode =
  // ── recognition (T3) ────────────────────────────────────────────────────────────────────────
  | "unknown_instrument" | "unknown_plan" | "unknown_member"
  | "instrument_not_valid" | "instrument_expired" | "instrument_suspended" | "instrument_unverified"
  | "lookup_rate_limited" // DD15 — the refusal is an EVENT, never an audit row
  | "grace_honor_approval_required" | "approval_subject_mismatch"
  // ── entitlements and coupons (T2, T4) ───────────────────────────────────────────────────────
  | "unknown_counter" | "counter_lapsed" | "entitlement_exhausted"
  | "unknown_coupon" | "coupon_expired" | "coupon_not_yet_valid" | "coupon_out_of_window"
  | "coupon_not_applicable" | "coupon_min_bill_not_met" | "coupon_already_redeemed"
  | "redemption_not_found" | "redemption_already_released"
  // ── family and caps (O-3, O-5) ──────────────────────────────────────────────────────────────
  | "family_cap_exceeded"
  // ── the holder-book import and the reconcile queue (T5) ─────────────────────────────────────
  | "import_columns_unknown" | "import_row_quarantined" | "import_duplicate_key"
  | "import_already_applied" | "import_range_inverted"
  | "match_already_resolved" | "match_candidate_unknown"
  // ── the structural-OFF lanes (DD14) ─────────────────────────────────────────────────────────
  | "sales_disabled" | "benefits_disabled" | "coupon_issuance_disabled";

export class MembershipError extends Error {
  constructor(
    readonly code: MembershipErrorCode,
    message?: string,
    readonly detail?: unknown, // e.g. cap-vs-asked, the window that was missed — carried to the body
  ) {
    super(message ?? code);
    this.name = "MembershipError";
  }
}
