/**
 * THE cross-module interface of the partners module (spec §4). Later modules import from here or
 * consume events — never internals.
 *
 * The import direction is FIXED and it is DD1's whole reason for two modules rather than one:
 * `partners → billing` (the accrual consumer reads an invoice's live money through DD19's
 * `invoiceAccrualView`), `billing → membership` (the pricing integration reads resolved
 * instruments). Put both halves in one module and those two facts become a cycle through
 * `billing/index.ts` that no lint rule would refuse and that would surface as a runtime
 * `undefined` in the money path, under a green suite.
 *
 * Plan 09 fills this in task order: T6 the accrual consumer, the agreements resolver and the
 * replay job; T7 attribution, statements and reconciliation; T8 the identity-free exports and the
 * channel P&L.
 */
export { partnersManifest } from "./manifest";
export { PartnersModule } from "./partners.module";
export { PartnersError } from "./errors";
export type { PartnersErrorCode } from "./errors";
export * from "./events";

// ── T6 — the accrual lane (DD6, DD7, DD12, O-6, O-7) ──────────────────────────────────────────
//
// `accrualConsumer` is exported for `kernel/worker/worker.module.ts`'s `workerConsumers(db)`, and
// it is the ONE importable place the production handler exists — the same discipline Plan 10 T5
// bought for `notifyConsumer`, and the reason `worker-runtime.e2e.test.ts` can assert the wire at
// all rather than trusting a literal typed out in an entry point nothing may import.
export {
  accrualBasis, accrualLedger, appendAccrualDelta, attributeInvoice, escrowedTotalPaise,
  payableTotalPaise,
} from "./accrual";
export type {
  AccrualAttribution, AccrualBasis, AccrualLedgerRow, AppendAccrualInput, AppendAccrualResult,
} from "./accrual";
export {
  accrualTermsSchema, counterpartyFacts, rateSnapshotOf, requireAgreementAt, resolveAgreementAt,
} from "./agreements";
export type { AccrualTerms, CounterpartyFacts, ResolvedAgreement } from "./agreements";
export {
  ACCRUAL_EVENT_NAMES, PARTNERS_ACCRUAL_CONSUMER, accrualConsumer, commissionAccrualEnabled,
  handleAccrualEvent,
} from "./consumer";
export type { AccrualOutcome } from "./consumer";
export { replayAccruals } from "./replay";
export type { ReplayCounts, ReplayOptions } from "./replay";
export {
  countActivations, kickerBonusPaise, periodBounds, periodKeyFor, periodSettled, recomputeKicker,
} from "./kicker";
export type { KickerRecomputeInput, KickerRecomputeResult, PeriodKind } from "./kicker";
