# Pharmacy — everything Healthray does, done our way

## Context
The owner shared two Healthray pharmacy documents (`/opt/hmis-context/reference/2026-09-19-healthray-pharmacy/`) and wants
"everything in our app too, but in our way, in our structure, with the best UX and agent-human assistance".

Measured before planning (2 read-only passes, 2026-09-24):
- **Both documents are AI write-ups.** Only the screen descriptions and menu lists are grounded in the 17 screenshots.
  The rest ("[O-inf]" in the original, most of Gemini) is inference. Gemini's is partly invented: a tech stack, a
  "7-day return" policy, a receipt whose GST contradicts s01, and permission names for modules never shown.
  **We plan from the screenshots plus sound Indian hospital-pharmacy practice, not from the prose.**
- **Our counter is already ahead of Healthray** on safety and law:
  - Rx-linked OPD desk with FEFO chip, auto-match, consented substitution and prescriber authorisation;
  - H1 register append-only by trigger; Schedule X refused; pharmacist registration; Form 20/21;
  - DPCO ceiling pricing, GST inside MRP, loose-tablet rounding;
  - returns with sealed-pack / cold-chain / narcotic refusals; walk-in, downtime and leakage.
- **What we lack is the supplier's money and the back office:**
  - PO, supplier bill, purchase return/debit note, payables/ageing/payments, supplier ledger — all ABSENT;
  - min/max levels, business reports (sales/purchase register, margin, valuation, expiry, non-moving, HSN/GSTR-2), Tally;
  - printing from the new desk;
  - an agent that ACTS (all copilot tools are read-only today).

## Principles ("our way")
1. **Two places, not 25 menus.** `/pharmacy/desk` (the counter, already built) and **one new back office, `/pharmacy/office`**.
   The office opens on a "needs you today" page (Desk One pattern): expiring, short, bills to match, payments due, returns
   awaiting credit. Each card opens its sheet. The office **federates, never owns**: stock stays in materials, money in
   billing, the catalogue in formulary (Plan 14 §4A.2 ruling).
2. **The agent drafts, the human confirms.**
   - Every repetitive act arrives as a pre-filled draft card: a PO from the reorder list, a return from the expiry list, a
     payment run from due bills, a short-book line from the F2 bar ("Pan 40 khatam").
   - One tap confirms it; nothing with money or stock posts without a person.
   - Tools run with the asking user's permissions (existing `kernel/copilot` contract). New tools are `draft_*`, never
     `post_*`.
3. **Keep what makes us stricter; don't copy Healthray's laxness.** We will not copy:
   - negative stock (its s07/s12 show −498; our `stock_balances` has a CHECK);
   - live profit on the sale screen (margin lives in reports behind a View-margin permission);
   - editable issued bills (we correct with credit notes plus an audit diff, not "Bill Lock / Change bill date").
4. **Adopt the good Healthray ideas:**
   - the Pay Bill grid (per-row amount, Full Pay, credit-note offset, `Payable = Total − Credit`);
   - Supplier Summary balances;
   - Expiry report with 30/60/90 presets, a Supplier-wise tab and a "credit note raised" flag;
   - Short Book merged into Stock Alert;
   - Item Merge;
   - the Activity before/after diff (built from our event log);
   - Copy-from-role in the role editor.
5. Every screen at the Desk One / `/counter` UX bar: one screen per job, keys first, exceptions behind ⋯ and sheets.

## Owner decisions (2026-09-24)
- **Order:** P1 counter first, then P2–P4 buy/pay/return, then P5 reports + Tally, then P6.
- **Payables book of record: OUR APP**, with a Tally export of every voucher (P5).
- **Agent: drafts, human confirms.** No money or stock act posts without a person.

## Phases (each = one lane, one PR or a short stack, CI-gated, deployed on the owner's command)

**P1 — Counter complete (small, high feel)**
- Print from `/pharmacy/desk`: label and invoice through the existing server print relay (`kernel/printing`, `print_jobs`,
  80 mm roll per runbook `2026-09-06-RUNBOOK-print-relay-go-live.md`). Today the desk prints nothing.
- **Short book at the counter:** key `N`, or the F2 phrase, records "out of X" with who and when (new
  `pharmacy_short_book` table). The counter agent drafts the line.
- **"Sales today"** strip for the pharmacist's own shift, reusing `GET /pharmacy/summary` and the billing drawer session.
- Retire `/pharmacy/counter` → redirect to the desk (planned since PD).

**P2 — Buy: min/max → PO → GRN against PO**
- Item min/max/reorder level: additive columns on `items` or a per-store table (decide at build). `/pharmacy/reorder`
  (`replenishment.ts`) gains the levels.
