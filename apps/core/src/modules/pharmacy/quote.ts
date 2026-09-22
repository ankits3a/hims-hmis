import { desc, eq } from "drizzle-orm";
import { stockBatches } from "../../kernel/db/schema";
import { itemUomRows, sellableBatchesByItem } from "../materials";
import { priceBatchLine } from "./bill";
import { PharmacyError } from "./errors";
import type { GstCategoryMap } from "./bill";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ A QUOTE — WHAT THE BILL WILL ASK FOR, SAID BEFORE THE BILL ═══
 *
 * The approved Desk board prices every line and every offer on sight ("Pantop 40 … saves ₹6.50 a
 * strip"). The desk must not do its own arithmetic on a price, so a quote is the SERVER's: the
 * first-to-expire sellable batch — the one the pick would take — priced by `priceBatchLine`, the
 * function the bill and the walk-in sale price with. `unitPaise` is the batch-grain bound
 * (min of MRP and ceiling); the bill can still undercut it with a contracted tariff, never exceed it.
 *
 * `lastKnown` marks a quote read from the item's most recent batch when the shelf holds none — the
 * printed MRP the patient last saw, which is what "saves ₹6.50 a strip" is measured against.
 */
export type Quote = {
  batchId: string;
  batchNo: string;
  expiryDate: string | null;
  unitPaise: number;
  /** Which bound set it: the batch's printed MRP, or a notified DPCO ceiling the counter may not charge above. */
  winner: "batch_mrp" | "ceiling";
  /** The printed MRP per base unit, so a ceiling-bound line can say what the pack says. */
  mrpUnitPaise: number | null;
  /** The pack the pharmacist hands over (a strip of 10), when the item has one. */
  pack: { uom: string; multiplier: number; paise: number } | null;
  lastKnown: boolean;
};

/** Refusals that mean "no honest price from this batch", not a fault — a quote is then absent. */
const NO_PRICE = new Set(["price_unknown", "gst_slab_unknown", "sale_item_inactive", "unknown_sale_item", "batch_not_saleable"]);

async function priceOf(db: Db, gst: GstCategoryMap, itemId: string, batch: { batchId: string; batchNo: string; expiryDate: string | null }, lastKnown: boolean, now: Date): Promise<Quote | null> {
  let unitPaise: number;
  let winner: "batch_mrp" | "ceiling" = "batch_mrp";
  let mrpUnitPaise: number | null = null;
  try {
    const priced = await priceBatchLine(db, gst, { itemId, batchId: batch.batchId, qtyBase: 1 }, now);
    unitPaise = priced.input.capUnitPaise ?? priced.input.batchUnitPaise ?? 0;
    winner = priced.winner;
    mrpUnitPaise = priced.input.batchUnitPaise ?? null;
  } catch (e) {
    if (e instanceof PharmacyError && NO_PRICE.has(e.code)) return null;
    throw e;
  }
  if (unitPaise <= 0) return null;
  /* The smallest pack above one unit is what crosses the counter — a strip, not the box of ten strips. */
  const pack = (await itemUomRows(db, itemId))
    .filter((u) => u.toBaseMultiplier > 1)
    .sort((a, b) => a.toBaseMultiplier - b.toBaseMultiplier)[0];
  return {
    batchId: batch.batchId, batchNo: batch.batchNo, expiryDate: batch.expiryDate, unitPaise, winner, mrpUnitPaise, lastKnown,
    // The loose-MRP ruling (2026-09-22): a full strip is its printed MRP, not the rounded-down tablet × 15.
    pack: pack === undefined ? null : {
      uom: pack.uom, multiplier: pack.toBaseMultiplier,
      paise: (await priceBatchLine(db, gst, { itemId, batchId: batch.batchId, qtyBase: pack.toBaseMultiplier }, now)).amountPaise,
    },
  };
}

/** The quote for an item at a store: its first-to-expire sellable batch, or null when none can be sold. */
export async function quoteItem(db: Db, gst: GstCategoryMap, storeResourceId: string, itemId: string, now: Date): Promise<Quote | null> {
  const first = ((await sellableBatchesByItem(db, storeResourceId, [itemId], now)).get(itemId) ?? [])[0];
  return first === undefined ? null : priceOf(db, gst, itemId, first, false, now);
}

/** The item's most recent batch, priced: the last MRP the patient saw, for when the shelf holds none. */
export async function lastKnownQuote(db: Db, gst: GstCategoryMap, itemId: string, now: Date): Promise<Quote | null> {
  const [last] = await db.select({ batchId: stockBatches.id, batchNo: stockBatches.batchNo, expiryDate: stockBatches.expiryDate })
    .from(stockBatches).where(eq(stockBatches.itemId, itemId)).orderBy(desc(stockBatches.createdAt), desc(stockBatches.id)).limit(1);
  return last === undefined ? null : priceOf(db, gst, itemId, last, true, now);
}
