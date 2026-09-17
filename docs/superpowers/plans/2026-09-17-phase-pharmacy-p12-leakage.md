# Pharmacy P12 — the leakage triangle: issued, billed, counted (2026-09-17)

**Lane** `formulary` worktree, branch `lane/pharmacy-leakage`, stacked on Plan 14c's first slice
(#220). No migration.

## 1. WHY

Doc 16 names leakage as one of pharmacy's three hardest problems:
*"the triangle (issued vs billed vs counted) must close per location per day"*. The chaos row is
I1: *"… variance row … fixture with 3 unbilled units surfaces"*. The Leakage Auditor is T0: a SQL
report, reviewed by the billing supervisor.

The counter's own flow cannot bill a strip it did not issue: pick, bill and hand-over are one
chain. What leaks goes **around** it:
- a refund at the billing desk with nothing returned;
- stock consumed at the counter with no dispense behind it;
- stock booked back with no refund;
- a shelf that does not match the books.

The first three are ledger and billing facts. The fourth needed 14c's blind counts, which is why
this comes after #220.

## 2. DECISIONS

- **P12-1. Per dispense line, as of now.** The lines examined are:
  - those handed over on the day;
  - any line whose invoice line a **live** credit note credited that day;
  - any line with a P6 `pharmacy_return` movement that day.

  For each line:
  - issued = what its `consume` row moved, less returns;
  - billed = the invoice line's quantity, less live credits;
  - `unbilledUnits = issued − billed`. Positive means stock out and not paid for. Negative means
    stock booked back with no refund, which can hide missing stock.
  - The value is at the billed unit price.
- **P12-2. Voided credit notes do not count.** Entered-in-error marks are honoured in both billing
  readers, the same rule `creditedQtyByLine` and the daily close apply.
- **P12-3. Consumption outside a dispense.** Every `consume` row at the store whose `ref_type` is
  not `pharmacy_dispense` is listed, with its reference and the login that posted it.
- **P12-4. Counted.** The non-zero variance lines of the counts whose sheet time fell on the day
  (submitted or closed).
- **P12-5. Who reads it: `billing.reports.read`.** That is the owner and the billing manager,
  doc 16's reviewers. The counter does not audit itself: the pharmacist gets 403.
  - It needs no new permission. The menu entry sits in the billing group beside the back office.
  - It names dispense numbers, never patients. Opening one at the counter is the logged read.
- **P12-6. The readers live with their rows.**
  - billing (`credit-notes.ts`): `invoiceLineCredits` and `creditedInvoiceLineIdsBetween`.
  - materials (`ledger.ts`): `ledgerQtyByIds`, `consumptionRowsAt` and
    `refIdsWithMovementBetween`.
  - materials (`counts.ts`): `countVariancesBetween`.
  - All are new exports, and no existing signature changed.

## 3. AS BUILT, AND WHAT PROVES IT

- **Code and routes.** `pharmacy/leakage.ts` and `GET /pharmacy/leakage?day=`. The screen is
  `/pharmacy/leakage`, with `pharmacyLeakage.*` in en and hi. The web route count goes 59 → 60.
- **Tests.**
  - `leakage.test.ts` (3):
    - The day with one of each:
      - a clean dispense returned properly;
      - three units refunded with nothing back (I1's fixture);
      - four units consumed on a ward slip;
      - a count two short.
      - The expected summary is 3 units unbilled, 4 other, −2 counted, and the next day is quiet.
    - The next day:
      - a late refund on the earlier dispense;
      - a restock with no refund, shown as −5;
      - after the refund is voided, it is gone; on the hand-over day the voided line balances
        and the restocked one does not.
    - Feb 30 is refused.
  - The e2e check: the pharmacist gets 403.
  - Web (2): the day's three sections, and a quiet day.
- **Suites run locally.**
  - pharmacy, materials, billing, kernel/modules, both e2e, caddyfile, nav-parity and
    seed-roles: **71 suites, 600 tests passed**.
  - Full web: **119 files, 1,082 tests passed**.
- **Mutants: 13, each with a written prediction. 12 were killed.**
  - **L11 is equivalent.** Listing a line whose only credit was voided examines a line that then
    balances.
  - **L10 survived the first run, as predicted:** its effect was hidden by the other live-note
    filter. The hand-over-day assertion was added, and L10 is now killed.
  - **One kill below the prediction:** LW1 failed one web test, not two. The quiet test's
    default day already answers quiet.

## 4. NOT BUILT

- A daily push of the report (the owner's 8 a.m. digest is 16f's).
- Ward and IPD locations (16d).
- Dyads: which staff pairs recur in the mismatches (doc 16's "pattern per location").
- Valuing count variance at MRP rather than landed cost.