- **Purchase order:** `purchase_orders` / `purchase_order_lines`.
  - The agent drafts a PO per vendor from reorder + short book, priced at the last PTR.
  - Approval uses `kernel/approvals` (a new `materials_po_approval` type), and the existing SoD pair `po_approver_grn_receiver`
    (`kernel/auth/sod.ts`) finally gets used.
  - Send as PDF.
  - The GRN (`materials/grn.ts`, `grns.po_ref` becomes a real FK) receives against the PO; short supply stays open on it.

**P2 as built (2026-09-24, lane `pharmacy-p2-po`, migration 0124).**
- Tables:
  - `item_stock_levels` (min / reorder / max per item per store, base units);
  - `purchase_orders` and `purchase_order_lines` (materials module);
  - `grns.purchase_order_id`, a real FK. `po_ref` is kept as the challan's free text.
- Order numbers come from `EPISODE_SERIES.purchase_order`, prefix `MPO`. `PO` would start with the
  dispense's `P` and break prefix freedom.
- Procurement defaults, each a named value in `modules/materials/config.ts`, the module's
  configuration pattern (materials has no config table):
  - **DEFAULT — owner may change.** Raising an order is `materials.po.raise`, held by
    `materials_head` and `pharmacy`. The in-charge holds `pharmacy` too, so the pharmacist and the
    in-charge both raise. The same grant sets min / reorder / max.
  - **DEFAULT — owner may change.** Approval runs through `kernel/approvals`:
    - `materials_po_approval` (approver `materials_head`) covers an order up to
      `PO_HEAD_APPROVAL_LIMIT_PAISE` = ₹50,000, GST included;
    - `materials_po_approval_owner` (approver `owner`) covers anything above it.

    These are two types because an approval type names exactly one approver role. The kernel
    refuses the submitter deciding their own request. The office also refuses whoever drafted the
    order (`requester_approver`).
  - **DEFAULT — owner may change.** `po_approver_grn_receiver` is now enforced. Whoever approved an
    order may not capture or post a GRN against it. The SoD engine logs an audit event, and a guard
    inside the act refuses whatever the caller did.
  - **DEFAULT — owner may change.** Receipt tolerance `PO_RECEIPT_TOLERANCE_BPS` = 2% over the
    ordered paid quantity. It counts posted GRNs plus captured, unposted ones. Free goods are
    counted apart and never capped. Less than ordered leaves the order `part_received`.
