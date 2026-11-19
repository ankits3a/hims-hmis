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
`docs/specs/1112-stores-tickets-custody.md` (S2, built: S2a and S2b), `docs/specs/1119-stores-gate-passes.md` (S2c, built),
`docs/specs/1113-stores-control-tower.md` (S3, built), `docs/specs/1114-stores-asset-passport.md` (S4, built: S4a and S4b).

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

## 7. Tickets (S2a #1112, `tickets.ts`)
- The ticket IS the materials indent (decision 1): `raiseTicket` → `materials.raiseIndentScoped` (caller-authorised,
  runs in OUR tx) + one `stores_ticket_details` row (department, shelf, priority, channel, needed-by, deliver-to,
  emergency reason, `night`, origin link, `clock_from`). Shelf = indent `from`; supplying store = indent `to`.
- Approval is the indent's own stamp (`store_indents.approval_*`, `store_indent_lines.qty_approved`), written by
  `materials.stampIndentApproval`. WRITE-ONCE in the database: migration 0238 REPLACES 0155's `store_indent_guard` /
  `store_indent_line_guard` (same refusals plus exactly the stamp transitions). A stamp is written WHOLE with its
  decision: a reason or note on its own is refused. `stores_ticket_details` is append-only (trigger
  `stores_ticket_details_append_only`); `stores_picking_claims` carries no trigger (rows are only ever inserted).
  The `/materials/indents` routes refuse a Stores ticket (`moves_through_stores`). A decline closes the indent as
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
- `storesAuditPack` (`audit-pack.ts`) reads the events table only: `stores.act_recorded` + the `material.*` events
  whose source, destination or store is a Stores place (pharmacy's stay out), by window on `occurred_at` (and
  `recorded_at` ≥ from − 24 h, which prunes the monthly partitions), filters ANDed. At most `AUDIT_PACK_MAX_ROWS`
  (5000) per pack: past that it returns `truncated` + `nextAfterSeq` (query `afterSeq`) and the CSV's last line says
  so. CSV cells that start like a spreadsheet formula get a leading quote (`csvCell`). There is no index on
  `events.occurred_at`; `events_name_idx` and the partition pruning carry the query.
  Writes ONE `audit_export` act per call, after the read. TRAP: an event dated by the
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
- Scans: `stores_client_keys` (actor, key) records once; `scanClock` always keeps the phone time (`phone_at`) and
  dates the act by it ONLY when it is at most 12 h old and not before the floor (`scanFloor`: the transfer's issue or
  its newest hand-off); otherwise the act (hand-off, receipt, ledger rows, charge) is dated at the server's time and
  flagged `late` / `future`. A flagged hand-off or receipt tells the source keepers "Late scan to confirm"
  (`lateScansToConfirm`, `confirmLateScan`; a receipt's id there is its transfer's, `stores_delivery_lines.flag`).
  TRAP: a backdated receipt would otherwise land before its issue or in a closed month's department charge.
- Guards in the database (0239): `stores_custody_handoffs` and `stores_delivery_lines` append-only;
  `stores_transit_resolutions` takes one change, `pending` → `posted` (by/at) or `refused`, nothing else.
  `stores_scan_confirmations.handoff_id` has no foreign key (a hand-off id or a transfer id).
- `/materials/transfers/:id/receive` refuses a Stores transfer (`moves_through_stores`): a department return is
  received by `receiveReturn`, which writes the department's credit.
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
- UX pass: `custodyLookup` (`GET custody/lookup?code=`, carriers only) names the ticket AND its holder before any
  write, so the porter card is Scan → "Taking from <name>" → Take, and posts `fromUserId` itself; `already_yours`
  when it is the reader's. `ticketsComingBack` (`GET tickets/coming-back`, declared before `tickets/:indentId`)
  lists pending sent_back / undelivered for the keeper's one-tap `acceptReturn`. Now card `stores.back` ("To take
  back") counts those + department returns + late scans and opens `/stores/pick`, where each is one tap.
- The issue voucher (`voucher.ts`, document `stores_issue_voucher`, destination `stores_a4`) is queued in
  `issueTicket`'s transaction; renderer registered in `StoresModule.onModuleInit`.

## 9a. UX pass from the browser walk (2026-11-19)
- `shelfTickets` (`GET shelves/:shelfId/tickets`, the shelf's read grant) backs the shelf's "My tickets"; newest 20.
- `whoToAsk` (`GET who-to-ask?shelfId=|indentId=`) names the department's approvers (else shelf in-charges, else the
  hospital stand-ins) for a refused reader; any signed-in user may read it (names only), so a refusal is never a dead end.
