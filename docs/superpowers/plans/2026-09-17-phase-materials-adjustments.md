# Plan 14c, second slice — a count's variance, booked with a second key (2026-09-17)

**Lane** `formulary` worktree, branch `lane/stock-adjust`. Migration **0101**.

## 1. WHY

The first slice (#220) found variances and could not book them. Writing stock off needs two keys,
and runbook O1 (a second approving actor) was open. The owner (2026-09-17): *"needs a second
approving administrator → Then create the user/staff for this."* The roster now carries
`ms.approver` (`medical_superintendent`), so the second key exists. See the pharmacy handoff for the
roster.

## 2. DECISIONS

- **A-1. The approver is the medical superintendent.**
  - An Indian hospital's administrative head signs stock condemnation and write-off.
  - The materials head, who scheduled and reviewed the count, only asks. The kernel's
    requester/approver pair refuses self-approval regardless.
  - New approval type `materials_stock_adjustment`: routine, no act-first, a day's SLA. It is
    registered by `seed:materials` on deploy.
- **A-2. What is booked.**
  - A `variance` line of a submitted or closed count, at its variance quantity, valued at landed
    cost.
  - A `match` has nothing to book (`nothing_to_adjust`).
  - A `recount` line is booked from its recount (`recount_pending`), because H7 exists so that a
    large difference is counted twice before anyone writes it off.
- **A-3. The reason fits the direction** (code and CHECK):
  - `found` books stock on;
  - `shrinkage`, `damage` and `expiry` write it off;
  - `entry_error` goes either way.
- **A-4. Nothing moves before GRANTED.**
  - A pending request refuses `adjustment_unapproved`.
  - A rejected one marks its lines `refused`, which frees them to be asked again (a partial unique
    index keeps one live request per line).
  - A granted one posts one `adjust` ledger row per line, once, with one `stock.adjusted` event.
    Posting again posts nothing.
- **A-5. The ledger never goes negative.** A write-off the shelf can no longer cover is refused
  whole (`insufficient_stock`), and the request stays `requested` to be looked at again.
- **A-6. The ledger's sixth reason is `adjust`.** The CHECK is dropped and re-added; existing rows
  already satisfy it.

## 3. AS BUILT, AND WHAT PROVES IT

- **Code.**
  - `materials/adjustments.ts` and the `stock_adjustments` table.
  - The approval type and the `stock.adjusted` event.
  - Three routes: `POST /materials/counts/:id/adjustments`, `GET` the same, and
    `POST /materials/adjustments/:approvalId/post`, all under `materials.counts.manage`.
  - The web `CountAdjustments` panel in the count review, and six `materialsErrors`.
- **Tests.**
  - `adjustments.test.ts` (4):
    - the whole flow: ask, pending refused, the requester unable to decide, the MS grants, both
      directions booked, the event, idempotent, a second ask refused;
    - the refusals;
    - a recount line;
    - a rejection freeing the line, and a granted write-off the shelf no longer covers.
  - The e2e: 403 for the keeper, 400 for an unknown reason, 201, the list, and 409 before
    approval.
  - Web (2).
  - Pins: approval types 3; ledger reasons 6.
- **Mutants: 8, each with a written prediction. 7 were killed.**
  - Killed:
    - J1: pending posts.
    - J2: a recount line booked.
    - J3: any reason in any direction.
    - J4: a rejected line stays requested.
    - J5: posts twice.
    - J7: anyone may ask.
    - J8: a line named twice.
  - **J6 is equivalent.** A `match` line always has a variance of 0, which the next condition refuses.
  - **J7 survived the first run,** and the gap was real. A keeper's request still ended in
    `permission_denied`, but only at the final listing, after the approval request and rows were
    written. The test now asserts nothing was written; J7 is killed.

## 4. NOT BUILT

- Value bands: a small write-off to the materials head, a large one to the owner. The approvals
  engine takes one approver role per type, and bands need an owner ruling on the thresholds.
- Adjustments not arising from a count: breakage reported at the counter, and expiry destruction
  with a witness (doc 16 I5). Both are next to this table.
