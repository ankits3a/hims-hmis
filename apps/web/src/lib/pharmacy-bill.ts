import type { TFunction } from "i18next";

/**
 * ═══ ONE ROW PER DRUG (loose-MRP ruling, owner 2026-09-22) ═══
 *
 * A quantity whose full pack does not divide is stored as two invoice lines (the loose-rate line and
 * its pack residue). The server folds them into one row (`apps/core/src/modules/pharmacy/bill-rows.ts`)
 * and says how the quantity reads in packs; this file only WORDS what the server sent.
 */
export type WireBillRowPack = {
  uom: string; multiplier: number; packs: number; loose: number; baseUom: string; packPaise: number | null;
};
export type WireBillRow = {
  lineIds: string[]; serviceName: string; qty: number; pack: WireBillRowPack | null; unitPaise: number;
  grossPaise: number; discountPaise: number; cgstPaise: number; sgstPaise: number; netPaise: number;
  sacCode: string | null; rateBps: number | null; exempt: boolean | null;
};

/** "1 strip + 5 tablet", "2 strip", or "20 tablet" / "× 20" when the item has no pack. */
export function billQtyText(t: TFunction, qty: number, pack: WireBillRowPack | null | undefined, unit?: string): string {
  if (pack == null || pack.packs === 0) return unit === undefined ? `× ${String(qty)}` : t("pharmacyBill.unitsOnly", { qty, unit: pack?.baseUom ?? unit });
  if (pack.loose === 0) return t("pharmacyBill.packsOnly", { packs: pack.packs, pack: pack.uom });
  return t("pharmacyBill.packsLoose", { packs: pack.packs, pack: pack.uom, loose: pack.loose, unit: pack.baseUom });
}

/**
 * What `qty` base units of a quoted batch cost: full packs at the pack's price (the server priced
 * `pack.paise` by the ruling), the rest at the loose rate. Mirrors `quotedAmountPaise` (quote.ts).
 */
export function quoteAmountPaise(quote: { unitPaise: number; pack: { multiplier: number; paise: number } | null }, qty: number): number {
  if (quote.pack === null || quote.pack.multiplier <= 1) return quote.unitPaise * qty;
  const packs = Math.floor(qty / quote.pack.multiplier);
  return packs * quote.pack.paise + (qty - packs * quote.pack.multiplier) * quote.unitPaise;
}
