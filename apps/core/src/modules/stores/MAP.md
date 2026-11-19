---
type: module-notes
title: "stores — module notes"
description: "Why and traps of the non-drug Stores module: one item master and one ledger shared with pharmacy, department shelves charged at receipt, department-scoped acts, append-only corrections."
resource: apps/core/src/modules/stores
tags: [stores, materials, procurement]
generated: { by: agent:claude, at: 2026-11-18 }
verified: []
stale_after: 2027-02-18
---
# stores — module notes

Hand-written notes: the WHY and the traps. Signatures, routes and tables are generated in
`docs/architecture/modules/stores.md`. Paths are relative to `apps/core/src/modules/stores/` unless they start
with a module name, `kernel/`, `packages/` or `apps/`. Citations name a file and a symbol, never a line number.
Owner rulings: `docs/decisions/` 0099 (Stores & Procurement), 0027 (materials core), 0081 (done-means tests).
Specs: `docs/specs/stores-programme.md`, `docs/specs/1111-stores-masters-shelves.md` (S1, built).

## 1. Purpose
One master register for every non-drug item the hospital keeps ("even a dustbin"), the central store, and the
department shelves every department (housekeeping included) receives from. Pharmacy is separate.

## 2. The one-ledger rule (programme §3)
- Stores owns NO stock quantity and NO item table. An item is an `items` row (`materials.registerItem`) plus the
  S1 columns `category_id`, `track_mode`, `search_aliases`, `patient_billable` (`kernel/db/schema/materials.ts`).
  "A Stores item" = `track_mode is not null and class <> 'drug'` (`items.ts` `storesItemWhere`).
- Every quantity is a `stock_ledger` row posted through `materials` (`postMovements`, `receiveStock`,
  `postOpeningBalances`). Stores imports materials only through `materials/index.ts`.
- Materials changes are ADDITIVE only (pharmacy is live on the same functions): `receiveStock`'s optional
  `opts.costCenter` / `opts.throughStores`, `writeStockLevel` (the body of `setStockLevel` in the caller's tx),
  `materials/opening-balances.ts`, and the refusal `shelf_receives_through_stores`.

## 3. Places (decision 6)
- Every Stores place is a registry `store` resource with `attributes.domain = 'stores'` and `attributes.kind`
  (`central` | `sub` | `night` | `shelf`). `access.ts` `isStoresStore` is the one predicate; pharmacy stores carry
  no domain and are never listed here.
- The other way round: `materials/stores.ts` `listStores` leaves every `domain = 'stores'` row out unless the caller
  passes `includeStoresDomain: true` (only `shelves.ts` does), so pharmacy's pickers and lists never show a Stores
  place. `POST /materials/transfers` refuses a Stores place as source or destination (`moves_through_stores`,
  `materials/transfers.ts` `refuseStoresPlacesOnMaterialsRoute`); the Stores intents call the materials functions.
- `GEN-MAIN` (custodianRoles `storekeeper`) and `GEN-NIGHT` are seeded by `seedStoresMasters`, called from
  `scripts/seed-materials.ts` (runs on every deploy; idempotent).
- A shelf's parent is its FLOOR (kernel `floor` resource); it carries `departmentId`, `departmentCode` (the cost
  centre) and `suppliedBy` (a non-shelf Stores store).

## 4. Who may (decision 7) — the trap that shaped it
- `usersHoldingRole` (the materials keeper check) ignores scope, and `receiveStock` checks no permission. So a
  shelf names no keeper, and `materials/transfers.ts` `receiveStock` REFUSES a receipt into a shelf unless the
  caller passes `throughStores` — only `use.ts` `receiveAtShelf` does, after `requireShelfAct`.
- Shelf acts ask `stores.shelf.read` / `.work` AT the shelf's department (`access.ts` `requireShelfAct`, the
  roster precedent). A hospital-scoped holding passes any department; there is no second fallback call.
- Shelf routes carry no `@RequirePermission` (the department is a fact of the shelf); masters routes carry
  `stores.masters.manage` at hospital scope.

## 5. Money and use (decisions 8, 9, 13)
- Charge at issue: the receipt rows into a shelf carry the department's org code as `cost_center` (both legs).
  `reads.ts` `departmentChargeOn` = Σ qty × `stock_batches.landed_cost_paise` over receipt rows INTO shelves.
- `expensed` items are consumed in the receipt's transaction (`ref_type = 'expensed_on_receipt'`); balance 0.
- "Used" = `consume`, `ref_type = 'shelf_use'`. The check posts the shortfall as `consume`,
  `ref_type = 'shelf_check'`; a count above book posts nothing and is a card (the check event's
  `reason = 'more_than_book'`; `overBookCards` reads it). A durable item counted short is reported, not posted.
- Use rates are NET of reversals. Per OPD visit counts `opd_encounters` of the org department's clinic; per
  bed-day is null until IPD is on production (owner 2026-10-13).

## 6. Audit (decision 16, programme §0A)
- Every state-changing act appends ONE `stores.act_recorded` event (`events.ts`; `access.ts` `recordAct`) with
  act, store, item, before/after and reason. Many-line acts carry `lines`.
- `stock_ledger` is append-only IN THE DATABASE (migration 0237 trigger `stock_ledger_append_only`). A correction
  is `use.ts` `reverseShelfUse`: one `adjust` row, `ref_type = 'reversal'`, `ref_id` = the original; at most once
  (advisory lock + lookup). TRAP: a later migration that backfills ledger rows must drop and re-create the trigger
  in the same file. `truncateAll` (TRUNCATE) is unaffected.

## 7. Not built here (S1 scope)
Tickets, HOD approval, custody, porters (S2 #1112); gate passes (#1119); tower/concierge (S3); tagged units (S4);
purchasing (S5). The reorder draft is saved as an event (`reorder_draft`); S2 turns it into a ticket.
