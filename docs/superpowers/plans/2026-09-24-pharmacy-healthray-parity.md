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

**P3 — Pay: supplier bill → payables → payment run → ledger**
- Supplier bill entry: bill no/date, taxable, input GST, total. **3-way match** PO ↔ GRN ↔ bill with a tolerance (owner
  ruling).
- Payables with ageing 0–30 / 31–60 / 60+, and the **MSME 45-day clock** (`vendors.msme_class`, `payment_terms_days`
  already exist, unread).
- **Payment run:** the Healthray grid with our approval step (`kernel/approvals`). Modes NEFT/RTGS/UPI/cheque/cash with
  the reference. `vendors.first_payment_allowed_at` is honoured (bank-change cooling-off, already modelled).
- Supplier ledger + Supplier Summary.

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
