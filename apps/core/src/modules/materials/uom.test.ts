import { MaterialsError } from "./errors";
import { fromBase, mrpPerBaseUnit, multiplierFor, toBase } from "./uom";
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
   * **IT REFUSES RATHER THAN ROUNDS**, and the reason is rule 6: rounding down would let an MRP a
   * paisa below cost pass, rounding up would fail a legitimate line, and either invents a number
   * inside a price comparison. ₹85 on a strip of 12 has no honest integer answer.
   */
  it("REFUSES an MRP that does not divide into whole paise per base unit", () => {
    const odd: UomRow[] = [{ uom: "tablet", toBaseMultiplier: 1 }, { uom: "strip", toBaseMultiplier: 12 }];
    expect(() => mrpPerBaseUnit(odd, 8500, "strip")).toThrow(/does not.*divide/);
    // …and one that DOES divide passes, so the guard is not simply refusing everything.
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
