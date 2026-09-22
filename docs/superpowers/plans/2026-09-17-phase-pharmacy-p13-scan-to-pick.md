# Pharmacy P13 — the pack is scanned at the pick (2026-09-17)

**Lane** `formulary` worktree, branch `lane/pharmacy-scan-pick`, stacked on P12 (#221). No
migration.

## 1. WHY

Doc 16 §534 lists "label/scanner support" in 16c, and C2 covers a dead scanner. Labels shipped in
16c; scanning did not. The pick was the aide reading a batch number off the screen. A wrong strip
in the hand (Calpol for Crocin, a look-alike box) went out unless someone noticed. Barcode
confirmation at the pick is how large Indian hospital pharmacies close that gap.

## 2. DECISIONS

- **P13-1. Optional, per line.** `pick` takes `scan` on a line. Many Indian packs carry no barcode,
  and doc 16 says so, so scanning cannot be mandatory. The `dispense.picked` event records
  `scanned` per line, the rate the C2 KPI needs.
- **P13-2. What a scan must be.** Resolved through the item master's barcodes (registered at
  `/materials/items`). The refusals:
  - `scan_unknown`: no item carries the code;
  - `scan_wrong_item`: another item's pack, **the wrong drug**;
  - `scan_batch_unknown`: a GS1 batch the counter does not hold, including one on another store's
    shelf;
  - `scan_batch_mismatch`: a GS1 expiry that disagrees with the books (a mis-keyed GRN), or a
    named batch that is not the scanned one.
  - Nothing is reserved when a scan is refused.
- **P13-3. GS1 is read, not guessed.**
  - Both the bracketed and raw element strings are read: (01) GTIN-14, (17) expiry, (10) batch,
    plus (11)/(13)/(15)/(21) so a raw string walks past them.
  - The symbology prefix is stripped, and a variable field ends at the group separator.
  - An expiry day of 00 is the month's last day.
  - An impossible date is no expiry. A string without a 14-digit GTIN is looked up as a plain code.
  - The GTIN is tried as printed and as the EAN-13 inside it.
  - India's QR mandate on the top 300 brands has no fixed payload. Such a QR is looked up as a plain
    code and refused if nobody registered it; that is deliberate.
- **P13-4. A scanned batch is the batch picked**, under the named-batch checks the override already
  has (expired, recalled, cannot cover). It is `fefoOverride` when FEFO would have chosen another.
- **P13-5. The counter checks as the pack is scanned.**
  - `GET /pharmacy/dispenses/:id/lines/:idx/scan?code=` needs `pharmacy.dispense.place` and uses the
    same resolution as the pick, so the two cannot disagree.
  - The screen shows ✓ item · batch · expiry, or the refusal.
  - **"Pick from shelf" is disabled while any line shows a refusal:** the wrong pack is still in
    someone's hand. Clearing the field, or a good re-scan, releases it.
  - A refused scan is never sent.

## 3. AS BUILT, AND WHAT PROVES IT

- **Code.**
  - `pharmacy/gs1.ts`, `pharmacy/scan.ts`, the `pick.ts` change, and the event field.
  - materials `batchesByNo`.
  - The route and the pick body's `scan`.
  - The counter's scan field, chip and pick block.
  - `pharmacyCounter.scanPack` and four `pharmacyErrors.*` in en and hi.
  - Runbook §4 now counts 54 codes, and the parity test holds it there.
- **Tests.**
  - `scan.test.ts` (4):
    - the parser, in both forms, with day-00 and bad inputs;
    - a plain scan picks FEFO's batch, and a GS1 scan picks its own batch;
    - an unscanned pick is recorded as unscanned;
    - the five refusals, including a batch held at another store, with nothing reserved.
  - The e2e (403 for the clerk, 400 without a code).
  - Web (1): the check, the refusal, the blocked pick, and the body carrying only the matched scan.
- **Suites run locally.**
  - pharmacy, materials, kernel/modules, both e2e, caddyfile and nav-parity: **40 suites, 318 tests
    passed**.
  - Full web: **119 files, 1,083 tests passed**.
  - After a lint fix (an unused parameter), scan, pharmacy e2e and runbook-parity were re-run:
    8 passed.
- **Mutants: 13, each with a written prediction. All were killed.**
  - **SW1 survived the first run.** A refused scan with no other edit leaves its line out of the pick
    entirely, so the dropped-scan rule was invisible.
  - The fix went in the product: the pick is blocked while a refusal stands. The test was extended
    with a partial quantity on that line, and SW1 and SW3 (the block) are now killed.
  - The mutant plan also found the other-store batch gap (S5) before the run.

## 4. NOT BUILT

- Scanning at hand-over (a second check at the window).
- Making scanning mandatory per item class (an owner policy, once the barcode coverage is known).
- Registering a barcode from the counter (the item master is the storekeeper's).
- A scan-rate figure on the day strip (the event field exists for it).
