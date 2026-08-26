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

/**
 * PLAN 09 CLOSE REMEDIATION (owner-authorised 2026-08-26) — THE WIRE STATUS FOR A MEMBERSHIP
 * REFUSAL, AND IT LIVES HERE BECAUSE TWO CONTROLLERS NEED IT.
 *
 * T3 wrote this mapping privately inside `membership.controller.ts`, which was right while
 * membership was the only module that could raise one. T4 then wired `resolveInstruments`,
 * `consumeEntitlements` and `redeemCoupon` into `issueInvoice` — so a `MembershipError` now
 * escapes through `billing.controller.ts` too, and THAT controller's `toHttp` had no clause for
 * it. Every one of this union's codes reached the counter as a **500**.
 *
 * The one that will actually happen: a member with one free consult, billed for two consults on a
 * single invoice, is refused whole with `entitlement_exhausted` — correct behaviour, and the clerk
 * saw an unexplained server error instead of "split the bill". `MEMBER_BENEFITS_ENABLED` is what
 * arms it, so this landed before any flip.
 *
 * It is EXPORTED and shared rather than copied because a second hand-maintained copy of one fact
 * is §2.54's defect exactly: the two would drift, and the drift would be invisible until a code
 * answered 404 on one route and 409 on the other.
 */
export function membershipHttpStatus(code: MembershipErrorCode): number {
  if (code === "lookup_rate_limited") return 429;
  if (NOT_FOUND_CODES.has(code)) return 404;
  if (VALIDATION_CODES.has(code)) return 400;
  return 409;
}

const NOT_FOUND_CODES = new Set<MembershipErrorCode>([
  "unknown_instrument", "unknown_plan", "unknown_member", "unknown_counter", "unknown_coupon",
  "redemption_not_found", "match_candidate_unknown",
]);
const VALIDATION_CODES = new Set<MembershipErrorCode>(["import_columns_unknown", "import_range_inverted"]);

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
