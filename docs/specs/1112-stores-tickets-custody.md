---
issue: 1112
status: approved
approved: 2026-11-18
---
# SPEC: Stores S2, request tickets, approval, custody chain and porter scan (#1112) — APPROVED by owner 2026-11-18

Owner answered Q1–Q5 with the recommended options on 2026-11-18 (decision 0099). This is slice S2 of the Stores & Procurement programme (`docs/specs/stores-programme.md`) and
needs S1. Owner, 2026-11-18: "If a material moves from one department to another via a request ticket, it must
be visible when it moves and from where to where, from which staff to which staff."

## What exists

- **Indents** (`materials/indents.ts`) run requested → issued | rejected | cancelled. There is no approval step.
  One issued indent is one transfer. The number is `MIN` + yymmdd + 4 digits.
- **Transfers** (`materials/transfers.ts`): `issueStock` moves stock into IN-TRANSIT, and `receiveStock` records
  `issuedBy` and `receivedBy`. A self-receipt is refused (`transfer_self_receipt`). A short receipt leaves the
  rest in IN-TRANSIT with status `discrepancy`, and **no function resolves a discrepancy**.
- **Write-offs.** `WRITE_OFF_REASONS` are expiry, damage and recall. A count adjustment
  (`requestCountAdjustment`) needs a count. There is no path for a loss in transit.
- **Kernel limits.** The approvals kernel has one `approverRole` per type and ignores department scope.
  `hasPermission` with department scope works (roster precedent).
