---
issue: 1112
status: built
approved: 2026-11-18
---
# SPEC: Stores S2, request tickets, approval, custody chain and porter scan (#1112) — APPROVED by owner 2026-11-18

Owner answered Q1–Q5 with the recommended options on 2026-11-18 (decision 0099). This is slice S2 of the Stores & Procurement programme (`docs/specs/stores-programme.md`) and
needs S1. Owner, 2026-11-18: "If a material moves from one department to another via a request ticket, it must
be visible when it moves and from where to where, from which staff to which staff."

## What exists

- **Indents** (`materials/indents.ts`) run requested → issued | rejected | cancelled. There is no approval step.
  `raiseIndent` and `issueIndent` call `requirePerm` on `materials.stock.receive` / `.issue` at hospital scope,
  and `issueIndent`, `rejectIndent` and `cancelIndent` update the `store_indents` row.
  One issued indent is one transfer. The number is `MIN` + yymmdd + 4 digits.
- **Transfers** (`materials/transfers.ts`): `issueStock` moves stock into IN-TRANSIT, and `receiveStock` records
  `issuedBy` and `receivedBy`. A self-receipt is refused (`transfer_self_receipt`). A short receipt leaves the
  rest in IN-TRANSIT with status `discrepancy`, and **no function resolves a discrepancy**.
- **Write-offs.** `WRITE_OFF_REASONS` are expiry, damage and recall. A count adjustment
  (`requestCountAdjustment`) needs a count. There is no path for a loss in transit.
- **Kernel limits.** The approvals kernel has one `approverRole` per type and ignores department scope.
  `hasPermission` with department scope works (roster precedent).
