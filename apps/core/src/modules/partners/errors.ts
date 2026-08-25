/**
 * The partners module's error vocabulary.
 *
 * ═══ CLOSED FOR THE WHOLE OF PLAN 09, for the same pipeline reason as membership's ═══
 *
 * This file is named in T1's Files list and in no other task's, while T6, T7 and T8 all modify
 * `index.ts` and `manifest.ts`. Every refusal the accrual consumer, the reconciliation lane and
 * the P&L read model can make is therefore spelled below, ahead of its caller. A later task that
 * needs a code this union does not carry has found a PLAN DEFECT and reports it rather than
 * widening the union or borrowing a neighbouring code.
 */
export type PartnersErrorCode =
  // ── counterparties and agreements (T6) ──────────────────────────────────────────────────────
  | "unknown_counterparty" | "unknown_agreement" | "no_effective_agreement"
  | "counterparty_suspended" | "counterparty_terminated"
  /**
   * DD4's attempt path. The database refuses the row outright — that is the point of the composite
   * FK — so this code exists for the layer that must EXPLAIN the refusal, and it rides the
   * `payout.class_blocked` event.
   */
  | "payout_class_blocked"
  // ── the ledger (T6) ─────────────────────────────────────────────────────────────────────────
  | "unknown_invoice" | "unknown_subject" | "accrual_replay_conflict" | "period_closed"
  | "unverified_attribution" // C-17: verify before accrual eligibility
  // ── attribution, statements and reconciliation (T7) ─────────────────────────────────────────
  | "unknown_attribution" | "attribution_expired" | "attribution_partner_mismatch"
  | "duplicate_partner_ref" | "unknown_partner_ref"
  | "statement_columns_unknown" | "statement_already_imported" | "statement_line_unmatched"
  | "expectation_state_conflict" | "unknown_expectation"
  // ── the structural-OFF lanes (DD14) ─────────────────────────────────────────────────────────
  | "accrual_disabled" | "receivable_disabled";

export class PartnersError extends Error {
  constructor(
    readonly code: PartnersErrorCode,
    message?: string,
    readonly detail?: unknown, // e.g. the class that blocked, the period that is closed
  ) {
    super(message ?? code);
    this.name = "PartnersError";
  }
}
