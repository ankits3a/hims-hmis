# Pharmacy P20 — paper dispenses entered after an outage (2026-09-17)

**Lane** `formulary` worktree, branch `lane/downtime-entry` (stacked on P19). Migration **0103**.

## 1. WHY

Doc 16's 16c scope lists a "downtime backfill screen", and the night report named it as open: "the
first dispense entered after an outage". The owner (2026-09-17): *"do what you think best."*

The kernel already has the paper: a downtime kit (`/ops/downtime-kit`) reserves numbered, signed
sheets per desk. Its own header says recovery "backfills a real document through billing's own
lane". Nothing read a sheet back yet: `verifyKitSerial` had no caller.

## 2. DECISIONS (Indian corporate hospital practice)

- **P-1. One sheet, one entry.**
  - The sheet is a kit `receipt` form. Its signed QR is scanned, and its serial must sit inside a
    range the kit reserved (`kitSheetOf`, new, because a signature alone signs any serial).
  - A partial unique index enters each sheet once (`sheet_already_entered`, also on a race).
- **P-2. The entry is a sale record with `channel = downtime`, not a dispense.**
  - After the fact, a dispense can no longer run claim → verify → pick → bill → hand over, each
    stamped with the server's clock.
  - The P19 record already holds exactly what a paper sheet carries: a customer, lines with
    batches, an optional outside prescription, and the money.
  - 0103 adds `channel`, `entered_by` and the sheet columns, and lets `licence_id` be null for an
    OPD counter sheet.
- **P-3. Everything happens at the time on the sheet, except the invoice.**
  - At the sheet's time:
    - the ledger's `occurred_at`;
    - the H1 register's date;
    - the day expiry is judged on;
    - the day the pharmacist's council registration is checked on;
    - the latest allowed prescription date;
    - the price rule's regulation date.
  - The invoice is issued at entry, with a number from that day, as the kit's header requires: a
    sheet serial is a reconciliation key, never a GST invoice number.
- **P-4. When a sheet may be dated.**
  - Not in the future, and not before the kit was printed.
  - Within **7 days** (`DOWNTIME_BACKFILL_DAYS`); an older sheet is an incident.
  - While the hospital was in `downtime` or `degraded` mode, read from the mode timeline
    (`operatingModeAt`, new). A paper entry dated while the counter was running is refused
    (`not_in_downtime`).
- **P-5. The batch is a fact on the sheet.** Every line names it (`batch_required`). FEFO after the
  event would be a guess about what left the shelf.
- **P-6. Who handed it over is named, and may differ from who enters it.**
  - `sold_by` is the pharmacy staff member on the sheet (`unknown_pharmacist` otherwise).
  - For a Schedule H/H1 line, that person needs `pharmacy.dispense.scheduled` and a council
    registration current on that day. The register row carries their number.
  - `entered_by` is the pharmacist at the recovery desk, under the new
    `pharmacy.downtime.enter` (`pharmacy` alone).
- **P-7. A clinical check is recorded, not refused.**
  - The medicine is already with the patient; refusing the entry would leave the ledger and the
    register wrong.
  - Hits travel on `retail.sold` (`checkHits`), and the screen tells the pharmacist to tell the
    pharmacist in charge.
- **P-8. Which store.**
  - Either counter's store: `PHARM-OPD` sells under the hospital's licence; `PHARM-RETAIL` needs
    the retail licence on that day.
  - A sheet from any kit desk is accepted; the desk is recorded.
- **P-9. A walk-in retry is still the same sale.** Folding the two flows into `recordSale` first put
  the server's clock into the idempotency hash, so a retried walk-in sale got a key conflict. The
  P19 end-to-end test caught it. The hash is now of what the client sent, and the unit test retries
  a moment later so it fails on that bug (mutant D1).

## 3. NOT BUILT

- **Cancelling the OPD queue entry for a prescription dispensed on paper.** The runbook tells the
  counter to cancel it with the reason.
- **A kit form kind of its own for the pharmacy.** The kit's `receipt` form is used.

## 4. WHAT WAS BUILT

- **Kernel (additive).** `operatingModeAt` (`ops/mode.ts`) and `kitSheetOf` (`ops/downtime-kit.ts`),
  each with a test.
- **Migration 0103.** `pharmacy_retail_sales` gains `channel`, `entered_by`, `downtime_kit_id`,
  `downtime_serial` and `downtime_desk`, with the channel, licence and sheet CHECKs and the
  one-entry-per-sheet partial unique index.
- **`retail.ts`.**
  - `recordSale` is the one writer both flows use.
  - The P20 functions: `enterPaperDispense`, `previewPaperDispense`, `inspectSheet`,
    `searchCounterShelf`, `counterBatches`, `pharmacyStaff` and `listPaperDispenses`.
  - The walk-in day list excludes paper entries.
- **HTTP routes** under `/pharmacy/downtime`: `sheet`, `staff`, `shelf`, `batches`, `preview` and
  `dispenses` (GET and POST), all on `pharmacy.downtime.enter`.
- **Web screen** `/pharmacy/downtime`: scan the sheet → counter, time (IST), who handed it over →
  customer → lines with batches → price → prescription → money → enter; the entered sheets below.
- **Runbook §10**, and 7 refusal codes in §4 (71 in all, with P19's `document_store_unavailable`).

## 5. MUTANTS (19, each with a written prediction; 19 killed, every count as predicted)

| # | mutant | result |
|---|---|---|
| D1 | the retry hash takes the server clock | 1 of 5 (the walk-in retry) |
| D2 | any signed sheet, range not asked | 2 of 3 |
| D3 | a consultation sheet accepted | 1 of 3 |
| D4 | a time outside the outage accepted | 1 of 3 |
| D5 | no backfill window | 1 of 3 |
| D6 | a time before the kit accepted | 1 of 3 |
| D7 | the ledger dated at entry | 1 of 3 |
| D8 | expiry judged at entry | 1 of 3 |
| D9 | the registration asked of the enterer | 1 of 8 |
| D10 | a check hit refuses a paper entry | 1 of 3 |
| D11 | no batch demanded | 1 of 3 |
| D12 | anyone may be named as handing over | 1 of 3 |
| D13 | a walk-in sheet without the licence | 1 of 3 |
| D14 | the register dated at entry | 1 of 8 |
| D15 | the walk-in day list shows paper entries | 1 of 3 |
| D16 | kernel: the mode at an instant reads the current mode | 4 of 30 (1 kernel + 3 downtime) |
| D17 | kernel: the sheet's range ignored | 1 of 16 |
| D18 | web: the time posted without the IST offset | 1 of 2 |
| D19 | web: a line priced with no batch | 1 of 2 |
