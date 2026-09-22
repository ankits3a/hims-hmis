import { packPriceOf, saleAmountPaise } from "../materials";
import { inclusiveOf } from "../tariff";
import { PharmacyError } from "./errors";
import type { PackPrice, SaleAmount, UomRow } from "../materials";

/**
 * PLAN 16c T2 — THE PRICE RULE AT BATCH GRAIN (owner ruling R-1, adopted 2026-09-02). PURE.
 *
 * A dispensed unit is charged `min(batch MRP per base unit, NPPA ceiling per base unit on the
 * dispense date, contracted tariff if the active version carries one)`. This function computes the
 * two batch-grain terms and hands them to the tariff engine as `batchUnitPaise` (the list price,
 * T0b) and `capUnitPaise` (the bound, Plan 15 DD11); the engine takes the `min` with the version's
 * price itself, so the third term is never computed here and the winner the INVOICE records is
 * the engine's (`regulatedClamp.boundApplied`), which T4 copies onto the line.
 *
 * ═══ EVERYTHING IS PER BASE UNIT — AND A PACK THAT DOES NOT DIVIDE SELLS BY THE LOOSE-MRP RULING ═══
 *
 * An MRP is printed on a PACK (`mrp_uom`); the ledger counts TABLETS (`base_uom`). Until
 * 2026-09-22 an MRP that did not divide into whole paise per tablet was UNUSABLE here (₹35.50 on a
 * strip of 15), which made most of a real shelf unsaleable. The owner's LOOSE-MRP RULING (money)
 * replaced that: **a FULL pack is billed at exactly its printed MRP; a LOOSE unit at the per-unit
 * share ROUNDED DOWN to the paisa** — never above MRP. `saleAmountPaise` (materials) is the one
 * place that arithmetic lives; `priceBatchSale` below applies it to a quantity, to the MRP and to
 * the GST-inclusive ceiling alike, and the LOWER AMOUNT wins. `priceForBatch` is the one-unit
 * (loose) view of the same terms; where a pack divides, both are exactly what they always were.
 */
export type BatchPriceInput = {
  uoms: readonly UomRow[];
  /** The batch the pick chose: its printed MRP and the pack it is printed on. */
  batch: { mrpPaise: number | null; mrpUom: string | null };
  /** The item's price regulation effective on the dispense date, or none. `mrpUom` is the ceiling's pack. */
  regulation: { ceilingPaise: number | null; mrpUom: string | null } | null;
  /**
   * PHARMACY P1 — the GST rate the line will be taxed at, in basis points (0 when the category is
   * exempt). REQUIRED, not defaulted: the MRP is printed inclusive of GST (L1) and a ceiling is
   * notified before it (L2), and comparing the two without the rate is the defect this field closes.
   */
  taxRateBps: number;
};

export type BatchPriceWinner = "batch_mrp" | "ceiling";

export type BatchPrice = {
  /** The list price per base unit — the batch MRP, or the ceiling when the MRP is unusable. */
  batchUnitPaise: number;
  /** The bound per base unit — `min(MRP, ceiling)`; equal to `batchUnitPaise` when nothing caps it. */
  capUnitPaise: number;
  /** Which of the two batch-grain terms is the lower. The tariff may still undercut both at the bill. */
  winner: BatchPriceWinner;
  mrpPaisePerBase: number | null;
  /** The ceiling as notified: before GST (L2). */
  ceilingPaisePerBase: number | null;
  /** The same ceiling on the MRP's basis, `floor(ceiling × (1 + rate))`: the term actually compared. */
  ceilingInclusivePaisePerBase: number | null;
};

/** A pack price that divides is carried per ONE base unit, so a divisible term prices exactly as before. */
function normalised(p: PackPrice): PackPrice {
  return p.paise % p.baseUnits === 0 ? { paise: p.paise / p.baseUnits, baseUnits: 1 } : p;
}

/** A term as printed/notified, or null when absent or in a pack the item does not have (ignored, as before). */
function termOf(uoms: readonly UomRow[], paise: number | null, uom: string | null): PackPrice | null {
  if (paise === null || uom === null) return null;
  try {
    const p = packPriceOf(uoms, paise, uom);
    return p === null ? null : normalised(p);
  } catch {
    return null;
  }
}

/** The loose-unit rate a term implies: its share of the pack, rounded down (exact when it divides). */
const looseRate = (t: PackPrice | null): number | null => (t === null ? null : Math.floor(t.paise / t.baseUnits));

type Terms = { mrp: PackPrice | null; ceiling: PackPrice | null; ceilingInclusive: PackPrice | null };

function termsOf(input: Omit<BatchPriceInput, "taxRateBps">, taxRateBps: number): Terms {
  const mrp = termOf(input.uoms, input.batch.mrpPaise, input.batch.mrpUom);
  const ceiling = input.regulation === null ? null : termOf(input.uoms, input.regulation.ceilingPaise, input.regulation.mrpUom);
  // L2: NPPA notifies the ceiling BEFORE GST; gross it up on the pack it is notified on (per base
  // unit when it divides — exactly the pre-ruling arithmetic), floored so rounding never raises it.
  const ceilingInclusive = ceiling === null ? null : normalised({ paise: inclusiveOf(ceiling.paise, taxRateBps), baseUnits: ceiling.baseUnits });
  return { mrp, ceiling, ceilingInclusive };
}

/**
 * The two batch-grain terms per base unit, AS PRINTED AND AS NOTIFIED: no rate, no comparison. The
 * stock ledger's `material.consumed` event records these, and it has no business knowing a tax. A
 * pack that does not divide gives its LOOSE-unit rate (rounded down), never null.
 */
