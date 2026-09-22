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
 * strip and a landed cost per tablet (DD7, ledger §2.93). A price is carried as a `PackPrice` —
 * paise FOR a number of base units — and COMPARED by cross-multiplication (`comparePackPrices`),
 * so no comparison ever rounds.
 *
 * ═══ THE LOOSE-MRP RULING (owner, money, 2026-09-22) ═══
 *
 * Most of a real Indian shelf is priced on a strip that does not divide: ₹35.50 on a strip of 15
 * is 236.666… paise a tablet. Until this ruling that MRP was REFUSED (at QC and at the counter).
 * The owner ruled instead: **a FULL pack sells at exactly its printed MRP; a LOOSE unit sells at
 * the per-unit share ROUNDED DOWN to the paisa**, so the patient never pays above MRP. 20 tablets
 * from strips of 15 is 1 × 3550 + 5 × 236 = 4730 paise. `saleAmountPaise` is the one place that
 * arithmetic happens; `mrpPerBaseUnit` is the loose-unit rate it implies.
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
 * A price printed on a pack, kept as a PAIR — `paise` for `baseUnits` base units — so it is never
 * divided before it is compared. ₹35.50 on a strip of 15 is `{ paise: 3550, baseUnits: 15 }`.
 */
export type PackPrice = { paise: number; baseUnits: number };

/**
 * DD7's money half, WITHOUT a division: the printed price and the pack it is printed on, as a
 * `PackPrice`. Returns `null` when there is no price at all — "this line has no printed price" is a
 * legal state for a non-drug class (DD8 rule 6 only demands MRP for `drug` and `implant`).
 *
 * **Still refuses** (`unknown_uom`) a price with no unit, or a unit that is not one of the item's:
 * a price without its pack cannot be compared with anything, and that is a data error, not a
 * rounding question.
 */
export function packPriceOf(
  uoms: readonly UomRow[],
  paise: number | null | undefined,
  uom: string | null | undefined,
): PackPrice | null {
  if (paise === null || paise === undefined) return null;
  if (uom === null || uom === undefined) {
    // The pair rule from `schema/materials.ts`'s header: paise never travels without its unit.
    throw new MaterialsError(
      "unknown_uom",
      "an MRP was given with no unit — an MRP is printed on a pack, and a price without its pack " +
        "cannot be compared with a per-unit cost (DD7)",
      { mrpPaise: paise },
    );
  }
  if (!Number.isSafeInteger(paise) || paise < 0) {
    throw new MaterialsError("unknown_uom", `a price of ${String(paise)} paise is not a whole, non-negative number of paise`, { paise });
  }
  return { paise, baseUnits: multiplierFor(uoms, uom) };
}

/**
 * The sign of `a − b` PER BASE UNIT, exactly: `a.paise × b.baseUnits` vs `b.paise × a.baseUnits`
 * (BigInt, so no product can lose precision). Negative when `a` is cheaper per unit, zero when
 * equal, positive when dearer. This is how QC rule 6 asks "is the MRP below landed cost" of an MRP
 * that does not divide — no rounding step can let a below-cost MRP through by a paisa, or refuse a
 * lawful one by a paisa.
 */
export function comparePackPrices(a: PackPrice, b: PackPrice): -1 | 0 | 1 {
  const left = BigInt(a.paise) * BigInt(b.baseUnits);
  const right = BigInt(b.paise) * BigInt(a.baseUnits);
  return left < right ? -1 : left > right ? 1 : 0;
}

export type SaleAmount = {
  /** What `qtyBase` units cost: full packs at the pack price, the rest at `unitPaise`. */
  amountPaise: number;
  /** The LOOSE-unit rate: `floor(packPaise / packMultiplier)` — exact when the pack divides. */
  unitPaise: number;
  fullPacks: number;
  looseUnits: number;
  /** `packPaise − packMultiplier × unitPaise`: what each full pack carries above `unitPaise` per unit (0 when it divides). */
  packResiduePaise: number;
};

/**
 * THE LOOSE-MRP RULING (owner, money, 2026-09-22), the one place it is computed. PURE.
 *
 *   amount = fullPacks × packPaise + looseUnits × floor(packPaise / packMultiplier)
 *
 * A full pack is its printed price EXACTLY; a loose unit is its share ROUNDED DOWN, so no quantity
 * is ever charged above its share of the MRP. Where the pack divides evenly this is simply
 * `qtyBase × (packPaise / packMultiplier)` — nothing changes for an MRP that divides.
 */
export function saleAmountPaise(input: { mrpPaise: number; packMultiplier: number; qtyBase: number }): SaleAmount {
  const { mrpPaise, packMultiplier, qtyBase } = input;
  if (!Number.isSafeInteger(mrpPaise) || mrpPaise < 0) {
    throw new MaterialsError("unknown_uom", `a pack price of ${String(mrpPaise)} paise is not a whole, non-negative number of paise`, { mrpPaise });
  }
  if (!Number.isSafeInteger(packMultiplier) || packMultiplier <= 0) {
    throw new MaterialsError("unknown_uom", `a pack of ${String(packMultiplier)} base units is not a positive integer`, { packMultiplier });
  }
  if (!Number.isSafeInteger(qtyBase) || qtyBase < 0) {
    throw new MaterialsError("unknown_uom", `quantity ${String(qtyBase)} is not a non-negative integer (DD7)`, { qtyBase });
  }
  const unitPaise = Math.floor(mrpPaise / packMultiplier);
  const fullPacks = Math.floor(qtyBase / packMultiplier);
  const looseUnits = qtyBase - fullPacks * packMultiplier;
  const amountPaise = fullPacks * mrpPaise + looseUnits * unitPaise;
  if (!Number.isSafeInteger(amountPaise)) {
    throw new MaterialsError("unknown_uom", `${String(qtyBase)} units at ${String(mrpPaise)} paise a pack overflows`, { qtyBase, mrpPaise });
  }
  return { amountPaise, unitPaise, fullPacks, looseUnits, packResiduePaise: mrpPaise - packMultiplier * unitPaise };
}

/**
 * The price of ONE LOOSE base unit under the loose-MRP ruling: the pack price per base unit,
 * ROUNDED DOWN to the paisa — exact when the pack divides (₹120 a strip of 10 is 1200), floored
 * when it does not (₹35.50 a strip of 15 is 236). Never above the MRP's share, so it is safe as a
 * per-unit BOUND (the OT implant clamp, the ledger event's `mrpPaisePerBase`).
 *
 * **It is NOT the operand of a comparison.** "Is this MRP below cost / above the ceiling" is asked
 * exactly with `packPriceOf` + `comparePackPrices` (QC rules 6 and 7): a floored figure there would
 * let an MRP a fraction of a paisa below cost pass.
 *
 * Until 2026-09-22 this function THREW on an MRP that did not divide; the owner's loose-MRP ruling
 * replaced that refusal. It still refuses an MRP with no unit, or a unit the item does not have.
 * Returns `null` when there is no MRP at all.
 */
export function mrpPerBaseUnit(
  uoms: readonly UomRow[],
  mrpPaise: number | null | undefined,
  mrpUom: string | null | undefined,
): number | null {
  const pack = packPriceOf(uoms, mrpPaise, mrpUom);
  if (pack === null) return null;
  return saleAmountPaise({ mrpPaise: pack.paise, packMultiplier: pack.baseUnits, qtyBase: 1 }).unitPaise;
}
