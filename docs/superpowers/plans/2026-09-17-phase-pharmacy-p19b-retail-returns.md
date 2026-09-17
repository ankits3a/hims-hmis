# Pharmacy P19b — a sealed pack comes back to the walk-in counter, and the leakage report reads it (2026-09-17)

**Lane** `p19b-retail-returns`, branch `lane/p19b-retail-returns`. No migration.

## 1. WHY

P19 (walk-in retail, #226) listed two things it did not build: returns and refunds of a walk-in sale,
and the leakage triangle for `PHARM-RETAIL`. Its runbook told staff to take walk-in returns "at the
billing desk for now". A refund there with nothing restocked is exactly what the leakage triangle
exists to catch. The handoff of 2026-09-17 put P19b next.

Reading P12 for this slice found a latent defect from P20. A paper dispense at the OPD counter is a
`pharmacy_retail_sales` row, and its `consume` row is referenced `pharmacy_retail_sale`. The OPD
report counted every `consume` row that was not a dispense's as "consumed outside a dispense". So
every paper dispense entered after an outage would have shown up as leaked stock.

## 2. DECISIONS (owner instruction: the standard Indian hospital answer)

- **RB-1. The counter's policy, clause for clause.** Doc 16 O-7, as P6 applies it:
  - within 7 days, counted from `sold_at` (a paper dispense's `sold_at` is the time on the sheet);
  - sealed and intact, attested by the inspecting pharmacist;
  - whole packs only;
  - never cold-chain, frozen or narcotic;
  - never a recalled batch or one with under 30 days to expiry;
  - never more than the line sold, less earlier returns.

  The O-7 checks moved out of `acceptReturn` into `returns.ts` helpers that both counters call:
  `requireReturnTaker`, `judgeReturnAct`, `judgeReturnLines` and `restockAndRefund`. P6 behaves as
  before, and its three tests are unchanged and green.
- **RB-2. Any sale row, either channel.** A walk-in sale and a paper dispense are both
  `pharmacy_retail_sales` rows with a paid invoice and ledger rows. The same act returns either.
  - The pack goes back to the sale's own store: `PHARM-RETAIL`, or `PHARM-OPD` for a paper dispense
    there.
  - The ledger row is a `return` on the same batch, with `ref_type = pharmacy_retail_return` and
    `ref_id` set to the sale line. Those rows are also how "already returned" is counted.
  - No new table.
- **RB-3. The money is P6's.** A `refund` credit note is raised for exactly the returned quantity,
  and the refund is **requested**. Billing's approval and the cashier's voucher pay it.
  - The reason class is billing's guard 4, chosen on the form: `genuine` when the customer no
    longer needs it, `mistake` when the counter sold the wrong item.
- **RB-4. No licence check.** A return sells nothing.
  - A customer's refund does not wait on the shop's Form 20/21 renewal.
  - A restocked pack cannot be sold again until the licence is current.
  - A paper dispense returned at the OPD counter needs no retail licence at all. Mutant M4 found
    this case, which my prediction had missed.
- **RB-5. The H1 register is not touched.** Its row records the supply, as at the counter (P6).
  The return is recorded by the `retail.line_returned` event and the credit note.
- **RB-6. Who.** The act checks three things itself:
  - `pharmacy.retail.sell`, because it reads the sale;
  - a current council registration;
  - both billing strings.

  The route is gated `billing.refund.request`, as P6's is. No new permission.
- **RB-7. Found by the bill number.** The customer brings the bill back:
  `GET /pharmacy/retail/bill?no=`.
  - The permission is checked **before** the lookup, so an outsider cannot probe which bill numbers
    exist (mutant M15 found this).
  - A counter dispense's bill is still returned at the counter (§3.11).
- **RB-8. Idempotent.** `POST /pharmacy/retail/sales/:id/returns` carries an idempotency key. The
  whole act runs inside `withIdempotency`, so a retry is replayed rather than judged again.
- **LK-1. The leakage triangle reads either counter's store.** `GET /pharmacy/leakage?store=` takes
  `PHARM-OPD` (the default) or `PHARM-RETAIL`; any other value gets 400.
  - A sold line is a counter dispense's line or a sale line, both at that store.
  - Each mismatch says which kind it is (`source`), and a sale line is named by its bill number.
- **LK-2. A paper dispense is a sold line, not leaked stock.** "Consumed outside" now excludes the
  sale lines' own `consume` rows, and the paper dispense is checked issued-against-billed like any
  sale.
- **LK-3. Dispense lines are filtered by the store.** The filter is defensive: no dispense can
  exist at `PHARM-RETAIL`, so mutant M10 was predicted to survive, and it did.

## 3. AS BUILT

- **Core.**
  - `retail-returns.ts`: `findRetailSaleByInvoiceNo`, `acceptRetailReturn`.
  - `returns.ts`: the shared O-7 helpers.
  - `leakage.ts`: takes a store, and checks sale lines.
  - `retail.ts`: `RetailSaleView.lines[].returnedQtyBase`.
  - Event `retail.line_returned` (the catalogue is now 15 events).
  - Constant `RETAIL_RETURN_REF_TYPE`.
  - Two routes: `GET retail/bill` and `POST retail/sales/:id/returns`, plus `store` on the leakage
    route.
- **Web.**
  - `/pharmacy/retail` gains "Take back a sealed pack":
    - the bill number;
    - per line: sold, back, and a quantity box only while something is left;
    - the reason and whose reason it is;
    - the sealed attestation (the button waits for it);
    - the credit note number.

    It shows while the counter is shut.
  - `/pharmacy/leakage` gains a Counter select. A walk-in or paper line is tagged and named by its
    bill number.
  - en and hi strings.
- **Runbook.** `pharmacy-go-live.md`: §9 (returns and leakage at the walk-in counter), §8, and two
  refusal rows in §4.

## 4. TESTS (each written first and run red)

- **`retail-returns.test.ts` (4).**
  1. Restock, credit and refund; a retry replays; the licence lapses and a return still goes
     through; a third return is refused.
  2. Every O-7 refusal, with nothing written.
  3. A short-expiry batch.
  4. The walk-in store's leakage triangle.

  Red: 4 of 4, "not built".
- **`downtime.test.ts` (+1).** A paper dispense is a sold line in the OPD report, and its strip comes
  back into `PHARM-OPD`. Red against the old `leakage.ts`: 1 of 4, at `otherConsumption`, showing
  one `pharmacy_retail_sale` row of 10 units, as predicted.
- **`leakage.test.ts`.** The mismatch row gains `source`, `saleId` and `invoiceNo`.
- **`events.test.ts`.** 14 → 15.
- **`pharmacy.e2e.test.ts` (P19 case extended).**
  - The bill lookup: 200, clerk 403, unknown 404.
  - The return: aide 403, unattested 400, 201 and replayed on a retry, then 409
    `return_exceeds_dispensed`.
  - The leakage route with `store=PHARM-RETAIL` gives 200; `store=MAIN` gives 400.
- **Web.**
  - `pharmacy-retail.test.tsx` (+2): the return, and an unknown bill.
  - `pharmacy-leakage.test.tsx` (+1): the store switch and the bill-number row.

  Red against the old screens: 3 of 10.

## 5. MUTANTS (19, each with a written prediction; 18 killed, 1 predicted survivor)

Core runs cover four suites: `retail-returns`, `returns`, `downtime` and `leakage`.

| # | mutant | predicted | result |
|---|---|---|---|
| M1 | the 7-day window unchecked | 2 | 2 |
| M2 | earlier returns counted from P6's ref type | 1 | 1 |
| M3 | the pack restocked into `PHARM-OPD` | 1 | 1 |
| M4 | a return requires a current retail licence | 1 | **2**: the paper dispense at the OPD counter also refused (RB-4) |
| M5 | no idempotency | 1 | 1 |
| M6 | the credit covers twice the quantity | 1 | **5**: the helper is shared, so P6's and P12's tests caught it too |
| M7 | leakage ignores the store | 1 | 1 |
| M8 | a sale's own consumption listed as "outside" | 2 | 2 |
| M9 | sale lines read P6's returns | 2 | 2 |
| M10 | dispense lines not filtered by store | 0 (survivor, LK-3) | 0 |
| M11 | `returnedQtyBase` always 0 | 2 | 2 |
| M12 | the sealed attestation unchecked | 2 | 2 |
| M15 | the bill lookup without its permission check | 1 | **0 → killed after the test gained an outsider probe with an unknown bill** (RB-7) |
| M16 | a cut strip accepted | 2 | 2 |
| M17 | the event's channel hard-coded `walk_in` | 1 | 1 |
| W1 | web: Accept enabled without the tick | 1 | 1 |
| W2 | web: the store not sent | 1 | 1 |
| W3 | web: a quantity box on a line fully returned | 1 | 1 |
| W4 | web: reason class hard-coded | 1 | 1 |

The three misses were all in my model, not in the code:
- M4: I forgot that a paper dispense goes through the same act.
- M6: I forgot the refactor made P6 share the credit step.
- M15: the test could not see the probe. `getRetailSale` refuses the clerk anyway, but only after
  the lookup had answered.

## 6. VERIFIED (lane, 2026-09-17, under the test lock)

- `pnpm typecheck`: clean. eslint on the touched trees: 0 errors (2 warnings, both already on main,
  in files this lane did not touch).
- Core: `src/modules/pharmacy`, `test/pharmacy.e2e.test.ts`, `test/seed-pharmacy.test.ts`,
  `test/caddyfile-parity.test.ts` and `test/nav-parity.test.ts` give **28 suites, 147 tests, all
  green**.
- Web, full: **124 files, 1,100 tests, all green**.
- **Browser walk** (stub API, real Chromium, 1280 and 400 px). The return form was filled, and Accept
  stayed disabled until the tick. The credit note sentence showed. The leakage report showed both
  counters, with a paper-dispense row and a walk-in row. The walk found three things, now fixed:
  - batch and bill numbers broke across lines at 400 px;
  - "Dispensed:" did not fit a walk-in store, and now reads "Dispensed or sold";
  - a tag and a bill number ran together as one word ("Walk-in saleINV-…"), which the web test also
    caught.

## 7. NOT BUILT

- **A returns register report.** The events and credit notes are the data (P6 §4).
- **Returning a counter dispense by its bill number** at the walk-in screen. The counter's own P6
  form does that.
- **Refund by the original tender, automatically.** The cashier chooses it at the voucher (P6).
- **Home delivery returns** (16f is gated).
