import type { ResourceKindDecl } from "../../kernel/resources/kinds";

/**
 * PLAN 14 T2 / DD2 — THE `store` KIND, CLAIMED BY THE MODULE THAT OWNS THE LEDGER KEYED ON IT.
 *
 * ═══ WHY THIS FILE EXISTS AT ALL, AND WHY IT IS ONE DECLARATION ═══
 *
 * Plan 13 built the kind seam so that a module can claim a kind with NO kernel edit — `store` is
 * already among the ten `RESOURCE_KIND_VALUES` and already admitted by `resources_kind_ck`. Plan
 * 13's own docstring said *"Plan 16 adds `store`"*. **This document moves that claim to Plan 14**,
 * and the reason is the one the kind seam exists to enforce: `stock_balances`, `stock_ledger`,
 * `stock_reservations`, `transfers`, `grns` and `consignment_lots` are all keyed on a `store`-kind
 * resource and all six live here. A kind claimed by a module that does not own the tables keyed on
 * it is two homes for one concept — which is the trap the registry was built to close, sprung one
 * level up.
 *
 * Pharmacy (16c) declares no kind of its own; it creates its stores through this module's
 * `createStore` (§ 4A item 2's ruling: one ledger, in `materials`; pharmacy is a consumer).
 *
 * ═══ EVERY STOCK LOCATION IS A RESOURCE, INCLUDING THE ONES THAT ARE NOT PLACES ═══
 *
 * Central stores, sub-stores, the OT's consignment bin, the quarantine bin — and **`IN-TRANSIT`**,
 * one per site, created lazily by `ensureTransitStore` (T5, DD9). The transit store is a real row
 * with a real balance because a two-sided issue must be able to answer "where is the stock right
 * now" between the two signatures, and "nowhere" is the answer that loses a carton. `listStores`
 * excludes it by code, in ONE predicate in ONE reader (Plan 13 DD9's discipline).
 *
 * ═══ `occupied: null` IS THE DECISION IN THIS DECLARATION ═══
 *
 * Every other field here is the container vocabulary `floor`/`ward`/`hall` already use. `occupied:
 * null` says **a store is NOT ASSIGNABLE**, and `assignResource` refuses it with `not_assignable`
 * rather than quietly setting an occupant (Plan 13 T3). That is not a technicality: a store's
 * CONTENTS are the ledger's business, tracked per `(resource, batch)` in `stock_balances`, and an
 * `occupant_ref` on a store would be a SECOND, weaker answer to "what is in here" — one that holds
 * a single id where the real answer is a set of batches with quantities. The registry's occupancy
 * triad is for things that hold ONE occupant at a time; a store never does.
 *
 * `retired` rather than a delete or an `active` flag, per Plan 13's DD2: one state column cannot
 * disagree with itself. A retired store keeps its ledger history — the movements that happened
 * there happened — and every picker excludes the retired status.
 *
 * **`blocked` is the third status and it is not decorative**: a store under a recall hold, or one
 * whose cold-chain has failed, must be visibly out of service without losing its stock. Nothing in
 * THIS phase writes it (there is no `blockStore`), and it is declared now because a status word is
 * written into `resource_status_history` for ever and adding one later is a vocabulary migration.
 */
export const MATERIALS_RESOURCE_KINDS: readonly ResourceKindDecl[] = [
  {
    kind: "store",
    statuses: ["available", "blocked", "retired"],
    initial: "available",
    /** NOT ASSIGNABLE — see the header. A store's contents are `stock_balances`, not an occupant. */
    occupied: null,
    onRelease: "available",
    retired: "retired",
  },
];
