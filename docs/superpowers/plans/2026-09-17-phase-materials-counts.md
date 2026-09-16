# Plan 14c, first slice — blind stock counts and the variance register (2026-09-17)

**Lane** `formulary` worktree, branch `lane/materials-counts`. Migration **0100**.

## 1. WHY

Doc 16 §534 puts "counts + triangle" in 16c. Doc 09 §3.9 designs the cycle count. Plan 14's
re-slice (owner ruling 2026-08-27) put counts in 14c, **"gated on O1 for every two-key rule"**.
O1, a second approving actor, is still open.

The count itself is not a two-key act. The ADJUSTMENT is: writing stock off or on. So this slice
builds everything up to the adjustment and stops there. The variance is visible and nothing hides
it, which is Plan 14's posture for transfer discrepancies.

Without counts, three things have no detector:
- the leakage triangle (issued vs billed vs **counted**);
- the stock accuracy KPI;
- short-supplied cartons GRN'd in full (doc 16 I12: "pharmacy's counts are the detector").

## 2. DECISIONS (the standard Indian-hospital answer where a ruling was missing)

- **C-1. Who counts: S10's custodian/counter pair, with custody read off the ledger.**
  - No custody master exists, so custody is derived: anyone who posted a movement at the store in
    the last 30 days keeps it. The window is `greatest(occurred_at, recorded_at)`, so a downtime
    back-entry typed today counts as touching the books today.
  - The system picks the counter **at random** (doc 09 §3.9 "assign(random non-custodian)") from
    active holders of `materials.counts.perform` at hospital scope. It excludes the scheduler,
    which a CHECK also enforces, and the custodians.
  - Nobody left means `no_eligible_counter`, with the remedy in its sentence.
  - A storekeeper therefore counts the pharmacy, and a pharmacist counts the main store.
- **C-2. Blind.** The sheet (`GET /materials/counts/:id/sheet`) carries item, batch, expiry and
  unit, never the system figure. Only the assigned counter reads it (`count_not_assigned`).
  Submission returns the header only, because a variance shown to the counter would un-blind a
  recount they might be given.
- **C-3. The freeze and the reconciliation (doc 09 I5, K8).**
  - Scheduling copies each batch's `qty_on_hand`. That is the physical figure: reserved strips
    are on the shelf.
  - The sheet includes empty batches that moved in the last 90 days, because stock found where the
    books have none is a finding (I3).
  - The counter gives the sheet's own time (`countedAt`, IST), which must fall between the freeze
    and now.
  - `moved = Σ ledger at that store and batch in [frozenAt, countedAt)`, and
    `variance = counted − (frozen + moved)`. A sale during the count is the ledger's, not the
    counter's.
  - `variance_paise = variance × landed cost per base unit`.
- **C-4. H7's recount.**
  - A line is recounted when it is more than 10% out of its expected quantity (by basis points;
    exactly 10% is a variance), or more than ₹2,000 out at landed cost.
  - Submission opens a blind recount of those lines only, frozen at the submission, and prefers a
    different counter.
  - One count is being counted per store (partial unique index). A submitted count awaiting
    review does not block its own recount.
- **C-5. Every line, once.** A blank is not a zero (`count_incomplete`), and a count is a whole
  number of base units ≥ 0.
- **C-6. Review is the head's.** `materials.counts.manage` covers schedule, list, review (system,
  moved, counted, variance, ₹ and flag), close with a note, and cancel with a reason while
  counting. Events: `stock_count.scheduled`, `stock.counted`, `stock.variance_flagged` (one per
  non-zero line), `stock_count.closed`, `stock_count.cancelled`.
- **C-7. No adjustment; `stock.adjusted` is not defined.** Writing a variance off needs a second
  key, and runbook O1 is open. When O1 closes, an approval type (`materials_stock_adjustment`,
  approver the head or owner by ₹ band) and a ledger reason (`adjust`) are the next slice. That
  slice needs its own migration, because `stock_ledger_reason_ck` is closed.
- **C-8. Grants.**
  - `materials.counts.manage` goes to `materials_head`.
  - `materials.counts.perform` goes to `materials_head`, `storekeeper` and `pharmacy`.
  - The pharmacy aide (`pharmacy_assistant`), whom doc 16 lists as counting, is **not** granted
    yet. It would be a grant outside the README's materials table, and the owner can add it.
- **C-9. `permission_denied` is a materials code** (403). The acts check their own grant, as P5
  and P9 do. The error test's status set is now {403, 404, 409}.

## 3. AS BUILT, AND WHAT PROVES IT

- **Schema and migration.** `stock_counts` and `stock_count_lines` (migration 0100), with CHECKs
  for status, separation of duties, counted/closed/cancelled consistency, non-negative counts and
  flags.
- **Code.**
  - `materials/counts.ts`.
  - Seven routes on the materials controller. `counts/mine` is declared before `counts/:id`.
  - Menu entry and web route `/materials/counts`; the route count goes 58 → 59.
  - `materialsErrors.*` (12 codes) and `materialsCounts.*` in en and hi.
- **Grant counts.** Declared 170, held 156, model pairs 339, model permissions 150; the README
  table has 13 rows and 24 ticks.
- **Runbook.** Pharmacy §5 has a weekly blind count of `PHARM-OPD`. §8 is updated.
- **Tests.**
  - `counts.test.ts` (5):
    - who counts, the freeze, the blind sheet;
    - the reconciliation of a sale during the count, an exact-10% variance, a found-stock
      recount, and a value recount of a ₹500-a-unit line; the recount goes to the second
      counter; no stock moves;
    - sheet refusals;
    - close and cancel;
    - nobody eligible (with a back-dated custodian), the transit store, and a scheduler without
      the grant.
  - The e2e (1): the whole flow over HTTP with each step's person.
  - Web (2): the counter's sheet (blanks refused, time sent as IST, no review) and the head's
    schedule, review and close.
- **Suites run locally, under the test lock.**
  - Core materials, pharmacy, all of kernel, both e2e suites, seed-roles, caddyfile, nav-parity
    and standup-check: **148 suites, 1,595 tests passed**.
  - Full web suite: **118 files, 1,080 tests passed**.
- **Mutants: 25, each with a written prediction. 24 were killed.**
  - **K17 survived, and it is equivalent.** With the pre-check removed, closing a count that is
    still being counted is refused by the compare-and-set update with the same code. The
    pre-check stays for its clearer message.
  - **Kills beyond the prediction:**
    - K6, history-wide movement: failed two tests, not one. The spurious recount blocks the close
      test's next schedule.
    - V3, the manager panel for everyone: failed both web tests. The panel rendered before the
      permissions loaded.
  - **The mutant plan found two gaps before the run.** No line was out on value alone (K8), and no
    custodian was back-dated (K3). Both fixtures were added first.

## 4. NOT BUILT

- The adjustment (C-7).
- Counts scheduled by a calendar (a weekly sweep is a worker job; the owner decides the cadence).
- The annual external audit (`external=true`).
- The pharmacy leakage triangle report. It is the next slice and now has its third leg.
- The aide's grant (C-8).
- Printing the blank sheet is a browser print of the screen, not a server document.
