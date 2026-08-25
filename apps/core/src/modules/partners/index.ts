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
