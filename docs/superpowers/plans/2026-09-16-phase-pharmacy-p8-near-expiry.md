# Pharmacy P8 — near expiry at the counter, and why it is not cover (2026-09-16)

**Lane** `formulary` worktree, branch `lane/pharmacy-near-expiry`, stacked on P7.

## 1. WHY

Doc 16 §9 names two agents, Replenishment and the Expiry Watchman. P4 built the first. Materials'
Plan 14 T8 built the second's backbone: a 90/60/30-day sweep and `GET /materials/expiring`. Two
gaps remained at the counter.

1. **The expiry list is hospital-wide.** It sums the stock across every store and says nothing
   about whether the counter will **sell** a batch in time. A strip at the counter with 40 days
   left is no risk if 30 go out a day, and a total loss if 1 goes out a week.
2. **P4's cover counted stock that will expire unsold.** Say a shelf holds 90 tablets, 3 go out a
   day, and 60 of the tablets expire in 9 days. The shelf read as 30 days of cover and is 20. The
   reorder list said "enough" about a shelf that runs dry sooner.

The standard Indian hospital practice (NABH MOM: near-expiry stock is identified and acted on) is
a monthly near-expiry review at 90 days. Stock that will not sell goes back while there is time:
to the main store for a busier counter, or to the supplier under the rate contract's expiry-return
clause, which distributors honour only before the date. Expired stock is taken off the shelf into
quarantine.

## 2. DECISIONS

- **P8-1. The forecast is FEFO at the window's pace, in whole units.**
  - By the end of a batch's last selling day, the counter will have sold
    `floor(used × sellingDays ÷ 30)` in all. The batches ahead of it took the first of those,
    whether they ran out early or expired with stock left, so this batch sells the rest, up to
    what it holds.
  - `sellingDays` counts today through the expiry date, because `expiry_date` is the last day of
    use, as in the pick.
  - An undated batch never expires.
  - **Integer, deliberately.** A running day-cursor of `sold ÷ perDay` is a float, and
    `floor(3 × (35 − 10/3))` is 94, not 95. A fixture batch (CP-2) sits on exactly that edge.
- **P8-2. The horizon is 90 days,** materials' widest expiry band (`EXPIRY_THRESHOLD_DAYS[0]`). A
  30-day pace says nothing useful about a date a year out.
- **P8-3. Cover is `available − unsoldByExpiry`.** `daysOfCover` and the suggestion use it, and the
  reorder line carries `unsoldByExpiry`, so the screen can say why the cover is short.
- **P8-4. Two lists, and each says what to do.**
  - `expiring` lists every batch at the counter inside the horizon, soonest first:
    - `move_back` when some of it will expire unsold;
    - `sell_first` when FEFO will clear it. The pick already does this, so it is reassurance,
      not a task.
  - `expiredOnShelf` lists the counter's stock past its date that is still on hand. The pick
    refuses it, and materials moves it to quarantine when the batch is named.
- **P8-5. Drafting tier, like P4.** Nothing moves stock. The storekeeper's two-sided transfer, or a
  supplier return, is the act.
- **P8-6. The reads live in materials, beside the pick.**
  - `sellableBatchesByItem` uses the pick's own query, so the forecast's order is the pick's order.
  - `expiredStockAt` covers one store.
  - `sellableBatchRows` also returns `batchNo` now; the pick ignores it.

## 3. AS BUILT, AND WHAT PROVES IT

- **Code.**
  - `replenishment.ts`: `forecastUnsold`, plus `expiring`, `expiredOnShelf`,
    `window.nearExpiryDays` and `ReorderLine.unsoldByExpiry`.
  - materials `ledger.ts`: the two reads above.
  - The reorder screen gets two sections and a hint under the cover column ("30 will expire
    unsold"), with the `pharmacyReorder.*` keys in en and hi.
  - Runbook §2: "N available" now points at the expired list.
- **Core tests** (`replenishment.test.ts`: 4, two of them new):
  - one batch half lost, one that sells in time, one that depends on the batches ahead of it, one
    that never moves, and one empty;
  - expired stock at the counter, while the main store's expired stock and an empty expired
    batch stay off the list;
  - a batch on its last day: near expiry, not expired, one day of cover, and a two-strip
    suggestion.
- **Other tests.**
  - The e2e pins the new `window` field and both lists on the wire.
  - Web: 2 tests. The new one covers both sections and the last-day wording. The P4 one adds that
    no hint and no expired section appear when there is nothing to show.
- **Mutants: 12, each with a written prediction. All were killed, each by exactly the predicted
  number of tests.**
  - N1: FEFO order ignored.
  - N2: today is not a selling day.
  - N3: cover counts stock that will expire unsold.
  - N4: no horizon.
  - N5: the last day counted as expired.
  - N6: expired stock from every store.
  - N7: empty expired batches listed.
  - N8: always "send back".
  - N9: empty batches forecast.
  - W1–W3: the hint, the section and the last-day wording.
  - Three of those tests (for N5, N9 and W1) were written **before** the mutants were run: the
    mutant plan had shown those edges unpinned.

## 4. NOT BUILT

- A monthly near-expiry **register** (a signed record of the review).
- Supplier expiry returns (a purchase-return document; materials, with procurement's ruling).
- A worker push to the counter. The Watchman's sweep already emits `batch.expiring`; this is the
  read.
