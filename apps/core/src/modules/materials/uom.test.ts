import { MaterialsError } from "./errors";
import { comparePackPrices, fromBase, mrpPerBaseUnit, multiplierFor, packPriceOf, saleAmountPaise, toBase } from "./uom";
import type { UomRow } from "./uom";

/**
 * PLAN 14 T3 / DD7 — `uom.ts`, the ONE place a multiplier is applied.
 *
 * Pure functions, so no database: what is asserted is arithmetic and refusal.
 *
 * ═══ THE FIXTURES DIFFER ON PURPOSE (§2.102) ═══
 *
 * The standing fixture note for this phase names `qty_in_uom = qty_base` (multiplier 1) as a
 * coincidence that hides every conversion defect. So **no fixture below uses a multiplier of 1 for
 * a non-base unit**, and A2's own pair — `TABLETS` whose box is 10, `VIALS` whose box is 24 — exists
 * precisely so the two items disagree about what a "box" means.
 */

/** Item X: tablet base, strip of 10, box of 10 strips = 100. */
const TABLETS: UomRow[] = [
  { uom: "tablet", toBaseMultiplier: 1 },
  { uom: "strip", toBaseMultiplier: 10 },
  { uom: "box", toBaseMultiplier: 100 },
];

/** Item Y: the SAME unit names, DIFFERENT multipliers. A2's discriminating fixture. */
const VIALS: UomRow[] = [
  { uom: "vial", toBaseMultiplier: 1 },
  { uom: "box", toBaseMultiplier: 24 },
];

