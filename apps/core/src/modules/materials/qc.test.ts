import { daysBetween, nearExpiryMinDays, qcLine } from "./qc";
import type { QcContext, QcLine } from "./qc";
import type { UomRow } from "./uom";

/**
 * PLAN 14 T6 / DD8 — the gate's nine rules, as ARITHMETIC.
 *
 * `qcLine` is pure, so these legs need no database and no fixtures beyond a context object. That is
 * the point of the split: **A13, A15 and A16 are questions about numbers and dates**, and asking
 * them through a GRN would bury each one under a vendor, a store, a batch and a challan.
 *
 * ═══ THE §2.102 COINCIDENCES, BROKEN ═══
 *
 *   · **`mrp = cost`** is A15's DISCRIMINATING leg and is used on purpose — which is exactly why
 *     every OTHER leg here gives them different values.
 *   · **a 3-year shelf life** makes both of A13's bounds land on 183 days and cannot discriminate,
 *     so the A13 legs use an item whose shelf life is 180 days.
 *   · **a strip of 1** would make the MRP conversion invisible, so every UoM table below has a
 *     non-unit pack.
 */
const TABLETS: UomRow[] = [
  { uom: "tablet", toBaseMultiplier: 1 },
  { uom: "strip", toBaseMultiplier: 10 },
  { uom: "box", toBaseMultiplier: 100 },
];

const CHALLAN = "2026-08-27";

function ctx(over: Partial<QcContext> = {}): QcContext {
  return {
    item: { id: "it1", class: "drug", active: true, shelfLifeDays: 1095 },
    uoms: TABLETS,
    ceilingPaisePerBase: null,
    ceilingUnconvertible: false,
    batchFrozen: false,
    hasConsignmentAgreement: true,
    source: "challan",
    challanDate: CHALLAN,
    ...over,
  };
}

function line(over: Partial<QcLine> = {}): QcLine {
  return {
    itemId: "it1", uom: "box", qtyBase: 300,
    batchNo: "B-001", expiryDate: "2028-06-30",
    // MRP 8500 paise a STRIP = 850 a tablet; cost 700 a tablet. They DIFFER (§2.102).
    mrpPaise: 8500, mrpUom: "strip", unitCostPaise: 700,
    freeGoods: false,
    ...over,
  };
}