- DECIDED (not money, procurement or law):
  - There is no `materials.po.approve` string. The approval is the engine's, as with the bank
    change.
  - Reading an order needs `materials.stock.read`. An owner who reads no stock decides in
    `/approvals`, where the two types show the total. A decision taken there is settled onto the
    order the next time anything reads it.
  - A rejected order returns to draft with the reason. A resubmit files a fresh approval.
  - An order that has any GRN against it cannot be cancelled. Short-closing the rest is P3's.
  - The agent's drafts carry an expected date of today + 3 days (`PURCHASE_DEFAULT_LEAD_DAYS`).
  - An agent draft goes to each item's last paid supplier, at that receipt's rate per pack. An item
    never bought, or whose last supplier is inactive, waits for a person to assign it. A short-book
    drug with no item is listed as not stocked.
  - "On order" counts approved, sent and part-received orders. "In draft" counts drafts and pending
    orders. Both are subtracted from `max`, so nothing is drafted twice.
  - The order prints as A4 HTML, and the browser saves it as PDF (the OPD report's path). A draft
    prints stamped DRAFT.
- Deferred:
  - Closing short-book rows automatically when their order is received;
  - short-closing a part-received order;
  - e-mailing the PDF to the vendor;
  - levels for stores other than the OPD counter on a screen. The API takes any store.

**P3 — Pay: supplier bill → payables → payment run → ledger**
- Supplier bill entry: bill no/date, taxable, input GST, total. **3-way match** PO ↔ GRN ↔ bill with a tolerance (owner
  ruling).
- Payables with ageing 0–30 / 31–60 / 60+, and the **MSME 45-day clock** (`vendors.msme_class`, `payment_terms_days`
  already exist, unread).
- **Payment run:** the Healthray grid with our approval step (`kernel/approvals`). Modes NEFT/RTGS/UPI/cheque/cash with
  the reference. `vendors.first_payment_allowed_at` is honoured (bank-change cooling-off, already modelled).
- Supplier ledger + Supplier Summary.

**P3 as built (2026-09-25, lane `pharmacy-p3-pay`, migration 0127).**
- Tables (materials module): `supplier_bills` and `supplier_bill_lines` (one line per item per GRN,
  carrying what the GRN accepted and the PO's rate beside what was billed), `supplier_payment_runs`,
  `supplier_payment_run_lines` (`pay_paise`, and `credit_paise` reserved for P4 — always 0 today) and
  `supplier_payments` (one voucher per vendor per run).
- Voucher numbers (stable, for P5's Tally export) from `EPISODE_SERIES`: the bill as we booked it
  `MSB…`, the payment run `MPR…`, the payment voucher `MPV…`. Every money document also carries its
  date (bill date, paid-on date).
- Bill: draft → matched | held_for_match → accepted → part_paid → paid, or cancelled (only with
  nothing paid and on no open run). One live bill per vendor, vendor bill number (case, spaces, `-`,
  `/`, `.` ignored) and Indian financial year — in the act and by a partial unique index. One GRN is on
  one live bill. Consignment and donation GRNs are never billed here. Input GST is kept per line as
  CGST + SGST or IGST (for P5's GSTR-2B).
- The agent prefills a bill from a posted GRN (`billDraftFromGrn`): the accepted quantity, the PO's
  rate and GST, the challan's invoice number and date; IGST when the vendor's GSTIN state is not the
  letterhead's. The person types the bill number and date and any line that differs.
- Payables: `payables()` (ageing by bill date 0–30 / 31–60 / 61–90 / 90+, overdue by due date, the
  Supplier Summary: total, paid, remaining, overdue) and `supplierLedger()` (bills credit, payments
  debit, running balance, opening balance before `from`). Both export CSV from the screen.
- Payment run: the agent drafts (`planPaymentRun`: accepted bills due within the week, overdue
  included, MSME vendors first, then oldest due, at what each bill owes less what open runs already
  hold; a vendor in bank-change cooling-off is listed apart and left out). Preparer submits →
  `materials_payment_run_approval` (approver `owner`) → recorder marks each vendor paid with mode
  (NEFT / RTGS / UPI / cheque / cash), reference (UTR / cheque number; required unless cash) and date.
- Screens: inside `/pharmacy/office`, a Buy | Pay switch (`?view=pay`). Pay opens on bills to enter
  or match, held, due this week, overdue (MSME called out), runs awaiting the owner; a GRN row opens
  the prefilled bill (⏎ saves and matches), a bill shows the match per line, the run sheet is the
  Healthray grid (Inv date, our no., vendor bill no., total, paid before, credit, pay now, remaining,
  Full per row and per vendor). `P` opens payables; `D` makes the agent's draft run.
- Copilot: `draft_payment_run` ("payment run bana do", "pay the suppliers"), read-only, gated on
  `materials.payments.prepare`; its card opens the office's pay side.
- Permissions: `materials.bills.manage` (materials_head, pharmacy), `materials.bills.accept_difference`
  (materials_head), `materials.payments.prepare` and `materials.payments.record` (materials_head,
  pharmacy_incharge). No `materials.payments.authorise`: the approval is the engine's. SoD:
  `payout_preparer_payout_approver` (preparer ≠ authoriser, on the sheet; the kernel's requester ≠
  approver in the inbox, since only the preparer submits) and the new `payment_authoriser_recorder`
  (authoriser ≠ recorder; SoD engine event + in-act guard).
- Census: `pharmacy_payment_run_approval_registered` (G2), `pharmacy_payment_authoriser_held` and
  `pharmacy_payment_recorder_held` (G4).
- Defaults, each a named value in `modules/materials/config.ts`:
  - **DEFAULT — owner may change.** Three-way match tolerance: a line's taxable value against GRN
    accepted × PO rate, and the bill total against the expected total, may differ by
    `BILL_MATCH_TOLERANCE_BPS` = 1% or `BILL_MATCH_TOLERANCE_MIN_PAISE` = ₹10, whichever is larger.
    Beyond it, or with a GST rate other than the order's, more billed than received, or a received
    item not billed, the bill is held for match. `materials.bills.accept_difference` (the head) accepts
    the difference with a reason — never the person who entered the bill (DECIDED: maker ≠ checker).
  - **DEFAULT — owner may change.** Payment run prepared by materials_head or the pharmacist in charge,
    authorised by the OWNER through `kernel/approvals`; the preparer never authorises; the authoriser
    never records.
  - **DEFAULT — owner may change.** A vendor with no `payment_terms_days` is due
    `DEFAULT_SUPPLIER_TERMS_DAYS` = 30 days after the bill date.
  - **LAW, applied as a DEFAULT — owner may change.** MSMED Act s.15: a vendor with `msme_class` set is
    due `min(terms, MSME_MAX_PAYMENT_DAYS = 45)` days after the day of acceptance, taken as the earliest
    linked GRN's posting day (IST). Applied to every class, medium included (the Act binds micro and
    small; paying a medium enterprise by 45 days is never late).
  - **LAW.** Income-tax Act s.40A(3): cash to one vendor in one day may not pass
    `CASH_PAYMENT_DAILY_LIMIT_PAISE` = ₹10,000, summed over every cash payment that day; refused with
    the reason.
  - **LAW / O-6.** `vendors.first_payment_allowed_at` (bank-change cooling-off) blocks recording a
    payment to that vendor before it.
  - **DEFAULT — owner may change.** The agent's run covers bills due within `PAYMENT_RUN_HORIZON_DAYS`
    = 7 days.
- DECIDED (not money authority, procurement or law):
  - Ageing is by bill date (the accountant's convention); "overdue" is by due date.
  - Part payments: a run line may pay less than a bill owes; the bill becomes `part_paid`. One run
    pays one vendor in one voucher.
  - What an open run holds is reserved against the bill, so two runs cannot pay the same rupee.
  - The run's approval carries the run as its payee for the kernel's daily aggregation, and the total
    as its amount.
  - An edited matched or held bill goes back to draft and is matched again.
- Deferred: debit/credit notes and the credit offset (P4); Tally vouchers and GSTR-2B (P5); printing a
  payment advice; bank file upload (NEFT bulk); e-mailing the vendor a remittance advice; the owner
  opening the run grid from `/approvals` (the route `GET /materials/payment-runs/:id/for-approval`
  exists, no screen links it).

**P4 — Return: expiry/damage → debit note → credit offset**
- Return-to-supplier from the Expiry report (Supplier-wise tab): the agent drafts per vendor within the return window
  (owner ruling). It posts a stock `return` movement and a **debit note**. The vendor's credit note, when it arrives, is
  recorded and offsets the next payment (P3).
- BMW destruction write-off for non-returnable expiry: an adjustment with a manifest, through `materials_stock_adjustment`
  approval.
- Recall screen (endpoint exists, no UI).

**P5 — Know: reports + accounting**
- Office reports, each one screen with filters + Excel/CSV + print:
  - sales register (item / doctor / patient / operator);
  - purchase register;
  - **margin** (View-margin permission);
  - stock valuation (FIFO cost);
  - expiry (30/60/90, item/supplier);
  - non-moving / dead stock;
  - HSN summary;
  - GSTR-2B input-credit reconciliation (GSTR-1 exists in billing).
- **Activity diff:** before/after of any bill or credit note, from the event log.
- **Tally export:** vouchers for sales, purchases, returns and payments (format per owner/CA).

**P6 — Law and hygiene**
- NDPS register (Form 3D/3E) with double-lock custody, if the hospital stocks narcotics (owner ruling).
- Item Merge (moves history, keeps the audit).
- Patient SMS/WhatsApp (bill, refill reminder) once a real provider replaces the console stub in `kernel/notify`.
- IPD/ward issue from the counter when IPD exists (Healthray's "Patient List" modal) — tracked, not built now.

## Owner rulings needed (money / procurement / law only — everything else DECIDED as top-hospital practice)
Carried from the 2026-09-19 back-office report §7:
- who may raise and approve a PO, and to what value;
- the 3-way-match tolerance;
- who authorises a supplier payment;
- the return window per rate contract;
- write-off authority;
- Tally format and cadence;
- whether the hospital stocks NDPS / Schedule X.
Each carries a default taken on silence.

## Verification (per phase)
- Fail-first tests, lock-wrapped jest/vitest.
- A stub-API Chromium walk with screenshots of every new screen.
- CI green, then deploy on the owner's command, then a production walk: e.g. P2 = reorder → agent-drafted PO → approve →
  GRN against it; P3 = bill → match → pay.
- The standup census gains a row per new obligation (PO approver held, payment authoriser held, …).

## Critical files
- `apps/core/src/modules/materials/` (grn.ts, replenishment.ts, approval-types.ts, schema `kernel/db/schema/materials.ts`)
- `apps/core/src/modules/pharmacy/` (copilot-tools.ts, summary.ts)
- `apps/core/src/kernel/copilot/`, `kernel/approvals`, `kernel/printing`
- `apps/web/src/screens/pharmacy-desk/`, new `apps/web/src/screens/pharmacy-office/`
- Shared, to coordinate: `router.tsx`, `locales/*.json`, `scripts/seed-roles.ts` + its test, `drizzle/**` (one migration
  per PR, numbered at rebase).