describe("uom.ts — conversion (Plan 14 T3 / DD7)", () => {
  // ─────────────────────────── A2: the multiplier belongs to the ITEM ───────────────────────────

  /**
   * A2's assertion, and its fixture is the plan's own discriminating input: TWO items whose `box`
   * differs. A `toBase` that returned `qty * 10` for any non-base unit passes every single leg
   * involving `TABLETS` and fails the `VIALS` leg — which is why a one-item test cannot prove this
   * function reads the item's table rather than a literal.
   */
  it("multiplies through the item's OWN table — the same unit NAME means different things", () => {
    expect(toBase(TABLETS, "box", 3)).toBe(300);
    expect(toBase(VIALS, "box", 3)).toBe(72);
    // One box of each, side by side: the number a literal-10 implementation cannot produce.
    expect(toBase(VIALS, "box", 1)).toBe(24);
    expect(toBase(TABLETS, "box", 1)).toBe(100);
    expect(toBase(TABLETS, "strip", 1)).toBe(10);
    // The base unit is the identity, and it is a real row rather than a special case in the code.
    expect(toBase(TABLETS, "tablet", 7)).toBe(7);
  });

  it("matches the unit name case-insensitively — a code is typed by a human", () => {
    expect(toBase(TABLETS, "BOX", 2)).toBe(200);
    expect(toBase(TABLETS, "  Strip ", 2)).toBe(20);
    expect(multiplierFor(VIALS, "Box")).toBe(24);
  });

  /**
   * **NEVER a fallback to 1.** An unrecognised unit treated as a base unit would post a hundredth
   * of a delivery to the ledger and look like a small delivery, which is the failure mode a
   * `?? 1` produces and the reason this function throws.
   */
  it("REFUSES a unit the item does not have, rather than assuming it is the base", () => {
    expect(() => toBase(TABLETS, "carton", 1)).toThrow(MaterialsError);
    expect(() => toBase(TABLETS, "carton", 1)).toThrow(/not one of this item's units/);
    try {
      toBase(TABLETS, "carton", 1);
    } catch (e) {
      expect((e as MaterialsError).code).toBe("unknown_uom");
    }
    // `vial` is a real unit — of the OTHER item. Being a legal string somewhere is not being one here.
    expect(() => toBase(TABLETS, "vial", 1)).toThrow(/not one of this item's units/);
  });

  it("REFUSES a fractional quantity — this module has no fractional quantities (DD7)", () => {
    expect(() => toBase(TABLETS, "strip", 2.5)).toThrow(/not an integer/);
    expect(() => fromBase(TABLETS, "strip", 2.5)).toThrow(/not an integer/);
  });

  /**
   * A multiplier of zero or a negative one is refused by `item_uoms_multiplier_ck` at the database,
   * so reaching this branch means raw SQL wrote the row. Multiplying by zero would turn a delivery
   * into nothing, silently — this is the leg that says the function refuses instead.
   */
  it("REFUSES a non-positive multiplier that reached the row through raw SQL", () => {
    const corrupt: UomRow[] = [{ uom: "each", toBaseMultiplier: 0 }];
    expect(() => toBase(corrupt, "each", 5)).toThrow(/not a positive integer/);
    expect(() => toBase([{ uom: "each", toBaseMultiplier: -3 }], "each", 5)).toThrow(/not a positive integer/);
  });

  // ─────────────────────────── fromBase: the remainder is not hidden ───────────────────────────

  /**
   * 7 tablets of a strip of 10 is not "1 strip" and not "0 strips". The type forces the caller to
   * look at both halves, which is what stops a shelf display rounding a part-pack away.
   */
  it("returns the remainder rather than rounding it, in both directions", () => {
    expect(fromBase(TABLETS, "strip", 7)).toEqual({ whole: 0, remainderBase: 7 });
    expect(fromBase(TABLETS, "strip", 23)).toEqual({ whole: 2, remainderBase: 3 });
    expect(fromBase(TABLETS, "box", 250)).toEqual({ whole: 2, remainderBase: 50 });
    // Exact division still reports a zero remainder rather than omitting it.
    expect(fromBase(TABLETS, "box", 300)).toEqual({ whole: 3, remainderBase: 0 });
    // NEGATIVE quantities truncate toward zero on both parts, so an outbound movement reads the
    // same way as the inbound one it reverses.
    expect(fromBase(TABLETS, "strip", -7)).toEqual({ whole: 0, remainderBase: -7 });
    expect(fromBase(TABLETS, "strip", -23)).toEqual({ whole: -2, remainderBase: -3 });
  });

  it("round-trips: toBase then fromBase returns what went in", () => {
    for (const qty of [1, 3, 17, 250]) {
      const base = toBase(TABLETS, "strip", qty);
      expect(fromBase(TABLETS, "strip", base)).toEqual({ whole: qty, remainderBase: 0 });
    }
  });

  // ─────────────────────── mrpPerBaseUnit: DD8 rule 6's operands, in one unit ───────────────────────

  /**
   * The §2.93 case: a formula verified where its operands DIFFER. An MRP is per PACK and a landed
   * cost is per BASE unit, so rule 6 can only compare them after this function has moved one of
   * them — and every leg below uses a pack whose multiplier is not 1, because a strip of 1 would
   * make the conversion invisible.
   */
  it("expresses a pack MRP per base unit, so rule 6 compares like with like", () => {
    // ₹85.00 a strip of 10 = 85 paise a tablet.
    expect(mrpPerBaseUnit(TABLETS, 8500, "strip")).toBe(850);
    expect(mrpPerBaseUnit(TABLETS, 8500, "box")).toBe(85);
    // The base unit itself needs no conversion and still goes through the same path.
    expect(mrpPerBaseUnit(TABLETS, 850, "tablet")).toBe(850);
    // …and the OTHER item's box, so this leg cannot pass on a literal either.
    expect(mrpPerBaseUnit(VIALS, 2400, "box")).toBe(100);
  });

  /**
   * THE LOOSE-MRP RULING (owner, money, 2026-09-22) REPLACED "IT REFUSES RATHER THAN ROUNDS". ₹85 on
   * a strip of 12 used to throw here; it now gives the LOOSE-unit rate, rounded DOWN (708), which is
   * never above the MRP's share. Comparisons no longer read this number at all — they compare the
   * printed pair exactly (`comparePackPrices`, below), so the old reason for refusing is gone.
   */
  it("an MRP that does not divide gives the loose-unit rate ROUNDED DOWN — never above the share", () => {
    const odd: UomRow[] = [{ uom: "tablet", toBaseMultiplier: 1 }, { uom: "strip", toBaseMultiplier: 12 }];
    expect(mrpPerBaseUnit(odd, 8500, "strip")).toBe(708);
    expect(mrpPerBaseUnit([{ uom: "tablet", toBaseMultiplier: 1 }, { uom: "strip", toBaseMultiplier: 15 }], 3550, "strip")).toBe(236);
    // …and one that DOES divide is exact, as it always was.
    expect(mrpPerBaseUnit(odd, 8400, "strip")).toBe(700);
  });

  it("null MRP is a legal state and is not an error; MRP without its unit is", () => {
    // DD8 rule 6 demands an MRP only for `drug` and `implant`; a box of gloves has none.
    expect(mrpPerBaseUnit(TABLETS, null, null)).toBeNull();
    expect(mrpPerBaseUnit(TABLETS, undefined, "strip")).toBeNull();
    // The pair rule: paise never travels without its unit (schema/materials.ts's header).
    expect(() => mrpPerBaseUnit(TABLETS, 8500, null)).toThrow(/no unit/);
  });
});

describe("the loose-MRP ruling — saleAmountPaise (owner, money, 2026-09-22)", () => {
  const strip15 = (qtyBase: number) => saleAmountPaise({ mrpPaise: 3550, packMultiplier: 15, qtyBase });

  it("₹35.50 a strip of 15: a strip is EXACTLY its MRP, a loose tablet its share rounded down", () => {
    expect(strip15(15)).toEqual({ amountPaise: 3550, unitPaise: 236, fullPacks: 1, looseUnits: 0, packResiduePaise: 10 });
    expect(strip15(1)).toEqual({ amountPaise: 236, unitPaise: 236, fullPacks: 0, looseUnits: 1, packResiduePaise: 10 });
    expect(strip15(20).amountPaise).toBe(4730); // 1 × 3550 + 5 × 236
    expect(strip15(0).amountPaise).toBe(0);
  });

  it("never above the MRP's share, for every quantity up to ten strips", () => {
    for (let q = 0; q <= 150; q += 1) {
      const a = strip15(q).amountPaise;
      expect(a * 15).toBeLessThanOrEqual(3550 * q); // amount ≤ q × 3550/15, compared without dividing
      expect(a).toBeGreaterThanOrEqual(236 * q);
    }
  });

  it("a pack that divides changes nothing: q × (MRP / pack)", () => {
    for (const q of [1, 7, 10, 23]) expect(saleAmountPaise({ mrpPaise: 12000, packMultiplier: 10, qtyBase: q }).amountPaise).toBe(1200 * q);
  });

  it("refuses a fractional quantity or a non-positive pack", () => {
    expect(() => saleAmountPaise({ mrpPaise: 3550, packMultiplier: 15, qtyBase: 1.5 })).toThrow(MaterialsError);
    expect(() => saleAmountPaise({ mrpPaise: 3550, packMultiplier: 0, qtyBase: 1 })).toThrow(MaterialsError);
  });
});

describe("comparePackPrices — per base unit, exactly, by cross-multiplication", () => {
  it("₹35.50/15 sits strictly between 236 and 237 a tablet", () => {
    const mrp = packPriceOf([{ uom: "tablet", toBaseMultiplier: 1 }, { uom: "strip", toBaseMultiplier: 15 }], 3550, "strip")!;
    expect(mrp).toEqual({ paise: 3550, baseUnits: 15 });
    expect(comparePackPrices(mrp, { paise: 236, baseUnits: 1 })).toBe(1);
    expect(comparePackPrices(mrp, { paise: 237, baseUnits: 1 })).toBe(-1);
    expect(comparePackPrices(mrp, { paise: 7100, baseUnits: 30 })).toBe(0);
  });

  it("packPriceOf keeps the unit refusals", () => {
    expect(packPriceOf(TABLETS, null, null)).toBeNull();
    expect(() => packPriceOf(TABLETS, 8500, null)).toThrow(/no unit/);
    expect(() => packPriceOf(TABLETS, 8500, "carton")).toThrow(MaterialsError);
  });
});
