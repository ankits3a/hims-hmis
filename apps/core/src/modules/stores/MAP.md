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
`docs/specs/1112-stores-tickets-custody.md` (S2, built: S2a and S2b).

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
  receive from rows; minutes = since the step before. S2b adds the chain (take, hand_over, take_over, return_accepted),
  deliver / collect ("Collected at store" = no carrier leg), send_back, return_undelivered and each short's resolution.
  A hand-off whose phone time and server time differ by more than 5 min carries both (`phoneAt`, `recordedAt`).
- `storesAuditPack` (`audit-pack.ts`) reads the events table only: `stores.act_recorded` + `material.*`, by window on
  `occurred_at`, filters ANDed. Writes ONE `audit_export` act per call, after the read. TRAP: an event dated by the
  wall clock falls outside a stated window — `materials/transfers.ts` now dates `material.issued/received/
  discrepancy_flagged` by the movement's `occurredAt` (S2a).

## 9. The custody chain (S2b #1112, `custody.ts`, `chain.ts`)
- `stores_custody_handoffs` is APPEND-ONLY in the database (migration 0239 trigger). Kinds: `take` (issuer or a
  take-over holder → porter, the porter's scan), `hand_over` (porter → porter, the INCOMING porter's scan naming
  `fromUserId`, which must be the holder), `take_over` (source keeper or `stores.masters.manage`, reason required,
  names the holder it overrides), `return_accepted` (holder → source keeper). Holder = newest row's `to_user_id`,
  else the transfer's issuer (`chain.ts` `holderOf`). The LEDGER IS UNTOUCHED by hand-offs.
- The label QR carries the indent number only; the typed fallback is its last four digits, matched among tickets on
  their way that the act admits (`ticketByCode`): none = `unknown_ticket`, two = `ambiguous_code`.
- Scans: `stores_client_keys` (actor, key) records once; `scanClock` keeps the phone time (`phone_at`), dates the row
  by it unless it is in the future (then server time), flags `late` (> 12 h) / `future`, and tells the source keepers
  "Late scan to confirm" (`stores_scan_confirmations`, `confirmLateScan`).
- `deliverTicket` refuses the issuer (`you_issued_it`) and every carrier (`you_carried_it`) BEFORE the shelf grant;
  per ticket line accepted/short/wrong/damaged = issued, split over the batches (`planDelivery`). Only `accepted` goes
  through `receiveAtShelf` (charged). Wrong/damaged become `sent_back` rows in `stores_transit_resolutions`
  (wrong → source, damaged → materials `QUARANTINE`), moved by the source keeper's `acceptReturn`. Notice
  precedence: sent back, then short, then "Delivered".
- Shorts stay in IN-TRANSIT against the last custodian; `resolveShort` (materials head): found = materials
  `receiveLate` into the shelf (charged then), returned = `returnInTransit` (`authorisedBy: "stores"`), lost =
  `requestApproval(materials_stock_adjustment)` and NOTHING posts until `postTransitLoss` after the grant (one
  `adjust` row, `ref_type = 'transit_loss'`). DECIDED: a Stores row, not a `stock_adjustments` row (that table needs
  a count line).
- Undelivered: the holder's `returnUndelivered` (pending rows) → the keeper's `acceptReturn` → transfer `returned`
  (new value of `transfers_status_ck`, written by no pharmacy path). What is left in transit on a line is read off
  the ledger (`materials.inTransitByLine`), never stored.
- Back-order: `reAskShort` raises a linked `re_ask` ticket with NO approval stamp (`approval_required = false`, it
  rides on the first's approval) on the first's clock; `ticketsToPick` lists it only when the store holds every line.
- Department returns (`raiseReturn` / `receiveReturn`): a transfer shelf → supplier (defective → quarantine), note
  `stores return …`; the store's receipt carries the department's cost centre, so `departmentChargeOn` nets it
  (receipts into shelves +, into any other store −).
- "Add to open ticket?": `openTicketFor` + `addToOpenTicket` (materials `addIndentLinesScoped`); an item already on
  the ticket is left off (an item is once per indent; 0155's line guard forbids raising a quantity).
- The issue voucher (`voucher.ts`, document `stores_issue_voucher`, destination `stores_a4`) is queued in
  `issueTicket`'s transaction; renderer registered in `StoresModule.onModuleInit`.

## 10. Not built here
Gate passes (#1119); tower/concierge/"Stuck" and the end-of-shift red card (S3); an offline scan queue (native
staff app); choosing which porter to send; a porter picker for the hand-off (the web card takes the outgoing
porter's id); tagged units (S4); purchasing (S5).