describe("the GRN gate's rules (Plan 14 T6 / DD8)", () => {
  it("a clean line PASSES — the baseline every refusal below is measured against", () => {
    expect(qcLine(ctx(), line())).toEqual({ verdict: "pass" });
  });

  // ─────────────────── rules 1 and 2 ───────────────────

  it("rule 1: an unknown item, and an INACTIVE one, are refused with different codes", () => {
    expect(qcLine(ctx({ item: undefined }), line())).toEqual({ verdict: "reject", rule: "item_unknown" });
    expect(qcLine(ctx({ item: { id: "it1", class: "drug", active: false, shelfLifeDays: 1095 } }), line()))
      .toEqual({ verdict: "reject", rule: "item_inactive" });
  });

  it("rule 2: a UoM that is not THIS item's is refused, even if it is a real unit elsewhere", () => {
    expect(qcLine(ctx(), line({ uom: "vial" }))).toEqual({ verdict: "reject", rule: "uom_unknown" });
    // …and the item's own units pass, case-insensitively.
    expect(qcLine(ctx(), line({ uom: "BOX" }))).toEqual({ verdict: "pass" });
  });

  // ─────────────────── rules 3 and 4 ───────────────────

  it("rule 3: batch and expiry are mandatory for the batch-tracked classes, and optional otherwise", () => {
    expect(qcLine(ctx(), line({ batchNo: null }))).toEqual({ verdict: "reject", rule: "batch_required" });
    expect(qcLine(ctx(), line({ batchNo: "  " }))).toEqual({ verdict: "reject", rule: "batch_required" });
    expect(qcLine(ctx(), line({ expiryDate: null }))).toEqual({ verdict: "reject", rule: "expiry_required" });
    // A `stationery` item has neither, and that is legal — the list is per class, not universal.
    const stationery = ctx({ item: { id: "it2", class: "stationery", active: true, shelfLifeDays: null } });
    expect(qcLine(stationery, line({ batchNo: null, expiryDate: null, mrpPaise: null, mrpUom: null })))
      .toEqual({ verdict: "pass" });
    // …and so do the other three mandatory classes, so the constant is read rather than hardcoded.
    for (const cls of ["consumable_dated", "reagent", "implant"]) {
      expect({ cls, v: qcLine(ctx({ item: { id: "x", class: cls, active: true, shelfLifeDays: 1095 } }), line({ batchNo: null })) })
        .toEqual({ cls, v: { verdict: "reject", rule: "batch_required" } });
    }
    // `consumable` (undated) is NOT in the list — the distinction the two class names exist for.
    const consumable = ctx({ item: { id: "it3", class: "consumable", active: true, shelfLifeDays: null } });
    expect(qcLine(consumable, line({ batchNo: null, expiryDate: null, mrpPaise: null, mrpUom: null })))
      .toEqual({ verdict: "pass" });
  });

  it("rule 4: an expiry ON or BEFORE the challan date is expired, not near-expiry", () => {
    expect(qcLine(ctx(), line({ expiryDate: "2026-08-26" }))).toEqual({ verdict: "reject", rule: "expired" });
    // ON the day it is received is expired for every purpose that matters — `<= 0`, not `< 0`.
    expect(qcLine(ctx(), line({ expiryDate: CHALLAN }))).toEqual({ verdict: "reject", rule: "expired" });
    // One day later is not expired — but it IS near-expiry, which is rule 5's business.
    expect(qcLine(ctx(), line({ expiryDate: "2026-08-28" })))
      .toEqual({ verdict: "near_expiry", rule: "near_expiry" });
  });

  // ═══════════════════ A13 — O-2's `min` BOUND ═══════════════════

  /**
   * **A13, with the plan's discriminating input.** An item whose `shelf_life_days` is 180 and a
   * batch expiring in 150 days: 75% of 180 is 135, the LOWER bound wins, and 150 ≥ 135 PASSES. A
   * six-month-only mutant marks it `near_expiry` because 150 < 183.
   *
   * **An item with a three-year shelf life does not discriminate** — both bounds land on 183 — and
   * that leg is here as the control the plan names.
   */
  it("A13: the bound is min(6 months, 75% of the item's OWN shelf life)", () => {
    const shortLife = ctx({ item: { id: "r1", class: "reagent", active: true, shelfLifeDays: 180 } });
    // 150 days of residual life on a 180-day reagent. 75% of 180 = 135. 150 >= 135 → PASS.
    expect(daysBetween(CHALLAN, "2027-01-24")).toBe(150);
    expect(qcLine(shortLife, line({ expiryDate: "2027-01-24", mrpPaise: null, mrpUom: null })))
      .toEqual({ verdict: "pass" });
    // …and 130 days, below BOTH bounds, is near-expiry — so the rule is not simply "always pass".
    expect(daysBetween(CHALLAN, "2027-01-04")).toBe(130);
    expect(qcLine(shortLife, line({ expiryDate: "2027-01-04", mrpPaise: null, mrpUom: null })))
      .toEqual({ verdict: "near_expiry", rule: "near_expiry" });

    // THE CONTROL: a three-year item. Both bounds are 183, so a six-month-only implementation and
    // the shipped one agree on every input — which is why the plan says this shape cannot
    // discriminate.
    const longLife = ctx({ item: { id: "d1", class: "drug", active: true, shelfLifeDays: 1095 } });
    expect(nearExpiryMinDays(1095)).toBe(183);
    expect(nearExpiryMinDays(180)).toBe(135);
    // 150 days on the THREE-YEAR item is near-expiry (150 < 183) — the same residual life, the
    // opposite verdict, decided entirely by the item's own shelf life.
    expect(qcLine(longLife, line({ expiryDate: "2027-01-24" })))
      .toEqual({ verdict: "near_expiry", rule: "near_expiry" });
  });

  it("A13: a NULL shelf life falls back to the six-month bound rather than to no bound", () => {
    expect(nearExpiryMinDays(null)).toBe(183);
    const unknownLife = ctx({ item: { id: "u1", class: "implant", active: true, shelfLifeDays: null } });
    expect(qcLine(unknownLife, line({ expiryDate: "2026-12-31", mrpPaise: 100000, mrpUom: "tablet", unitCostPaise: 90000 })))
      .toEqual({ verdict: "near_expiry", rule: "near_expiry" });
    // …and beyond it, passes.
    expect(qcLine(unknownLife, line({ expiryDate: "2027-12-31", mrpPaise: 100000, mrpUom: "tablet", unitCostPaise: 90000 })))
      .toEqual({ verdict: "pass" });
  });

  // ═══════════════════ A15 — `<`, NOT `<=` ═══════════════════

  /**
   * **A15, and the fixture is `mrp_paise = unit_cost_paise` USED ON PURPOSE.** The shipped rule is
   * `<`, so an MRP EQUAL to cost passes; a `<=` mutant rejects it. This is the one leg in the phase
   * where §2.102's coinciding pair is the discriminating input rather than the trap — which is why
   * every other fixture in this file gives them different values.
   */
  it("A15: mrp_below_cost fires on `<` and NOT on equality", () => {
    // EQUAL, in one unit: 8500 paise a strip of 10 is 850 a tablet, and cost is 850 a tablet.
    expect(qcLine(ctx(), line({ mrpPaise: 8500, mrpUom: "strip", unitCostPaise: 850 })))
      .toEqual({ verdict: "pass" });
    // ONE PAISA below — refused. The boundary is exact.
    expect(qcLine(ctx(), line({ mrpPaise: 8500, mrpUom: "strip", unitCostPaise: 851 })))
      .toEqual({ verdict: "reject", rule: "mrp_below_cost" });
    // Comfortably above — passes.
    expect(qcLine(ctx(), line({ mrpPaise: 8500, mrpUom: "strip", unitCostPaise: 700 })))
      .toEqual({ verdict: "pass" });
  });

  /**
   * **FREE GOODS NEVER TRIGGER RULE 6**, and it is the same fact as `<` rather than `<=`: nothing is
   * less than zero. A bonus carton is a real commercial event with full batch discipline and a
   * landed cost of 0 (DD8), and a `<=` would reject every one of them.
   */
  it("A15: a free-goods line (cost 0) never trips mrp_below_cost", () => {
    expect(qcLine(ctx(), line({ unitCostPaise: 0, freeGoods: true }))).toEqual({ verdict: "pass" });
    // Even with an MRP of zero, which is the degenerate case: 0 < 0 is false.
    expect(qcLine(ctx(), line({ mrpPaise: 0, mrpUom: "strip", unitCostPaise: 0, freeGoods: true })))
      .toEqual({ verdict: "pass" });
  });

  it("rule 6: MRP is mandatory for `drug` and `implant`, and optional elsewhere", () => {
    expect(qcLine(ctx(), line({ mrpPaise: null, mrpUom: null })))
      .toEqual({ verdict: "reject", rule: "mrp_required" });
    const implant = ctx({ item: { id: "i1", class: "implant", active: true, shelfLifeDays: 1095 } });
    expect(qcLine(implant, line({ mrpPaise: null, mrpUom: null })))
      .toEqual({ verdict: "reject", rule: "mrp_required" });
    // A glove has a cost and no consumer price at all — demanding one would make somebody invent it.
    const glove = ctx({ item: { id: "g1", class: "consumable", active: true, shelfLifeDays: null } });
    expect(qcLine(glove, line({ batchNo: null, expiryDate: null, mrpPaise: null, mrpUom: null })))
      .toEqual({ verdict: "pass" });
  });

  // ─────────────────── rule 7 — the ceiling ───────────────────

  it("rule 7: an MRP above a notified ceiling is a HARD block, and equality is not", () => {
    // Ceiling 850 a tablet; MRP 8500 a strip = 850 a tablet. EQUAL → allowed.
    expect(qcLine(ctx({ ceilingPaisePerBase: 850 }), line({ mrpPaise: 8500, mrpUom: "strip" })))
      .toEqual({ verdict: "pass" });
    // One paisa above → refused. Selling above ceiling is the offence and the gate is the cheapest
    // place to stop it (doc 16 D2).
    expect(qcLine(ctx({ ceilingPaisePerBase: 849 }), line({ mrpPaise: 8500, mrpUom: "strip" })))
      .toEqual({ verdict: "reject", rule: "mrp_above_ceiling" });
    // NO ceiling in force → nothing to breach.
    expect(qcLine(ctx({ ceilingPaisePerBase: null }), line({ mrpPaise: 9999990, mrpUom: "strip" })))
      .toEqual({ verdict: "pass" });
  });

  /**
   * ═══ CLOSE REVIEW M7 — AN UNCONVERTIBLE CEILING REJECTS THE LINE, AND DOES NOT PASS IT ═══
   *
   * The two null-ish states are NOT the same and this is the leg that says so. `ceilingPaisePerBase:
   * null` means *no ceiling was notified* — nothing to breach, pass. `ceilingUnconvertible: true`
   * means *a ceiling WAS notified and could not be put in the line's unit* — a rule the government
   * imposed that we are unable to evaluate, which must fail CLOSED.
   *
   * Before M7 there was no second state: `qcContextFor` let `mrpPerBaseUnit` THROW, the exception
   * left `runGateQc`, and the caller got **404 on the whole GRN**. So the first assertion here is
   * against the old behaviour twice over — the verdict was neither `pass` nor `reject`, it was an
   * HTTP status for a document the storekeeper was holding in their hand.
   */
  it("rule 7: a ceiling that CANNOT be converted rejects the LINE — it never passes it (M7)", () => {
    // The default line is MRP 8500/strip = 850 a tablet against a cost of 700 — comfortably ABOVE
    // cost, so rule 6 passes and rule 7 is genuinely the rule under test.
    expect(qcLine(ctx({ ceilingUnconvertible: true }), line()))
      .toEqual({ verdict: "reject", rule: "mrp_unconvertible" });
    /**
     * **The discriminating pair, and it is the whole point of the finding.** Identical line;
     * `ceilingPaisePerBase` is `null` in BOTH cases, because there is no usable number either way;
     * opposite verdicts. An implementation that collapses "no ceiling notified" and "a ceiling was
     * notified and cannot be converted" into one `null` — which is exactly what shipped, by letting
     * the conversion THROW and catching nothing — cannot satisfy both of these at once.
     */
    expect(qcLine(ctx({ ceilingPaisePerBase: null, ceilingUnconvertible: false }), line()))
      .toEqual({ verdict: "pass" });
    // It rejects an MRP that would have been under any plausible ceiling too: the point is that the
    // comparison could not be MADE, not that it failed.
    expect(qcLine(ctx({ ceilingUnconvertible: true }), line({ mrpPaise: 7100, mrpUom: "strip" })))
      .toEqual({ verdict: "reject", rule: "mrp_unconvertible" });
    // Rule ORDER is preserved: rule 6 still runs first, so an MRP below cost is reported as such
    // rather than being masked by the unconvertible ceiling downstream of it.
    expect(qcLine(ctx({ ceilingUnconvertible: true }), line({ unitCostPaise: 900 })))
      .toEqual({ verdict: "reject", rule: "mrp_below_cost" });
  });

  // ─────────────────── rules 8 and 9 ───────────────────

  /**
   * F9 — an MRP that cannot be expressed in whole paise per base unit is a LINE rejection, not an
   * exception. `mrpPerBaseUnit` refuses ₹85 on a strip of 12 rather than rounding it (the right
   * call), and `qcLine` catches that refusal so one mistyped price rejects one line instead of
   * aborting the whole delivery's QC run. The plan's nine rules do not name this case.
   */
  it("F9: an MRP that does not divide into whole paise per base unit rejects the LINE", () => {
    const odd: UomRow[] = [{ uom: "tablet", toBaseMultiplier: 1 }, { uom: "strip", toBaseMultiplier: 12 }];
    expect(qcLine(ctx({ uoms: odd }), line({ uom: "tablet", mrpPaise: 8500, mrpUom: "strip" })))
      .toEqual({ verdict: "reject", rule: "mrp_unconvertible" });
    // …and one that DOES divide goes on to be compared normally.
    expect(qcLine(ctx({ uoms: odd }), line({ uom: "tablet", mrpPaise: 8400, mrpUom: "strip", unitCostPaise: 700 })))
      .toEqual({ verdict: "pass" });
  });

  it("rule 8: a recall-frozen batch refuses a NEW receipt", () => {
    expect(qcLine(ctx({ batchFrozen: true }), line())).toEqual({ verdict: "reject", rule: "batch_frozen" });
  });

  /**
   * **A16's rule, as a boolean.** The DATE arithmetic that produces the boolean is
   * `hasValidDocument`'s and is tested in `vendors.test.ts` against a window that has CLOSED;
   * here what is pinned is that the gate CONSULTS it, and only for a consignment challan.
   */
  it("rule 9 (O-8): a consignment challan needs the agreement; other sources do not", () => {
    expect(qcLine(ctx({ source: "consignment_challan", hasConsignmentAgreement: false }), line()))
      .toEqual({ verdict: "reject", rule: "agreement_missing" });
    expect(qcLine(ctx({ source: "consignment_challan", hasConsignmentAgreement: true }), line()))
      .toEqual({ verdict: "pass" });
    // A plain challan and a donation are not asked the question at all.
    expect(qcLine(ctx({ source: "challan", hasConsignmentAgreement: false }), line()))
      .toEqual({ verdict: "pass" });
    expect(qcLine(ctx({ source: "donation", hasConsignmentAgreement: false }), line()))
      .toEqual({ verdict: "pass" });
  });

  // ─────────────────── THE ORDER IS THE SEMANTICS ───────────────────

  /**
   * **The FIRST failure is the verdict**, and that is a decision rather than an accident: the code
   * a storekeeper is shown must be the one they have to fix first. A line that is simultaneously
   * expired AND priced below cost AND on a frozen batch reports `expired`, because until the date
   * is right nothing else about the line is worth arguing over.
   */
  it("the FIRST failing rule is the verdict — the order is the semantics", () => {
    const doomed = line({
      uom: "vial",              // rule 2
      batchNo: null,            // rule 3
      expiryDate: "2020-01-01", // rule 4
      mrpPaise: 10, mrpUom: "strip", unitCostPaise: 99999, // rule 6
    });
    // Rule 2 fires first, even though four rules would.
    expect(qcLine(ctx({ batchFrozen: true }), doomed)).toEqual({ verdict: "reject", rule: "uom_unknown" });
    // Fix the UoM: rule 3.
    expect(qcLine(ctx({ batchFrozen: true }), { ...doomed, uom: "box" }))
      .toEqual({ verdict: "reject", rule: "batch_required" });
    // Fix the batch: rule 4.
    expect(qcLine(ctx({ batchFrozen: true }), { ...doomed, uom: "box", batchNo: "B-1" }))
      .toEqual({ verdict: "reject", rule: "expired" });
    // Fix the date: rule 6 — and only then rule 8.
    expect(qcLine(ctx({ batchFrozen: true }), { ...doomed, uom: "box", batchNo: "B-1", expiryDate: "2028-06-30" }))
      .toEqual({ verdict: "reject", rule: "mrp_below_cost" });
    expect(qcLine(ctx({ batchFrozen: true }), {
      ...doomed, uom: "box", batchNo: "B-1", expiryDate: "2028-06-30", mrpPaise: 8500, unitCostPaise: 700,
    })).toEqual({ verdict: "reject", rule: "batch_frozen" });
  });

  it("daysBetween counts whole calendar days, across a month boundary and a leap day", () => {
    expect(daysBetween("2026-08-27", "2026-08-28")).toBe(1);
    expect(daysBetween("2026-08-31", "2026-09-01")).toBe(1);
    // 2028 is a leap year: Feb has 29 days.
    expect(daysBetween("2028-02-28", "2028-03-01")).toBe(2);
    expect(daysBetween("2027-02-28", "2027-03-01")).toBe(1);
    expect(daysBetween("2026-08-27", "2026-08-27")).toBe(0);
    expect(daysBetween("2026-08-27", "2026-08-26")).toBe(-1);
  });
});