- Web: every Stores root wears `stores-ui` (`apps/web/src/screens/stores.css`: bordered fields, focus ring, faded
  disabled buttons). The `/stores` nav row also shows for a grant held at ANY scope (`heldAnywhere`, `anyScope`).
  Notices with `refType = store_indent` open the timeline (alerts-bell `DEEP_LINKS`).

## 10. Gate passes (S2c #1119, `gate-pass.ts`, `gate-pass-print.ts`)
- The pass (`stores_gate_passes` + `stores_gate_pass_lines`) is written ONCE at raise; its life is the gate log
  `stores_gate_pass_scans` (kinds `exit`, `entry`, `close`). All three tables are append-only in the database
  (migration 0240 triggers). Status (raised / out / overdue / back / closed) is DERIVED from the log and the ledger,
  never stored.
- Returnable (repair, calibration, refill, loan): the guard's exit scan FEFO-picks at the source store and posts
  source − / `OUT-ON-PASS` + (`reason = 'issue'`, `ref_type = 'gate_pass'`, `ref_id` = pass); an entry scan posts the
  reverse (`reason = 'receive'`) for what came back, per batch in the order it went out. What is still out is READ OFF
  THE LEDGER at OUT-ON-PASS (`outstanding`), never stored. `OUT-ON-PASS` is materials `ensureOutOnPassStore`
  (additive, the quarantine store's shape; no keepers; not a Stores store, so no Stores picker lists it). It is a
  Stores system store (`materials/stores.ts` `STORES_SYSTEM_STORE_CODES`): out of pharmacy's `listStores` and refused
  on `/materials/transfers`, like QUARANTINE.
- Non-returnable: only against a supplier return that is dispatched (or later: credited, closed) or a posted
  write-off; its lines and party are COPIED from that record; one live (unclosed) pass per record (advisory lock).
  The exit scan posts no ledger row. S4's scrap sale joins `ref_type` later (a new CHECK value).
- Who: `stores.gatepass.raise` (storekeeper, materials head) raises, prints, closes; `stores.gatepass.scan`
  (`security_guard`, the IPD train's key and title) looks up and scans. The raiser is refused as scanner (`own_pass`)
  even when they also hold the scan grant. Close is only before the exit (`already_out` after).
- Scan: the QR carries `MGP…` only; typed = last four digits among passes still in play (`ambiguous_code` on two).
  Idempotency is the scan row itself: unique `(actor_id, client_key)`; a key seen before answers `duplicate: true`.
  `scanClock` (custody.ts) keeps the phone time and dates the crossing (ledger rows included) by it only within 12 h
  and not before the pass's raise or its last scan (an entry after its exit); otherwise server time, flagged
  `late` / `future`; the view's scan carries `phoneAt`. A late gate scan is NOT sent to a keeper
  to confirm (no "Late scan to confirm" for passes: the guard's log is the record).
- Audit: each act is one `stores.act_recorded` (`raise_gate_pass`, `gate_pass_out`, `gate_pass_in`, `close_gate_pass`)
  with `storeId` = OUT-ON-PASS, `refId` = pass, and the SOURCE store on every line; `storesAuditPack`'s store filter
  also matches `lines @> [{storeId}]`, so a pass is found by either store.
- Overdue: `overdueGatePasses` (returnable, out, due-back day < today IST). The raiser's "Pass overdue" notice is sent
  by `notifyOverdueGatePasses` (idempotent source key), called from the Passes list read; S3's sweep should call it
  on a schedule. TRAP: until S3, nobody is told unless someone opens the Passes tab.
- Print: `stores_gate_pass` → `stores_a4`, queued in the raise's transaction; the store's browser prints the same
  render from `GET gate-passes/:id/print` (the kernel `print/jobs/:id/document` route needs `opd.paper.reprint`,
  which a storekeeper does not hold). If a relay is ever installed at the store, "Print pass" on a counter set to
  `relay` mode prints nothing in the browser.
- Web: `/stores/gate` (guard, opens on the camera, typed last four beside it, one primary Let out / Let in, partial
  return by lowering a line) and `/stores/passes` (rows overdue first; New pass is one screen; then Print pass).

## 10a. The control tower, the chaser and the concierge (S3 #1113)
- `tower.ts` `boardCards(db, now, indentIds?)` is THE read: every open ticket's card (lane, holder, minutes, the
  broken clock), derived each time from the indent, stamp, claims, transfer, hand-off log, delivery and resolutions.
  The tower (`towerView`), the owner's line (`towerSummary`), the Stuck Now card (`desk.ts` `storesStuckDesk`), the
  chaser and the concierge all call it, so none can disagree. Inner join on `stores_ticket_details`: no pharmacy indent.
- Lanes: an emergency issued-first waits on Approved/Picking (its pick clock is 10 min from raise), never Requested.
  Delivered = received TODAY (IST); an older delivered ticket is on the board only while a clock runs (open short
  24 h, emergency review 24 h). `CLOCKS` holds decision 2; stuck = elapsed >= the clock; Stuck wins.
- Custody clock (2 h) runs when the last hand-off is a carrier kind; else the 30-min leg. Minutes use
  `Math.round`, as `myCustody` does (D2 pins them equal).
- Floor map / Out: only items with a par AT the shelf count (an expensed item always reads 0). A department on
  several floors shows under each. Red cards: stuck, short (not yet stuck), out shelves, overdue passes (from the
  end of the due-back day), "More than book" checks of the last 24 h; oldest first, the strip takes 8.
- Spend (`departmentSpendByMonth`): `departmentChargeOn`'s rule by IST month, grouped by cost centre; the `spend`
  key is ABSENT (not null) without `stores.spend.read`.
- `chaser.ts` `runStoresChaser` rides the worker's every-minute `sweepStaffNotices` job (no new job name in the
  census). `stores_nudges` (migration 0241) PK (ticket, step) is the "one nudge per step" guarantee: insert first
  `on conflict do nothing`, bells only for the won row, same tx. Steps `approval`, `pick`, `leg:<n>`. It also calls
  S2c's `notifyOverdueGatePasses`, so "Pass overdue" no longer waits for someone to open the Passes list.
  Each ticket's nudge runs in its own try/catch (pre-merge review S4): a failure is logged (`stores-chaser`) and
  counted in `run.failed`, writes no `stores_nudges` row (so the next minute retries it), and never stops later
  tickets or the overdue-pass notices.
- Concierge: `copilot-intents.ts` (cue-routed only, no menu), `copilot-tools.ts` (six reads), `copilot-acts.ts`
  (`stores.reorder`). Department-scoped grants: the tools declare `scopedGate` (`kernel/copilot/catalog.ts` admits a holder at
  ANY scope; each tool narrows to `myShelves` / `holds(…, dept)` or everything for `stores.tower.read`).
- The masker keeps `MIN` and masks the digits (`MIN<<P1>>`); the cue `min<<` is what routes a ticket question. The
  slot holds digits only: `indentNoOf` puts the prefix back. A bare `<<P1>> kahan hai` (a UHID) does NOT route here.
- Reorder: recheck = an open (`requested`) ticket at the shelf, or a changed draft → "State changed". apply = 
  `raiseTicket` (channel `copilot`) + one `copilot_reorder` act whose `after.confirmId` is the `copilot_acts` row's
  `confirm_id` (kernel `CopilotActCtx.confirmId`, added for this).
- TRAP: kernel cues "shelf", "wait", "order", "khatam", "kam pad" (pharmacy short book) and radiology's "stuck" sit
  inside natural Stores questions; every Stores phrase must out-score them by 2. Run the eval set after any cue change.
- Not built: the porter's end-of-shift red card (no shift-end source yet: attendance does not publish one).

## 10b. The asset passport (S4a #1114, `asset-rules.ts`, `assets.ts`, `asset-reads.ts`, `verification.ts`, `asset-label.ts`)
- What gets a tag (decision 1): `item_categories.tag_rule` `always` (seeded `MEQ` "Medical equipment", items
  `track_mode = 'tagged'`; `checkStoresItem` refuses any other pairing), `from_value` (ITP, FUR: a `durable` item's GRN
  line at ≥ ₹5,000 per unit before GST is tagged, else counted), `never`. A sub-category takes the stronger of its own and
  its top's rule (`categoryRules`); `needs_calibration` the same way. Migration 0242 sets ITP/FUR on existing rows.
- CONFIRMED in code before building: a GRN line with an empty batch number already minted its own batch
  (`findOrCreateBatch`); a typed one was reused. `materials/grn.ts` `opensOwnBatch` (additive) now mints one per line for
  a `tagged` item and a `durable` item under a rule, typed number or not, so a counted and a tagged chair never share a pile.
- The per-line decision is a row (`stores_tag_decisions`, append-only, threshold frozen) written by `tagDecisionFor` the
  first time Stores reads the line (tagging screen, `tagUnits` — before its own transaction, so a refusal still leaves
  "counted" on file). TRAP: nothing writes it at `postGrn` (materials cannot import stores); a decision read later is
  judged against the threshold of that day.
- Units: `stores_asset_units` written once (tag `AST`+yymm+6 digits from `episode_series` key `asset_tag`, one row per IST
  month; serial unique per item; cost ex-GST from the GRN line, null = "Cost unknown" for an opening unit). Every later
  fact is a `stores_asset_unit_events` row (append-only); a tag number is bound once in the house (unique index on
  `data->>'tagNo'` over `tagged`/`retagged`). Place = the latest row with `store_id` (`PLACE_KINDS`); status, holder,
  dues and put-to-use are derived (`derive`, `statusOf`, `duesOf`), never stored.
- Units ride the ledger (decision 5): `tickets.ts` `planUnitIssue` turns scanned units into named batches (materials
  `IssueIndentInput.lines[].batches`, additive) and keeps counted lines off tagged batches; a tagged item without its
  units is `units_required`. Issue → `moved` to IN-TRANSIT (ref transfer); `custody.ts` `alignPlanToUnits` makes a tagged
  line received by unit (`unitIds`; none = the whole line), `followTransit` places / moves units with every quantity that
  leaves IN-TRANSIT (receipt, accepted send-back, short found / returned). A lost short carrying a unit is refused
  `unit_loss_needs_committee` (S4b's loss path). Gate passes name `unit_ids` per line (new column); exit / entry write
  `out_on_pass` / `back`; counted lines use `countedPick`.
- `assetLedgerCheck`: per FULLY tagged batch (units ≥ what entered by GRN or opening) and store, live units vs
  `stock_balances`. Read only. Tower red card `units_ledger`; also `calibration`, `amc`, `missing` (`assetRedCards`, called
  inside `redCards`). TRAP: both read every unit's events on each tower read; fine at hundreds of units, index it before thousands.
- Transfer (decision 17): `proposeUnitTransfer` (holding dept's `stores.shelf.work`) → `acceptUnitTransfer` (receiving
  dept, never the proposer: `own_transfer`): materials `issueStock` with the PROPOSER as issuer (materials refuses the
  issuer as receiver) + `receiveAtShelf` by the acceptor, so ledger and cost centre move together.
- Spend: `departmentChargeOn` and `departmentSpendByMonth` leave out every batch that carries a unit (decision 19);
  `equipmentReceivedByMonth` lists them; the tower shows it as `equipment` beside `spend`.
- Reminders ride `runStoresChaser` (`runAssetReminders`): AMC/warranty ≤ 30 days, calibration ≤ 15 days (and past), one
  notice per unit/kind/date (source key) to `stores.assets.manage` + `stores.masters.manage` holders. "Replace?" = 3
  faults inside 30 days, one notice keyed on the window's first fault.
- Access: `seesUnit` = assets read/manage/masters, the home department's shelf grants, the receiving department of an
  open transfer, the keeper of the store it sits in. Anyone else with a shelf grant gets the foreign view (name, tag,
  "Belongs to", Found here); cost only with `stores.assets.read`.
- Verification: `stores_asset_verifications` start/close rows; scans are `verified_seen` events (shelf in `data`); close
  stores Not seen / Wrong place on its row; "Missing" = not seen by the latest closed round and nothing since.
- Exports: `assetAdditions(month)` (GRN units put to use in the IST month; installed date else first shelf day; GST =
  cost × item GST rate; input credit blank until S6), one `asset_export` act per call.

## 10c. Condemnation, loss and disposal (S4b #1114, `condemnation.ts`; ruling 0100 Q5)
- Tables (migration 0243, all append-only by the 0242 trigger function): `stores_condemnations` (one proposal, written
  once: kind `condemn` | `loss`, reason, the SEATS frozen on the row, cost judged on, `needs_owner`, `holds_data`,
  `replaces_id`, `round_id`), `stores_condemnation_signatures` (one row per seat, one per person: `sign` | `object`),
  `stores_condemnation_steps` (`raised` | `approved` | `rejected` | `posted`, one each), `stores_scrap_sales` (the
  disposal: scrap sale, buy-back or e-waste, bids, wipe certificate, the write-off). Status is DERIVED (`statusOfFull`).
- Seats are filled BY ROLE (`SEAT_ROLE`: `department_head` AT the unit's department, `accounts_officer`,
  `materials_head`, `biomedical_engineer` for `tag_rule = always`), and the role must hold `stores.assets.condemn`
  (`seatHolders`). No user department (a unit in a store) = no HOD seat. A seat with no holder refuses the proposal
  (`committee_seat_empty`, `detail.seat`). One act per person per proposal (`already_signed`).
- The last signature (`raiseAfterSeats`, in the signature's tx and its ONE act): the books move to the materials
  `CONDEMNED` hold (`ensureCondemnedStore`, a Stores system store; two ledger rows, the transit leg keeps `ref_type =
  'transfer'` so `inTransitByLine` sees it leave), a `moved` unit event with `data.hold` (`condemned` → "Withdrawn",
  `loss` → "Missing"), then materials `raiseWriteOff` (reason `condemned`, raised AS the materials-head seat's signer:
  it holds `materials.writeoffs.manage`; the requester of `materials_stock_adjustment`), and when `needs_owner` the new
  approval type `stores_condemnation_owner` (approver owner; in `MATERIALS_APPROVAL_TYPES`, so the seed registers it).
- `settleCondemnations` reads the two approvals back (chaser minute sweep, every condemnation read, the passport's
  read): both granted → step `approved` + unit event `condemned` (a loss: none, it stays Missing); either rejected →
  step `rejected`, `condemn_objected`, and the books go back to where they stood (the `raised` step's `data`). It is NOT
  an act (D17: one act per person's act); the unit events carry the approver as actor. TRAP: a write-off the MS granted
  whose owner then rejected stays "requested, granted" in materials; its CONDEMNED stock is gone back, so it cannot post.
- Disposal (`disposeUnit`, `stores.masters.manage`): refuses `regulator_paper_needed` (item `regulated_by` without a
  `regulator_paper` event), `wipe_certificate_needed` (`holds_data`; default true for a top category `ITP`),
  `bids_required` (scrap sale above ₹25,000: three distinct bidders, the buyer the highest), `not_approved` above ₹5
  lakh without the owner's grant. One tx: `postWriteOff` (buyer = agency, invoice or recycler certificate = manifest,
  today), the sale row, step `posted`, and the non-returnable pass (`raiseGatePassInTx(..., { quiet: true })`, ref
  `scrap_sale` for a sale/buy-back, `write_off` for e-waste) when the actor holds `stores.gatepass.raise`; the act is
  `dispose_unit` and names the pass. The guard's exit scan writes `disposed` for the line's `unit_ids`.
- Ledger check: a sold unit is off the books from its sale row until the exit scan (`stores_scrap_sales` excluded from
  `live`); an opening row whose `ref_id` is a write-off (`markFound`) is not a new unit (excluded from `entered`).
- Loss: `runLossProposals` (chaser) proposes each unit a closed round did not see, 30 days on, with nothing placing or
  seeing it since and no open proposal (actor `system:stores-loss-sweep`); S4a's lost short of a tagged unit routes to
  `proposeLossInTx` (one per unit, no transit resolution row). `writeOffLoss` posts with agency "lost" and the inquiry
  note's number, writes `written_off`; no pass (gate sources leave loss write-offs out). `markFound` = `found` + one
  `opening_balance` row on the unit's own batch naming the write-off; the write-off row is untouched.
- Withdrawn (decision 7): `withdrawUnit` / `returnToUse` are `moved` events AT the same shelf with `data.hold`, no
  ledger row; the HOD (condemn + indents.approve at the department), the in-charge or biomedical.
- Audit pack `{unitId}`: the unit's own acts (refId = the unit) plus every record its events name (GRN line, transfers
  and their tickets, passes, condemnations). Removals export: `assetRemovals(month)` by the `posted` step's IST day.
- Now cards: "Faults to see" (`stores.faults`, newest fault after the last repair act) and "Condemnation to sign"
  (`stores.condemn`, also the waiting kind `stores.condemnToSign`: the HOD's seat is department-scoped). Web
  `/stores/condemn` (the signer's phone), the Condemnation tab (Propose, dispose, write off), Removals in Exports.
- A refusal of the passport carries `detail.ask` (the home department's in-charges, else the materials head); the
  phone shows "Not your department: ask <names>". A fault may carry a photo (document store key on the event).
- Receive: a ticket line's `units` (still in transit) let the receiver scan what arrived; `unitIds` go with the line.

## 11. Not built here
The end-of-shift red card (needs a shift end from attendance); an offline scan queue (native
staff app); choosing which porter to send; purchasing (S5). S4 leaves: a regulated unit's transfer to another
SITE (no sites yet), the dated HOD delegation (S5 decision 11), PDF/print of the removals export (CSV + screen only).
