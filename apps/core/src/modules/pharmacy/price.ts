import { mrpPerBaseUnit } from "../materials";
import { inclusiveOf } from "../tariff";
import { PharmacyError } from "./errors";
import type { UomRow } from "../materials";

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
 * ═══ EVERYTHING IS PER BASE UNIT, AND A PRICE THAT DOES NOT DIVIDE IS NOT A PRICE ═══
 *
 * An MRP is printed on a PACK (`mrp_uom`); the ledger counts TABLETS (`base_uom`). Plan 14 DD7's
 * `mrpPerBaseUnit` is the one converter, and it refuses an MRP that does not divide into whole
 * paise per base unit rather than rounding inside a price comparison. Here that refusal becomes
 * `null` for that term (the `consumption.ts` `perBaseOrNull` shape): a batch whose MRP cannot be
 * expressed per tablet is priced at the ceiling if there is one, and is otherwise UNSALEABLE
 * (`price_unknown`) — the counter says so, the pharmacist fixes the pack unit, nobody invents a
 * paisa.
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

function perBaseOrNull(uoms: readonly UomRow[], paise: number | null, uom: string | null): number | null {
  if (paise === null || uom === null) return null;
  try {
    return mrpPerBaseUnit(uoms, paise, uom);
  } catch {
    return null;
  }
}

/**
 * The two batch-grain terms per base unit, AS PRINTED AND AS NOTIFIED: no rate, no comparison. The
 * stock ledger's `material.consumed` event records these, and it has no business knowing a tax.
 */
export function batchTermsPerBase(input: Omit<BatchPriceInput, "taxRateBps">): {
  mrpPaisePerBase: number | null; ceilingPaisePerBase: number | null;
} {
  return {
    mrpPaisePerBase: perBaseOrNull(input.uoms, input.batch.mrpPaise, input.batch.mrpUom),
    ceilingPaisePerBase: input.regulation === null
      ? null
      : perBaseOrNull(input.uoms, input.regulation.ceilingPaise, input.regulation.mrpUom),
  };
}

export function priceForBatch(input: BatchPriceInput): BatchPrice {
  const { mrpPaisePerBase, ceilingPaisePerBase } = batchTermsPerBase(input);
  const ceilingInclusivePaisePerBase = ceilingPaisePerBase === null ? null : inclusiveOf(ceilingPaisePerBase, input.taxRateBps);
  if (mrpPaisePerBase === null && ceilingInclusivePaisePerBase === null) {
    throw new PharmacyError(
      "price_unknown",
      "this batch carries no MRP that divides into its base unit and no notified ceiling — it cannot be sold until one is recorded",
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
