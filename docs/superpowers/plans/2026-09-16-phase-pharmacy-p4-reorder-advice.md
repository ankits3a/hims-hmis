# Pharmacy P4 — the reorder list (2026-09-16)

**Lane** `formulary` worktree, branch `lane/pharmacy-reorder`, stacked on P5.

## 1. WHY

Doc 16 §9 puts a **Replenishment** automation in 16c's scope, drafting tier: *"indent.drafted per
location … storekeeper picks"*. 16c shipped without it; the runbook's §8 lists it as not built.
A counter with no reorder list finds out it is out of stock from the patient in front of it. This
is the owner's "AI agent acting as a co-pilot to staff" in its most useful and least risky form:
the machine counts and proposes, and people act.

## 2. DECISIONS (owner instruction 2026-09-16: follow the Indian hospital standard)

- **P4-1. Read-only.** Materials has no requisition or purchase-order entity. The two-sided issue
  (`issueStock` → `receiveStock`) is the storekeeper's act. So the list proposes, and a person
  issues or orders. A drafted-indent entity is procurement's (Plan 14) to design, not the counter's.
- **P4-2. The numbers.** An OPD counter is a sub-store, and the standard is a short cover at the
  window topped up from the main store:
  - **reorder under 3 days** of the counter's own recent use;
  - **top up to 7 days**, in whole issue packs;
  - **use measured over the last 30 days**.
  - These are constants (`REORDER_*` in `pharmacy/config.ts`) until a pharmacist asks to change
    one.
- **P4-3. What counts.**
  - "Available" is what the pick would honour, via `availableQtyByItem`: expired, recalled,
    reserved and frozen stock is not cover.
  - "Used" is `consume` rows **at the counter** in the window, keyed on the injected
    `occurred_at`. An issue to another store is not use, and use at another store is not the
    counter's.
- **P4-4. Where from.** The non-transit store holding the most that can cover the suggestion;
  failing that, the one holding the most. Otherwise "Purchase".
- **P4-5. Order.** Out of stock, then reorder (least cover first), then enough, then no use.
- **P4-6. Who.** `pharmacy.dispense.read`, which is everyone at the counter. The list shows stock,
  not patients.

## 3. AS BUILT

- **materials:** `consumedQtyByItem(db, store, items, since, until)` and `uomsByItems(db, items)`,
  both bounded by the items asked for.
- **pharmacy:** `reorderAdvice(db, now)`, and `GET /pharmacy/reorder`.
- **Screen:** `/pharmacy/reorder` (nav "Reorder list"; the web route count goes 56 → 57). It shows
  status, on-shelf quantity, 30-day use, cover, the suggestion in packs, and the source store. It
  prints a requisition of just the lines with a suggestion.
- **Tests.**
  - `replenishment.test.ts` (2):
    - a stock-out whose earlier use falls OUTSIDE the window, which must not count;
    - a reorder line whose main store has stock, and whose own use at the main store must not
      count;
    - a line with no use;
    - the "enough" case;
    - the refusal when the counter's store is missing.
  - The HTTP gate: the clerk gets 403, the aide 200.
  - A web test.

**Mutants (6, predicted, all killed):**
- W1: the window is ignored.
- W2: use at any store counts.
- W3: no rounding to packs.
- W4: the reorder threshold is wrong.
- W5: the source is dropped.
- W6: the screen offers "Purchase" on a line with nothing to order.

**Not discriminated:** the fixture has one other store. So "the store that can cover it" versus
"the store holding the most" (P4-4's tie-break) is exercised by no case where the two differ.

## 4. NOT BUILT

- A drafted indent that materials can pick up (Plan 14's entity to design), and a nightly push:
  the list is read on demand.
- Lead time per item, and a minimum order quantity per vendor. Both are procurement's data.
- Dead-stock value and near-expiry cross-check (doc 16 §14's "batch received but never dispensed
  within 60% of shelf life"). `no_movement` is its first half.