- **Roles.** Porter (`support_staff`), `security_guard` and `nursing_supervisor` exist only on the unmerged IPD
  train (#967). No HOD role exists anywhere.

## Decisions

1. **The ticket is the materials indent.** There is one requisition paper for the house. Stores adds
   priority, needed-by, deliver-to and channel (phone, web, copilot or agent), plus the custody chain. Materials
   gains nullable approval stamps on `store_indents`. A null stamp means "no approval needed", which is true of
   every pharmacy indent today.
2. **Priority.** Routine: within the shift. Urgent: ≤ 60 min after approval. Emergency: ≤ 20 min from raise,
   with a typed reason.
3. **Approval.** Any one holder of `stores.indents.approve`, scoped to the requesting department, approves or
   declines. A decline needs a reason. The reason shows on the ticket; the notice says only "Not approved"
   (decision 0069 precedent). The requester never approves their own ticket. Ruled (0099 Q2): the HOD alone approves, at any
   value; department budgets arrive with S5 (#1115).
4. **Emergency.** The store may issue an emergency ticket before approval. The HOD reviews it afterwards
   ("Agree" or "Query"). An emergency ticket unreviewed after 24 h is a red card in S3.
5. **Night.** Outside `GEN-MAIN`'s hours an emergency ticket goes to the night store. Its keeper is the duty
   nursing supervisor or the duty manager. The next morning `GEN-MAIN` refills the night store with an ordinary
   ticket.
6. **Picking.** A storekeeper claims the ticket. There is one picker, and a claim lapses after 30 idle minutes.
   Issue is the existing `issueIndent` → `issueStock` (FEFO, into IN-TRANSIT). A line may go short or to 0. The
   short part can be re-asked in one tap as a linked ticket, which keeps the first raise time for its clock.
7. **Custody chain.** An append-only hand-off log, keyed on the transfer, runs issuer → porter(s) → receiver.
   - A porter takes custody by scanning the label QR and confirming. The QR carries the ticket number only.
   - Porter to porter needs the incoming porter's scan. Only the current holder can hand on.
   - The ledger is untouched by hand-offs: stock stays in IN-TRANSIT, and the chain says whose hands it is in.
   - A porter is optional. A department member collecting from the store is recorded as the carrier.
8. **Delivery.**
   - A holder of the requesting department's shelf grant receives, through S1's `receiveAtShelf`, which
     charges the cost centre. The issuer and anyone on the chain cannot receive.
   - Goods are never left unsigned. After 30 min with no receiver, the porter returns them to the source. The
     source keeper accepts them, the stock moves IN-TRANSIT → source, and the ticket reads "Returned
     undelivered".
9. **Shorts.** The short quantity stays in IN-TRANSIT against the last custodian on the chain. The materials
   head resolves it in one of three ways:
   - "Found": a late receipt.
   - "Returned": back to the source.
   - "Lost": a loss request routed to the existing stock-adjustment approver (the medical superintendent).

   Nothing writes off by itself.
10. **Returns from a department.** Unused, wrong or defective items go back on a return ticket. The store's
    receipt credits the department's cost centre at the same batch cost. Defective items go to a quarantine
    store for a supplier return (existing `createSupplierReturn`).
11. **Gate passes.**
    - **Returnable** (repair, calibration, refill, loan) carries a due-back date. The guard's exit scan moves the
      stock to a per-site `OUT-ON-PASS` store, and the entry scan moves it back. A returnable pass past its date
      is overdue.
    - **Non-returnable** only against a dispatched supplier return, a posted write-off or a scrap sale record.
    - Both print.
12. **Requester notices.** Three per delivered ticket: "Approved", "On the way", "Delivered" (or "Delivered,
    3 short"). One line, a few words, Hindi and English.
13. **Timeline.** `ticketTimeline` derives every step from rows: raise, approval, claim, issue, each hand-off,
    receipt, short and resolution. Each step names who (name and role), from place, to place, at what time, and
    the minutes per leg. Nothing about a ticket's lane is stored.
14. **Offline.** Scans and receipts carry an idempotency key and the scan time. A queued scan posts once, with
    `occurred_at` set to the scan time (the ledger's downtime convention), and is flagged "synced late". A scan
    time in the future or more than 12 h old is refused.
15. **End of shift.** A porter holding custody at the end of a shift is a red card in S3, and the porter's card
    says "Hand back before leaving".

## Done means

- **D1** `raiseTicket` from a shelf creates an indent with approval pending, its priority and its stores
  details. An emergency ticket with no reason is refused, and a line with no item id is refused.
- **D2** `approveTicket` by an approver scoped to the requesting department stamps the ticket approved. An
  approver scoped to another department is refused, and so is the requester.
- **D3** Issuing a pending routine ticket is refused (`indent_not_approved`); after approval it issues. A
  pharmacy indent with no stamps issues as it did before S2.
- **D4** An emergency ticket issues before approval. With the clock 24 h 1 min later and no review, it is listed
  in `overdueEmergencyReviews`.
- **D5** An emergency ticket raised outside `GEN-MAIN`'s hours is addressed to the night store. A routine one
  stays on `GEN-MAIN`.
- **D6** `claimPicking` by keeper A and then by keeper B: B is refused. After 30 idle minutes, B's claim
  succeeds.
- **D7** `takeCustody` by a porter changes the holder from issuer to porter and leaves every ledger balance
  unchanged; the IN-TRANSIT quantity is equal before and after.
- **D8** `handOver` from porter A to porter B, with B's scan, records one hand-off. A hand-off attempted by
  someone who is not the current holder is refused.
- **D9** `deliverTicket` by a department receiver closes the chain. The issuer or a porter on the chain is
  refused as receiver. `ticketTimeline` then lists raise → approve → claim → issue → each hand-off → delivered,
  in order, with who, from, to and time.
- **D10** Receiving 7 of 10 leaves 3 in IN-TRANSIT, and the ticket names the last custodian. Then:
  - `resolveShort` "found" receives the 3.
  - "returned" puts the 3 back at the source.
  - "lost" creates one adjustment request to the existing approver and writes no ledger row until it is
    approved.
- **D11** `returnUndelivered`, by the porter and accepted by the source keeper, moves the whole transfer
  IN-TRANSIT → source and sets the ticket to "Returned undelivered".
- **D12** A return ticket from a department, received by the store, credits that department's cost centre with
  the negative of the original charge at batch cost.
- **D13** A returnable pass moves stock to `OUT-ON-PASS` on the guard's exit scan and back on the entry scan.
  After its due-back date it is listed overdue. A non-returnable pass with no supplier return, write-off or
  scrap reference is refused.
- **D14** A custody scan sent twice with one idempotency key records once. A queued scan keeps its scan time as
  `occurred_at`.
- **D15** A delivered ticket sends its requester exactly three notices. A declined one sends exactly one
  ("Not approved"), and the reason is not in it.
- **D16** UPDATE and DELETE on `stores_custody_handoffs` and on the approval stamps are refused by the database.
  An offline scan stores both phone time and server time, and `ticketTimeline` shows both when they differ by more
  than 5 minutes. `ticketAuditPack` for a ticket lists every event and signature in time order and equals the
  timeline.

## Budgets

- HOD approval takes ≤ 60 min, 90th percentile.
- Urgent tickets are delivered ≤ 60 min after approval; emergency tickets ≤ 20 min from raise.
- One porter leg takes ≤ 30 min. Routine tickets are delivered within the shift.
- 100 % of transfers are signed by two different people.
- Taps: a porter take or hand-off ≤ 2 (scan, confirm); a receipt ≤ 3; an approval ≤ 2 from the notice.

## Out of scope

- The tower, Now cards, concierge and chaser (S3).
- Department budgets and formal approval delegation (S5, #1115).
- Choosing which porter to send: a `material_run` task kind on the IPD train's task engine, later.
- Tagged units (S4); substituting a different item.

## Build notes

- **Files.**
  - Materials, additive only:
    - Approval stamp columns on `store_indents`, and an `issueIndent` refusal when an approval is pending.
    - `transfers.ts` gains `receiveLate` for a discrepancy line and `returnInTransit` (IN-TRANSIT → source,
      signed by the source keeper).
    - An adjustment request without a count, reason `lost_in_transit`, going to the same approver.
    - `ensureTransitStore`-style creation of `OUT-ON-PASS` and the quarantine store.
  - Stores: `tickets.ts`, `custody.ts`, `gate-pass.ts`, `timeline.ts`, `notices.ts`.
  - Web: the ticket timeline, the store pick list, the porter card, the receive screen and the gate scan.
  - Printing: the issue voucher and the gate pass.
- **Migration** yes, one per PR. The approval stamps, `stores_ticket_details`, `stores_custody_handoffs`
  (append-only by trigger) and `stores_picking_claims` go in PR 1. `stores_gate_passes` goes in PR 2.
- **Permissions** `stores.indents.approve`, `stores.carry` and `stores.gatepass.scan`. Picking reuses
  `materials.stock.issue`.
- **Roles.** `department_head` from S1. The porter (`support_staff`) and `security_guard` come from the IPD
  train with identical keys and titles if stores lands first (`docs/specs/stores-programme.md` §11).
- **Size** XL (two PRs). **Depends on** S1. **Blocked by** nothing.
