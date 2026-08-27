import { MaterialsError } from "./errors";

/**
 * PLAN 14 T3 / DD7 — **THE ONE PLACE A MULTIPLIER IS APPLIED.**
 *
 * ═══ WHY THIS IS A FILE AND NOT THREE LINES INSIDE `grn.ts` ═══
 *
 * Quantities in this module are INTEGERS in the item's BASE UoM. A GRN line captured as "3 boxes"
 * is stored `qty_in_uom = 3, uom = 'box', qty_base = 300`, and every ledger row, every balance and
 * every FEFO pick is in base units. There is therefore exactly one arithmetic step in the whole
 * phase that can be wrong in a way nobody notices: the multiplication between what a storekeeper
 * typed and what the ledger records. Six callers doing it inline would be six chances; one pure
 * function is one.
 *
 * **The multiplier belongs to the ITEM, never to the UoM NAME.** A "box" is 10 strips of one drug
 * and 24 vials of another, and both are correct. A2's mutant is a `toBase` that returns `qty * 10`
 * for anything non-base — which passes every fixture whose box happens to hold ten, which is most
 * of them (§2.102). The discriminating input is therefore TWO items whose `box` differs, and this
 * function's signature is what makes that expressible: it takes the item's OWN UoM ROWS, not a
 * global table and not a name.
 *
 * ═══ IT NEVER ROUNDS, AND `fromBase` RETURNS THE REMAINDER RATHER THAN HIDING IT ═══
 *
 * 7 tablets of an item whose strip is 10 is not "1 strip" and it is not "0 strips". It is zero
 * strips and seven tablets, and a function that answered either integer alone would be lying to a
 * screen that shows a storekeeper what is on a shelf. `fromBase` therefore returns `{ whole,
 * remainderBase }` and the caller has to look at both — the type is the enforcement.
 *
 * The same rule stops a rounding step nobody audited from appearing between an MRP printed on a
 * strip and a landed cost per tablet (DD7, ledger §2.93). `mrpPerBaseUnit` below is the ONE place
 * that conversion happens, and it refuses rather than rounds when the MRP does not divide evenly.
 */

/** One row of `item_uoms`, in the shape this module's callers hold it. */
export type UomRow = { uom: string; toBaseMultiplier: number };

/**
 * The multiplier for `uom` among THIS item's rows, matched case-insensitively (a code is typed by
 * a human and `Box` is `box`). Throws `unknown_uom` — never falls back to 1, which would silently
 * treat an unrecognised unit as a base unit and post a hundredth of a delivery to the ledger.
 */
export function multiplierFor(uoms: readonly UomRow[], uom: string): number {
  const wanted = uom.trim().toLowerCase();
  const row = uoms.find((u) => u.uom.trim().toLowerCase() === wanted);
  if (row === undefined) {
    throw new MaterialsError(
      "unknown_uom",
      `"${uom}" is not one of this item's units of measure (it has: ${uoms.map((u) => u.uom).join(", ") || "none"})`,
      { uom, known: uoms.map((u) => u.uom) },
    );
  }
  // A non-positive multiplier is refused by `item_uoms_multiplier_ck` at the database, so reaching
  // this branch means somebody wrote the row with raw SQL. Refusing here rather than multiplying
  // by zero is the difference between an error and a silent zero-quantity receipt.
  if (!Number.isSafeInteger(row.toBaseMultiplier) || row.toBaseMultiplier <= 0) {
    throw new MaterialsError(
      "unknown_uom",
      `unit "${uom}" carries a multiplier of ${String(row.toBaseMultiplier)}, which is not a positive integer`,
      { uom, multiplier: row.toBaseMultiplier },
    );
  }
  return row.toBaseMultiplier;
}

/**
 * `qty` of `uom` expressed in BASE units. Pure; the item's own rows decide, never the name (A2).
 *
 * `qty` must itself be a safe integer: this module has no fractional quantities anywhere, and
 * accepting 2.5 boxes here would put a fraction into a column typed `integer`, where Postgres would
 * round it — a rounding step nobody audited, one layer below where anybody would look for it.
 */