- **Roles.** Porter (`support_staff`), `security_guard` and `nursing_supervisor` exist only on the unmerged IPD
  train (#967). No HOD role exists anywhere. `duty_manager` holds no `materials.*` grant.
- **Offline.** The web app has only the push service worker (`apps/web/public/sw.js`); there is no scan queue.

## Decisions

1. **The ticket is the materials indent.** There is one requisition paper for the house. Stores adds
   priority, needed-by, deliver-to and channel (phone, web, copilot or agent), plus the custody chain. Materials
   gains nullable approval stamps on `store_indents`. A null stamp means "no approval needed", which is true of
   every pharmacy indent today. A stamp is **write-once**: once set it cannot be changed or cleared, and a
   stamped indent cannot be deleted (a trigger; the row's status still moves on issue, reject or cancel).
   Department staff raise through `raiseIndentScoped` (caller-authorised: the stores intent has already checked
   the department-scoped shelf grant), because department roles hold no `materials.*` grant.
2. **Priority.** Routine: within the shift. Urgent: ≤ 60 min after approval. Emergency: ≤ 20 min from raise,
   with a typed reason.
3. **Approval.** Any one holder of `stores.indents.approve`, scoped to the requesting department, approves or
   declines. A decline needs a reason. The reason shows on the ticket; the notice says only "Not approved"
   (decision 0069 precedent). The requester never approves their own ticket. The approver may reduce a line's
   quantity (never raise it); the timeline shows both numbers. Ruled (0099 Q2): the HOD alone approves, at any
   value; department budgets arrive with S5 (#1115).
   **Stand-in (DECIDED, standard practice; flagged to owner for a nod 2026-11-19):** the medical superintendent
   holds the grant at hospital scope as stand-in, for an HOD on leave or a requester who is the only approver;
   the timeline shows "for HOD".
   A declined ticket re-raises in one call with its lines prefilled, linked to the first, keeping the first raise
   time for its clock.
4. **Emergency.** The store may issue an emergency ticket before approval. The HOD reviews it afterwards
   ("Agree" or "Query"). An emergency ticket unreviewed after 24 h is a red card in S3.
5. **Night.** Outside `GEN-MAIN`'s hours an emergency ticket goes to the night store. Its keepers are the duty
   nursing supervisor and the duty manager, who hold **`stores.nightstore.issue`** (the night store's
   `custodianRoles`). They issue through `issueIndentScoped` (caller-authorised), since neither holds
   `materials.stock.issue`. The next morning `GEN-MAIN` refills the night store with an ordinary ticket.
6. **Picking.** A storekeeper claims the ticket. There is one picker, and a claim lapses after 30 idle minutes.
   Issue is the existing `issueIndent` → `issueStock` (FEFO, into IN-TRANSIT). A line may go short or to 0. The
   short part can be re-asked in one tap as a linked ticket, which keeps the first raise time for its clock.
   **Back-order:** when stock for a short line arrives at the store, its linked ticket appears prefilled on
   "To pick".
7. **Custody chain.** An append-only hand-off log, keyed on the transfer, runs issuer → porter(s) → receiver.
   - A porter takes custody by scanning the label QR and confirming. The QR carries the ticket number only. A
     typed fallback takes the ticket number's last four digits.
   - Porter to porter needs the incoming porter's scan. Only the current holder can hand on.
   - **Porter gone:** `takeOverCustody` by the source storekeeper or the materials head, with a reason, records a
     forced hand-off naming the previous holder. Anyone else is refused.
   - The ledger is untouched by hand-offs: stock stays in IN-TRANSIT, and the chain says whose hands it is in.
   - **Counter collection:** the receiver signs at the store counter. No carrier leg; the issuer ≠ receiver rule
     still holds. The timeline reads "Collected at store".
8. **Delivery.**
   - A holder of the requesting department's shelf grant receives, through S1's `receiveAtShelf`, which
     charges the cost centre. The issuer and anyone on the chain cannot receive.
   - Per line the receiver marks accepted / short / wrong / damaged. Wrong and damaged quantities are never
     charged; they go back on the same chain to the source (damaged into quarantine), and the requester's notice
     reads "Delivered, 2 sent back".
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
11. **Gate passes** moved to their own spec, `docs/specs/1119-stores-gate-passes.md` (S2c).
12. **Notices.** Requester: three per delivered ticket, "Approved", "On the way", "Delivered" (or "Delivered,
    3 short" / "Delivered, 2 sent back"). Approvers: one on raise. One line, a few words, Hindi and English.
    **Now cards** (via `collectDeskProviders`, `kernel/desk/registry.ts`): "Indents to approve" (the
    department's approvers and the stand-in), "To pick" (the source store's keepers), "To receive" (the
    department's shelf-grant holders). S3 adds "Stuck".
13. **Timeline.** `ticketTimeline` derives every step from rows: raise, approval, claim, issue, each hand-off,
    receipt, short, sent back and resolution. Each step names who (name and role), from place, to place, at what
    time, and the minutes per leg. Nothing about a ticket's lane is stored.
14. **Offline (DECIDED).** The web app needs a connection. Scans and receipts carry a client idempotency key and
    the scan time, and post once with `occurred_at` set to the scan time (the ledger's downtime convention). A
    scan time more than 12 h old is **accepted and flagged** for the keeper's confirmation, never lost; a scan
    time in the future is stored as server time and flagged. The offline queue arrives with the native staff-app
    screens (see Out of scope).
15. **End of shift.** A porter holding custody at the end of a shift is a red card in S3, and the porter's card
    says "Hand back before leaving".
16. **Audit pack.** `storesAuditPack({ticket | item | person | store, from, to})` under `stores.audit.read`
    (materials head, medical superintendent, owner, and a new `stores_auditor` role seeded with no holders,
    for the internal auditor) lists every movement,
    hand-off, approval and reversal in `seq` order with actor and role, as print and CSV. Each export writes one
    event.

## Done means

- **D1** `raiseTicket` from a shelf, by a shelf-grant holder with no `materials.*` grant, creates an indent with
  approval pending, its priority and its stores details. An emergency ticket with no reason is refused, and a
  line with no item id is refused.
- **D2** `approveTicket` by an approver scoped to the requesting department stamps the ticket approved, and may
  reduce a line's quantity (an increase is refused). An approver scoped to another department is refused, and so
  is the requester.
- **D3** The medical superintendent, holding the grant at hospital scope, approves a ticket whose requester is
  the department's only approver; `ticketTimeline` shows the step "for HOD".
- **D4** Issuing a pending routine ticket is refused (`indent_not_approved`); after approval it issues. A
  pharmacy indent with no stamps issues as it did before S2.
- **D5** An emergency ticket issues before approval. With the clock 24 h 1 min later and no review, it is listed
  in `overdueEmergencyReviews`.
- **D6** An emergency ticket raised outside `GEN-MAIN`'s hours is addressed to the night store, and a holder of
  `stores.nightstore.issue` issues it. A routine one stays on `GEN-MAIN`.
- **D7** `claimPicking` by keeper A and then by keeper B: B is refused. After 30 idle minutes, B's claim
  succeeds.
- **D8** `takeCustody` by a porter changes the holder from issuer to porter and leaves every ledger balance
  unchanged; the IN-TRANSIT quantity is equal before and after. The typed last four digits work as the scan.
- **D9** `handOver` from porter A to porter B, with B's scan, records one hand-off. A hand-off attempted by
  someone who is not the current holder is refused.
- **D10** `deliverTicket` by a department receiver closes the chain. The issuer or a porter on the chain is
  refused as receiver. `ticketTimeline` then lists raise → approve → claim → issue → each hand-off → delivered,
  in order, with who, from, to and time.
- **D11** A shelf-grant holder collecting at the counter receives with zero hand-offs; the timeline reads
  "Collected at store".
- **D12** `takeOverCustody` by the source storekeeper or the materials head, with a reason, records a forced
  hand-off naming the previous holder; anyone else is refused.
- **D13** `deliverTicket` takes per line accepted / short / wrong / damaged. Wrong and damaged quantities are
  never charged; they go back on the same chain to the source (damaged into quarantine), and the requester's
  notice reads "Delivered, 2 sent back".
- **D14** Receiving 7 of 10 leaves 3 in IN-TRANSIT, and the ticket names the last custodian. Then:
  - `resolveShort` "found" receives the 3.
  - "returned" puts the 3 back at the source.
  - "lost" creates one adjustment request to the existing approver and writes no ledger row until it is
    approved.
- **D15** A short line re-asked as a linked ticket keeps the first raise time; when stock for it arrives at the
  store, the linked ticket appears prefilled on "To pick".
- **D16** `returnUndelivered`, by the porter and accepted by the source keeper, moves the whole transfer
  IN-TRANSIT → source and sets the ticket to "Returned undelivered".
- **D17** A return ticket from a department, received by the store, credits that department's cost centre with
  the negative of the original charge at batch cost.
- **D18** A declined ticket re-raises in one call with its lines prefilled, linked, and keeping the first raise
  time.
- **D19** A custody scan sent twice with one idempotency key records once. A scan keeps its scan time as
  `occurred_at`; one 13 h old is accepted and flagged for the keeper's confirmation, never refused.
- **D20** A delivered ticket sends its requester exactly three notices. A declined one sends exactly one
  ("Not approved"), and the reason is not in it.
- **D21** On raise, the department's approvers get one notice and the ticket is on "Indents to approve"; on
  approval it is on "To pick"; on issue on "To receive".
- **D22** UPDATE and DELETE on `stores_custody_handoffs` are refused. An approval stamp, once set, cannot be
  changed or cleared (write-once trigger), and a stamped indent cannot be deleted. A late scan stores both phone
  time and server time, and `ticketTimeline` shows both when they differ by more than 5 minutes.
- **D23** `storesAuditPack({ticket | item | person | store, from, to})` returns every movement, hand-off,
  approval and reversal in `seq` order with actor and role; the CSV has the same rows; each export writes one
  event. A caller without `stores.audit.read` is refused.
- **D24** (web, 390 px) Receive shows issued quantities prefilled; Confirm is reachable in ≤ 3 taps with no
  horizontal scroll; every status shows a word.

## Screens

Phone screens fit 390 px with no horizontal scroll; the store pick list also works on a 16:9 desktop. Every
status is a word. Notices are a few words on one line. Strings are verbatim, English / Hindi. Loading is grey
rows with no text everywhere. "No connection / कनेक्शन नहीं" shows on any screen when the connection drops.

- **Raise (phone, from the reorder draft).** Rows: item · quantity (editable). Priority chips: Routine / सामान्य,
  Urgent / जल्दी, Emergency / आपात (asks for a reason). Primary: **Send / भेजें**. Refused: "Reason needed /
  कारण ज़रूरी", "Choose from the list / सूची से चुनें". Done: "Sent / भेज दिया". An open ticket for the same
  item and shelf offers "Add to open ticket? / खुले टिकट में जोड़ें?".
- **Approve (phone, from the notice).** Rows: item · asked · approve quantity (can only go down). Primary:
  **Approve / मंज़ूर करें**; secondary "Decline / मना करें" (reason box). Empty: "Nothing to approve / मंज़ूरी को
  कुछ नहीं". Refused: "Your own ticket / आपका अपना टिकट", "Not your department / आपका विभाग नहीं".
- **To pick (store).** Rows sorted by floor: ticket · department · priority word · lines · age. Primary:
  **Claim / लें**, then **Issue / जारी करें** (prints the voucher and label). Empty: "Nothing to pick / उठाने को कुछ
  नहीं". Refused: "Taken by another keeper / दूसरे कीपर ने लिया", "Not approved yet / अभी मंज़ूर नहीं".
- **Porter card (phone).** Rows: tickets in my hands · from → to · minutes. Primary: **Scan / स्कैन करें**; fallback
  "Type last 4 / आख़िरी 4 अंक लिखें". End of shift: "Hand back before leaving / जाने से पहले सौंपें". Empty:
  "Nothing in your hands / आपके पास कुछ नहीं". Refused: "Not in your hands / आपके पास नहीं".
- **Receive (phone).** Rows: item · issued quantity prefilled · Accept / Short / Wrong / Damaged (सही / कम / गलत /
  टूटा). Primary: **Confirm / पुष्टि करें**. Refused: "You carried it / आप लाए थे", "You issued it / आपने जारी
  किया". Empty: "Nothing to receive / लेने को कुछ नहीं".
- **Timeline (phone and web).** One row per step: who (name, role) · from → to · time · minutes. Late scans show
  both times. Read-only; no primary button.
- **Notices, verbatim.** Approvers: "Indent to approve / मंज़ूरी के लिए इंडेंट". Requester: "Approved / मंज़ूर",
  "Not approved / मंज़ूर नहीं", "On the way / रास्ते में", "Delivered / पहुँच गया", "Delivered, 3 short / पहुँचा,
  3 कम", "Delivered, 2 sent back / पहुँचा, 2 वापस", "Returned undelivered / बिना दिए वापस". Keeper: "Late scan to
  confirm / देर वाला स्कैन जाँचें". Timeline words: "Collected at store / स्टोर से लिया", "for HOD / HOD की जगह",
  "Synced late / देर से सिंक".
- **Now cards.** "Indents to approve / मंज़ूरी बाकी", "To pick / उठाना है", "To receive / लेना है".

## Budgets

- HOD approval takes ≤ 60 min, 90th percentile.
- Urgent tickets are delivered ≤ 60 min after approval; emergency tickets ≤ 20 min from raise.
- One porter leg takes ≤ 30 min. Routine tickets are delivered within the shift.
- 100 % of transfers are signed by two different people.
- Taps: a porter take or hand-off ≤ 2 (scan, confirm); a receipt ≤ 3; an approval ≤ 2 from the notice.

## Out of scope

- Gate passes (S2c, #1119). The tower, the "Stuck" Now card, concierge and chaser (S3).
- Department budgets and formal approval delegation (S5, #1115).
- An offline scan queue: the web app needs a connection; the queue arrives with the native staff-app screens
  (its own follow-up issue).
- Choosing which porter to send: a `material_run` task kind on the IPD train's task engine, later.
- Tagged units (S4); substituting a different item.

## Build notes

- **Two PRs.** **S2a**: tickets, approval and stand-in, re-raise, picking claim, night store, notices and the
  three Now cards, the audit pack, and the write-once stamp trigger (D1–D7, D18, D21, D23). **S2b**: custody
  chain, counter collection, take-over, delivery with wrong/damaged, shorts and back-order, undelivered returns,
  department returns, late scans, the delivered-ticket notices (D8–D17, D19, D20, D22, D24). spec-guard: S2a says `Refs #1112`;
  S2b says `Closes #1112` and sets `status: built`.
- **Files.**
  - Materials, additive only:
    - Approval stamp columns on `store_indents` (write-once trigger), and an `issueIndent` refusal when an
      approval is pending.
    - `raiseIndentScoped` and `issueIndentScoped`: caller-authorised twins of `raiseIndent` / `issueIndent`
      (no `requirePerm`); the stores intent checks its own permission first. The existing functions are
      unchanged.
    - `transfers.ts` gains `receiveLate` for a discrepancy line and `returnInTransit` (IN-TRANSIT → source,
      signed by the source keeper).
    - An adjustment request without a count, reason `lost_in_transit`, going to the same approver.
    - `ensureTransitStore`-style creation of the quarantine store.
  - Stores: `tickets.ts`, `custody.ts`, `timeline.ts`, `notices.ts`, `audit-pack.ts`, the three desk providers.
  - Web: the raise and approve sheets, the store pick list, the porter card, the receive screen, the timeline.
  - Printing: the issue voucher with the label QR.
- **Migration** yes, one per PR. S2a: the approval stamps (write-once trigger), `stores_ticket_details` and
  `stores_picking_claims`. S2b: `stores_custody_handoffs` (append-only by trigger) and the scan idempotency keys.
- **Permissions** `stores.indents.approve` (department scope; `medical_superintendent` at hospital scope),
  `stores.carry`, `stores.nightstore.issue` (`nursing_supervisor`, `duty_manager`) and `stores.audit.read`
  (`materials_head`, `medical_superintendent`, `owner`, `stores_auditor`).
  Picking reuses `materials.stock.issue`.
- **Roles.** `department_head` from S1. The porter (`support_staff`) and `nursing_supervisor` come from the IPD
  train with identical keys and titles if stores lands first (`docs/specs/stores-programme.md` §11).
- **Size** XL (two PRs). **Depends on** S1. **Blocked by** nothing.