export function batchTermsPerBase(input: Omit<BatchPriceInput, "taxRateBps">): {
  mrpPaisePerBase: number | null; ceilingPaisePerBase: number | null;
} {
  const t = termsOf(input, 0);
  return { mrpPaisePerBase: looseRate(t.mrp), ceilingPaisePerBase: looseRate(t.ceiling) };
}

function unitPriceOf(input: BatchPriceInput, t: Terms): BatchPrice {
  const mrpPaisePerBase = looseRate(t.mrp);
  const ceilingPaisePerBase = looseRate(t.ceiling);
  const ceilingInclusivePaisePerBase = looseRate(t.ceilingInclusive);
  if (mrpPaisePerBase === null && ceilingInclusivePaisePerBase === null) {
    throw new PharmacyError(
      "price_unknown",
      "this batch carries no MRP in one of its item's units and no notified ceiling — it cannot be sold until one is recorded",
      { mrpPaise: input.batch.mrpPaise, mrpUom: input.batch.mrpUom },
    );
  }
  const terms = { mrpPaisePerBase, ceilingPaisePerBase, ceilingInclusivePaisePerBase };
  if (mrpPaisePerBase === null) {
    const c = ceilingInclusivePaisePerBase as number;
    return { batchUnitPaise: c, capUnitPaise: c, winner: "ceiling", ...terms };
  }
  if (ceilingInclusivePaisePerBase === null || ceilingInclusivePaisePerBase >= mrpPaisePerBase) {
    return { batchUnitPaise: mrpPaisePerBase, capUnitPaise: mrpPaisePerBase, winner: "batch_mrp", ...terms };
  }
  return { batchUnitPaise: mrpPaisePerBase, capUnitPaise: ceilingInclusivePaisePerBase, winner: "ceiling", ...terms };
}

/** ONE LOOSE unit's price terms (per base unit). A quantity is priced by `priceBatchSale`. */
export function priceForBatch(input: BatchPriceInput): BatchPrice {
  return unitPriceOf(input, termsOf(input, input.taxRateBps));
}

/**
 * A quantity, priced by the LOOSE-MRP RULING, and how it rides the invoice.
 *
 * The tariff engine prices a line as `unitPaise × qty` (and tariff/billing signatures are not ours
 * to change), and 20 tablets at 4730 paise has no integer unit price. So a mixed quantity is
 * carried as the MAIN line — every unit at the loose rate, `qty` in BASE units exactly as before,
 * which is what returns, leakage and the dispense line already key on — plus, only when a full pack
 * does not divide, a PACK-RESIDUE line: `fullPacks × (packPaise − packMultiplier × looseRate)`,
 * i.e. `1 × 10` paise for one strip of ₹35.50/15. Main + residue = the ruling's amount, to the
 * paisa; where the pack divides there is no residue line and nothing changes.
 */
export type BatchSale = BatchPrice & {
  /** The ruling's amount for the quantity: the lower of the MRP's and the inclusive ceiling's. */
  amountPaise: number;
  /** Which term's AMOUNT is lower (ties go to the MRP, as in `priceForBatch`). */
  saleWinner: BatchPriceWinner;
  /** The pack-residue segment, or null when the quantity divides into loose-rate units exactly. */
  residue: { qty: number; unitPaise: number } | null;
};

export function priceBatchSale(input: BatchPriceInput, qtyBase: number): BatchSale {
  const t = termsOf(input, input.taxRateBps);
  const unit = unitPriceOf(input, t);
  const amount = (term: PackPrice | null): SaleAmount | null =>
    term === null ? null : saleAmountPaise({ mrpPaise: term.paise, packMultiplier: term.baseUnits, qtyBase });
  const m = amount(t.mrp);
  const c = amount(t.ceilingInclusive);
  const saleWinner: BatchPriceWinner = c !== null && (m === null || c.amountPaise < m.amountPaise) ? "ceiling" : "batch_mrp";
  const won = (saleWinner === "ceiling" ? c : m) as SaleAmount;
  // Every term's amount is ≥ qty × its own loose rate ≥ qty × the lower loose rate, so this is never negative.
  const residuePaise = won.amountPaise - qtyBase * unit.capUnitPaise;
  const residue = residuePaise === 0 ? null
    : won.fullPacks > 0 && residuePaise % won.fullPacks === 0 ? { qty: won.fullPacks, unitPaise: residuePaise / won.fullPacks }
      : { qty: 1, unitPaise: residuePaise };
  return { ...unit, amountPaise: won.amountPaise, saleWinner, residue };
}

/**
 * S2, ANSWERED: `computeGst` is keyed by SERVICE CATEGORY and takes no per-line rate, so a drug's
 * slab (owner ruling R-2: from `items.gst_rate_bps`) is expressed as the category of the service
 * the bridge creates. Four data-only categories, seeded by `seed:tariff`, all `pharmacy*` so the
 * tariff engine's `batchUnitPaise` guard (T0b) admits them. HSN 3004 on every one; the CA signs
 * the rates (§19) as with every other placeholder in that seed.
 */
export const PHARMACY_GST_CATEGORIES = {
  0: "pharmacy_exempt",
  500: "pharmacy_5",
  1200: "pharmacy",
  1800: "pharmacy_18",
} as const;

export function gstCategoryFor(gstRateBps: number | null): string {
  const key = gstRateBps ?? 0;
  const category = (PHARMACY_GST_CATEGORIES as Record<number, string | undefined>)[key];
  if (category === undefined) {
    throw new PharmacyError(
      "gst_slab_unknown",
      `a GST rate of ${String(gstRateBps)} bps is not a medicine slab (nil, 5%, 12% or 18%) — correct the item before selling it`,
      { gstRateBps },
    );
  }
  return category;
}