export function toBase(uoms: readonly UomRow[], uom: string, qty: number): number {
  if (!Number.isSafeInteger(qty)) {
    throw new MaterialsError(
      "unknown_uom",
      `quantity ${String(qty)} is not an integer — this module has no fractional quantities (DD7)`,
      { qty },
    );
  }
  return qty * multiplierFor(uoms, uom);
}

/**
 * BASE units expressed in `uom`, WITH THE REMAINDER. See the file header: 7 tablets of a strip of
 * 10 is `{ whole: 0, remainderBase: 7 }`, and a caller that ignores `remainderBase` is a caller
 * showing a storekeeper the wrong number.
 *
 * Negative quantities are allowed and truncate toward zero on both parts, so `fromBase(-7, strip
 * of 10)` is `{ whole: 0, remainderBase: -7 }` — an outbound movement reads the same way as the
 * inbound one it reverses.
 */
export function fromBase(
  uoms: readonly UomRow[],
  uom: string,
  qtyBase: number,
): { whole: number; remainderBase: number } {
  if (!Number.isSafeInteger(qtyBase)) {
    throw new MaterialsError(
      "unknown_uom",
      `quantity ${String(qtyBase)} is not an integer — this module has no fractional quantities (DD7)`,
      { qtyBase },
    );
  }
  const multiplier = multiplierFor(uoms, uom);
  // `+ 0` normalises NEGATIVE ZERO. `Math.trunc(-7 / 10)` is `-0`, which is `=== 0` but which
  // `Object.is`, `toEqual` and `JSON.stringify` all treat as its own value — so a caller comparing
  // two results, or a screen rendering one, can be handed "-0 strips". Found by the test that
  // asserted `{ whole: 0 }` for -7 base units and got `{ whole: -0 }`; kept as a normalisation
  // rather than as a test that accepts either, because the value a reader should never see is the
  // one that should never be produced.
  const whole = Math.trunc(qtyBase / multiplier) + 0;
  return { whole, remainderBase: qtyBase - whole * multiplier };
}

/**
 * DD7's money half — an MRP printed on a PACK, expressed per BASE unit, so it can be compared with
 * a landed cost that is already per base unit (DD8 rule 6, A15).
 *
 * **It REFUSES rather than rounds.** ₹85 on a strip of 10 is 850 paise for 10 tablets, which is 85
 * paise a tablet and divides cleanly. ₹85 on a strip of 12 does not, and there is no honest integer
 * answer: rounding down would let an MRP below cost pass rule 6 by a paisa, rounding up would fail
 * a legitimate line, and either would be a rounding step invented inside a comparison. The caller
 * that hits this has a data problem — an MRP or a pack size that is wrong — and needs to be told.
 *
 * Returns `null` when there is no MRP at all, because "this line has no printed price" is a legal
 * state for a non-drug class (DD8 rule 6 only demands MRP for `drug` and `implant`) and is not the
 * same thing as an error.
 */
export function mrpPerBaseUnit(
  uoms: readonly UomRow[],
  mrpPaise: number | null | undefined,
  mrpUom: string | null | undefined,
): number | null {
  if (mrpPaise === null || mrpPaise === undefined) return null;
  if (mrpUom === null || mrpUom === undefined) {
    // The pair rule from `schema/materials.ts`'s header: paise never travels without its unit.
    throw new MaterialsError(
      "unknown_uom",
      "an MRP was given with no unit — an MRP is printed on a pack, and a price without its pack " +
        "cannot be compared with a per-unit cost (DD7)",
      { mrpPaise },
    );
  }
  const multiplier = multiplierFor(uoms, mrpUom);
  if (mrpPaise % multiplier !== 0) {
    throw new MaterialsError(
      "unknown_uom",
      `an MRP of ${String(mrpPaise)} paise per "${mrpUom}" (${String(multiplier)} base units) does not ` +
        `divide into whole paise per base unit — rounding it would invent a number inside a price ` +
        `comparison, so it is refused instead`,
      { mrpPaise, mrpUom, multiplier },
    );
  }
  return mrpPaise / multiplier;
}
