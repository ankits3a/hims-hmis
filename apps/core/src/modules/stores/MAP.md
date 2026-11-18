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
Specs: `docs/specs/stores-programme.md`, `docs/specs/1111-stores-masters-shelves.md` (S1, built),
`docs/specs/1112-stores-tickets-custody.md` (S2; S2a built here, S2b owed).

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

## 7. Tickets (S2a #1112, `tickets.ts`)
- The ticket IS the materials indent (decision 1): `raiseTicket` → `materials.raiseIndentScoped` (caller-authorised,
  runs in OUR tx) + one `stores_ticket_details` row (department, shelf, priority, channel, needed-by, deliver-to,
  emergency reason, `night`, origin link, `clock_from`). Shelf = indent `from`; supplying store = indent `to`.
- Approval is the indent's own stamp (`store_indents.approval_*`, `store_indent_lines.qty_approved`), written by
  `materials.stampIndentApproval`. WRITE-ONCE in the database: migration 0238 REPLACES 0155's `store_indent_guard` /
  `store_indent_line_guard` (same refusals plus exactly the stamp transitions). A decline closes the indent as
  `rejected` with the approver as `decided_by` in the same update; stage `declined` = rejected + decision declined.
- `materials.issueIndent` refuses `indent_not_approved` when `approval_required` and no decision and not
  `issue_before_approval` (emergency). A pharmacy indent has `approval_required = false`, so it never refuses one.
  Issue up to `qty_approved ?? qty_base`.
- Who approves: `stores.indents.approve` AT the department (HOD); a hospital-scope holding (the MS) is the stand-in,
  `forHod = not assigned at the department`. Never the requester (`own_ticket`).
- Night (decision 5): an emergency raised outside the central store's `serviceHours` (IST, `withinServiceHours`) goes
  to the night store whose `suppliedBy` is that central store. Issuing from a night store with
  `stores.nightstore.issue` goes through `materials.issueIndentScoped`; anyone else goes through `issueIndent`
  (so a storekeeper is refused `not_store_keeper` by the custodian check).
- Picking claim: `stores_picking_claims` is insert-only; the live claim is the newest one younger than 30 min
  (`CLAIM_IDLE_MS`). A claim needs approval (or emergency); issue is refused while another keeper's claim is live.
- Every act appends one `stores.act_recorded` (refId = indent id) and raises its notices (`raiseNotice`, key
  `stores-ticket:<id>:<step>`) in the same tx. Approvers are told on raise (the department's; if none but the
  requester, the hospital-scope stand-ins). Requester: Approved / Not approved (never the reason) / On the way.

## 8. Reads, Now cards, timeline, audit pack
- `stage` is derived (`stageOf`), never stored. `ticketsToApprove` / `ticketsToPick` / `ticketsToReceive` are the one
  read behind both the desk card (`desk.ts` `load`, gated at hospital scope by the kernel) and the waiting line
  (`waiting`, `waitingSelfGated` — the only way a DEPARTMENT-scoped HOD sees it; roster-leave precedent). Waiting kinds
  `stores.indentsToApprove|toPick|toReceive` live in `packages/contracts/src/waiting.ts`.
- `ticketTimeline` (`timeline.ts`) derives raise, approve/decline ("for HOD"), claims, issue, review, reject, cancel,
  receive from rows; minutes = since the step before. S2b adds hand-offs from `stores_custody_handoffs`.
- `storesAuditPack` (`audit-pack.ts`) reads the events table only: `stores.act_recorded` + `material.*`, by window on
  `occurred_at`, filters ANDed. Writes ONE `audit_export` act per call, after the read. TRAP: an event dated by the
  wall clock falls outside a stated window — `materials/transfers.ts` now dates `material.issued/received/
  discrepancy_flagged` by the movement's `occurredAt` (S2a).

## 9. Not built here
Custody chain, porters, counter collection, delivery with wrong/damaged, shorts, back-order, undelivered and
department returns, late scans, the delivered notices (S2b, #1112); "Add to open ticket?" on the raise sheet; the
issue voucher + label QR print; gate passes (#1119); tower/concierge/"Stuck" (S3); tagged units (S4); purchasing (S5).
