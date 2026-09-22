# Pharmacy P16 — each drug's GST slab, and the bill that follows it (2026-09-17)

**Lane** `formulary` worktree, branch `lane/gst-slabs`. No migration.

## 1. WHY

The owner (2026-09-17): *"standard slab for medicine is 5% and for some it's zero … run a search on
internet to find actual rate for each item."* Until now the slab was typed by hand, item by item,
and a blank slab billed as exempt. The rehearsal of this work also found a latent defect:
`registerSaleItem` copies the slab into the tariff service's GST category **once**. A slab corrected
afterwards left the bill taxing at the old rate, and nothing noticed.

## 2. DECISIONS

- **P16-1. The rule comes from the notification, not from shop listings.**
  - The 56th GST Council (3–4 September 2025) moved medicaments to 5%, effective 22 September
    2025. Notification 9/2025-Central Tax (Rate), Lists 3 and 4, made 36 named drugs nil: 33 from
    12% and 3 from 5%.
  - The rate follows the molecule, so a rule on the ingredients is exact where a per-brand reading
    of e-commerce pages (1mg, Apollo) is not: those pages do not reliably state the rate.
  - Sources consulted: Tally's HSN 3004 guide, BUSY's medicine GST page, the Pharmabiz report of the
    Council's decision, and the published list of the 33 + 3 drugs.
- **P16-2. The suggestion.**
  - Nil only when **every** ingredient is on the list; any combination with another molecule is 5%.
  - Names are matched after the formulary's normalisation, with alpha/alfa, sulph/sulf, "CI"/"C1
    esterase" inhibitor and the cystamine spelling folded.
  - No ingredient known means no suggestion ("unknown"; set by hand). 18% is never suggested:
    supplements are an HSN decision in the item master.
- **P16-3. The slab and the bill move together.** `setItemGstSlab` writes the item's slab and the
  sale item's service category in one transaction. `syncSaleItemCategory` repairs a category left
  stale by a slab changed any other way (the materials PATCH).
- **P16-4. A plan, applied by a person.**
  - `gstSlabPlan` classifies every active drug item: `set` (blank), `differs`, `ok`, `unknown`;
    `categoryStale` is flagged separately.
  - `applyGstSlabPlan` fills blanks and syncs stale categories. It replaces differing slabs only
    with `overwrite`, and applies the whole plan in one transaction.
- **P16-5. Three doors to the same plan.**
  - `/pharmacy/items` has a panel with Apply and an "also replace" box
    (`GET /pharmacy/sale-items/gst-plan`, `POST …/apply`, `pharmacy.sale_items.manage`).
  - The operator script `set-drug-gst-slabs --as <login> [--apply] [--overwrite]`, dry run by
    default.
  - A census row, `pharmacy_gst_slab_set` (G3), red until every active drug item has a slab and
    every sale item follows it (red on an empty master too).

## 3. AS BUILT, AND WHAT PROVES IT

- **Code.**
  - `pharmacy/gst-slab.ts`, the two routes, and `scripts/set-drug-gst-slabs.ts`.
  - The census row.
  - The web `GstSlabPanel` on `/pharmacy/items`, with `pharmacyItems.gst*` in en and hi.
  - Runbook §2.2 rewritten.
- **Tests.**
  - `gst-slab.test.ts` (3):
    - the rule: list size 36, both lists, spellings, aliases, combinations, nothing to judge;
    - plan and apply: a blank biologic set to nil, a 12% slab reported and replaced only on
      overwrite, a stale category synced, and a clean plan after;
    - **a real bill** at the corrected slab (invoice line `rate_bps` 500).
  - The e2e (403 for the aide, the plan, the apply).
  - The census grammar tests hold (fresh database red, post-seed red).
  - Web (2): only the rows that need doing, apply with and without overwrite, and a clean plan.
- **Mutants: 8, each with a written prediction. All were killed.**
  - G1: any nil ingredient.
  - G2: alpha not folded.
  - G3: the slab set without its category.
  - G4: stale categories never synced (2 tests).
  - G5: always overwrite.
  - G6: staleness never seen (2 tests).
  - G7: a vacuous census row. It failed 2 tests, not the 1 predicted: the post-seed grammar test
    also catches it.
  - GW1: rows that are fine still listed. It failed 2 tests, not 1: the all-clear test sees the
    table as well.

## 4. NOT BUILT

- HSN-based classification of supplements (18%) and devices. The item master's HSN decides those,
  and the CA signs them.
- A price change on the rate cut. MRP is inclusive (P1), so the patient's price is whatever is
  printed on the pack.
