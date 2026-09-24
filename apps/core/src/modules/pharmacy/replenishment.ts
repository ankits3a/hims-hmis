import {
  EXPIRY_THRESHOLD_DAYS, availableQtyByItem, consumedQtyByItem, expiredStockAt, findStoreByCode, itemsByIds, listStores,
  onOrderAt, sellableBatchesByItem, stockLevelsAt, uomsByItems,
} from "../materials";
import type { StockLevel } from "../materials";
import { OPD_PHARMACY_STORE_CODE, REORDER_MIN_COVER_DAYS, REORDER_TARGET_COVER_DAYS, REORDER_WINDOW_DAYS, istDateOf } from "./config";
import { PharmacyError } from "./errors";
import { listSaleItems } from "./sale-items";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ PHARMACY P4 — THE REORDER LIST ═══
 *
 * Doc 16 §9's Replenishment automation, DRAFTING tier: it proposes, and people act. A storekeeper
 * issues from the main store through materials' two-sided issue, and a purchase officer orders.
 * Nothing here writes. Phase doc `docs/superpowers/plans/2026-09-16-phase-pharmacy-p4-reorder-advice.md`.
 *
 * For every active sale item at the OPD counter's store:
 *   - `available`: what the pick would honour now (`availableQtyByItem`: expired, recalled, reserved
 *     and frozen stock excluded). A shelf of expired strips is not cover.
 *   - `usedInWindow`: what the COUNTER consumed in the last REORDER_WINDOW_DAYS. An issue to another
 *     store is not use, and neither is use at another store.
 *   - `daysOfCover` = available ÷ daily use, to one decimal; null when nothing was used.
 *   - `suggestBase`: enough to reach REORDER_TARGET_COVER_DAYS, rounded UP to the item's issue pack.
 *     It is only suggested when cover is under REORDER_MIN_COVER_DAYS.
 *   - `source`: the non-transit store holding the most of it that can cover the suggestion. Failing
 *     that, the one holding the most. Null means it has to be purchased.
 *
 * ═══ P8 — NEAR EXPIRY, AND WHY IT IS NOT COVER ═══
 *
 * Phase doc `docs/superpowers/plans/2026-09-16-phase-pharmacy-p8-near-expiry.md`. The pick sells the
 * earliest-expiring batch first (FEFO), so at the window's pace every batch gets the selling days
 * left between the batches ahead of it and its own expiry date (the last day it may be sold). What
 * it cannot sell in them expires on the shelf.
 *   - `unsoldByExpiry`: that forecast, summed over the batches expiring within NEAR_EXPIRY_DAYS (the
 *     widest expiry band materials announces). Past that horizon a 30-day pace forecasts nothing.
 *   - `daysOfCover` and the suggestion use `available − unsoldByExpiry`: a strip that will expire
 *     before anyone buys it does not keep the counter open.
 *   - `expiring`: every such batch, soonest first. `move_back` when some of it will expire unsold
 *     (back to the main store for a busier counter, or to the supplier under the rate contract's
 *     expiry-return clause, while there is still time). `sell_first` when FEFO will clear it.
 *   - `expiredOnShelf`: the counter's stock already past its date. The pick refuses it; it still has
 *     to be taken off the shelf into quarantine.
 */
export type ReorderStatus = "stock_out" | "reorder" | "ok" | "no_movement";

export type ReorderLine = {
  itemId: string;
  code: string;
  name: string;
  baseUom: string;
  status: ReorderStatus;
  available: number;
  usedInWindow: number;
  daysOfCover: number | null;
  /** P8: how much of `available` the window's pace will not sell before its batch expires. */
  unsoldByExpiry: number;
  suggestBase: number;
  /** "2 strip" when the suggestion is a whole number of the item's issue pack. */
  suggestPacks: string | null;
  source: { storeCode: string; storeName: string; available: number } | null;
  /** PARITY P2 — the store's min / reorder / max for the item, when somebody has set them. */
  levels: StockLevel | null;
  /** PARITY P2 — still owed on approved, sent and part-received orders (base units). */
  onOrderBase: number;
  /** PARITY P2 — on drafts and orders awaiting approval (base units). */
  inDraftBase: number;
  /**
   * PARITY P2 — what to BUY, in base units. With levels, at or below the reorder level:
   * `max − (available + on order + in draft)`. Without levels: the cover suggestion when no other
   * store can send it, less what is already ordered or drafted. Zero when nothing is to be bought.
   */
  orderBase: number;
};

export type ExpiryAction = "move_back" | "sell_first";

export type ExpiringLine = {
  itemId: string;
  code: string;
  name: string;
  baseUom: string;
  batchId: string;
  batchNo: string;
  expiryDate: string;
  /** Days from today (IST) to the expiry date; 0 is its last selling day. */
  daysLeft: number;
  available: number;
  unsoldByExpiry: number;
  action: ExpiryAction;
};

export type ExpiredLine = { itemId: string; code: string; name: string; baseUom: string; batchId: string; batchNo: string; expiryDate: string; onHand: number };

export type ReorderAdvice = {
  asOf: Date;
  /** PARITY P2 — the counter's store, whose levels the list shows and edits. */
  store: { id: string; code: string };
  window: { days: number; minCoverDays: number; targetCoverDays: number; nearExpiryDays: number };
  items: ReorderLine[];
  expiring: ExpiringLine[];
  expiredOnShelf: ExpiredLine[];
};

const NEAR_EXPIRY_DAYS: number = EXPIRY_THRESHOLD_DAYS[0];
const DAY_MS = 24 * 60 * 60 * 1000;
const dayNumber = (isoDate: string): number => Math.floor(Date.parse(`${isoDate}T00:00:00Z`) / DAY_MS);

/**
 * FEFO at a steady pace, in whole units. `batches` in the pick's order; returns what each will leave
 * unsold at its expiry.
 *
 * By the end of a batch's last selling day the counter will have sold
 * `floor(used × sellingDays ÷ window)` units in all. The batches ahead of it took the first of
 * those, whether they ran out early or expired with some left, so this batch sells what remains,
 * up to what it holds. Integer arithmetic on purpose: a running day-cursor of `sold ÷ perDay` is a
 * float, and `floor(3 × (35 − 10/3))` is 94, not 95. An undated batch never expires.
 */
function forecastUnsold(
  batches: readonly { expiryDate: string | null; available: number }[], used: number, today: string,
): number[] {
  let soldBefore = 0;
  return batches.map((b) => {
    const demand = b.expiryDate === null ? Number.POSITIVE_INFINITY
      : Math.floor((used * Math.max(0, dayNumber(b.expiryDate) - dayNumber(today) + 1)) / REORDER_WINDOW_DAYS);
    const sold = Math.max(0, Math.min(b.available, demand - soldBefore));
    soldBefore += sold;
    return b.available - sold;
  });
}

const RANK: Record<ReorderStatus, number> = { stock_out: 0, reorder: 1, ok: 2, no_movement: 3 };

export async function reorderAdvice(db: Db, now: Date = new Date()): Promise<ReorderAdvice> {
  const counter = await findStoreByCode(db, OPD_PHARMACY_STORE_CODE);
  if (counter === undefined || counter.status === "retired") {
    throw new PharmacyError("store_missing", `the OPD pharmacy store ${OPD_PHARMACY_STORE_CODE} does not exist — run seed:pharmacy`);
  }
  const sale = (await listSaleItems(db)).filter((i) => i.active && i.itemActive);
  const ids = sale.map((i) => i.itemId);
  const since = new Date(now.getTime() - REORDER_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const today = istDateOf(now);
  const [available, used, uoms, batches, expired, levels, onOrder] = await Promise.all([
    availableQtyByItem(db, counter.id, ids, now),
    consumedQtyByItem(db, counter.id, ids, since, now),
    uomsByItems(db, ids),
    sellableBatchesByItem(db, counter.id, ids, now),
    expiredStockAt(db, counter.id, now),
    stockLevelsAt(db, counter.id, ids),
    onOrderAt(db, counter.id, ids),
  ]);

  const expiring: ExpiringLine[] = [];
  const lines: ReorderLine[] = sale.map((item) => {
    const have = available.get(item.itemId) ?? 0;
    const usedQty = used.get(item.itemId) ?? 0;
    const perDay = usedQty / REORDER_WINDOW_DAYS;
    const fefo = batches.get(item.itemId) ?? [];
    const unsold = forecastUnsold(fefo, usedQty, today);
    let unsoldByExpiry = 0;
    fefo.forEach((b, i) => {
      if (b.expiryDate === null) return;
      const daysLeft = dayNumber(b.expiryDate) - dayNumber(today);
      if (daysLeft > NEAR_EXPIRY_DAYS) return;
      const left = unsold[i]!;
      unsoldByExpiry += left;
      expiring.push({
        itemId: item.itemId, code: item.code, name: item.name, baseUom: item.baseUom,
        batchId: b.batchId, batchNo: b.batchNo, expiryDate: b.expiryDate, daysLeft,
        available: b.available, unsoldByExpiry: left, action: left > 0 ? "move_back" : "sell_first",
      });
    });
    const cover = Math.max(0, have - unsoldByExpiry);
    const daysOfCover = perDay === 0 ? null : Math.round((cover / perDay) * 10) / 10;
    const level = levels.get(item.itemId) ?? null;
    const coverStatus: ReorderStatus = usedQty === 0 ? "no_movement"
      : have === 0 ? "stock_out"
        : (daysOfCover as number) < REORDER_MIN_COVER_DAYS ? "reorder" : "ok";
    // P2 — a level a person set outranks the forecast when stock is at or below it.
    const status: ReorderStatus = level !== null && have <= level.reorderBase ? (have === 0 ? "stock_out" : "reorder") : coverStatus;
    let suggestBase = 0;
    let suggestPacks: string | null = null;
    if (status === "stock_out" || status === "reorder") {
      const short = Math.max(0, Math.ceil(perDay * REORDER_TARGET_COVER_DAYS) - cover);
      const pack = (uoms.get(item.itemId) ?? [])
        .filter((u) => u.isIssueUom && u.toBaseMultiplier > 1)
        .sort((a, b) => a.toBaseMultiplier - b.toBaseMultiplier)[0];
      suggestBase = pack === undefined ? short : Math.ceil(short / pack.toBaseMultiplier) * pack.toBaseMultiplier;
      if (pack !== undefined && suggestBase > 0) suggestPacks = `${String(suggestBase / pack.toBaseMultiplier)} ${pack.uom}`;
    }
    const coming = onOrder.get(item.itemId) ?? { onOrderBase: 0, inDraftBase: 0 };
    return {
      itemId: item.itemId, code: item.code, name: item.name, baseUom: item.baseUom,
      status, available: have, usedInWindow: usedQty, daysOfCover, unsoldByExpiry, suggestBase, suggestPacks, source: null,
      levels: level, onOrderBase: coming.onOrderBase, inDraftBase: coming.inDraftBase,
      orderBase: level !== null && have <= level.reorderBase
        ? Math.max(0, level.maxBase - (have + coming.onOrderBase + coming.inDraftBase))
        : 0,
    };
  });

  // Where the short lines can come from: every other non-transit store, asked once each.
  const short = lines.filter((l) => l.suggestBase > 0);
  if (short.length > 0) {
    const others = (await listStores(db)).filter((s) => s.id !== counter.id && s.status !== "retired");
    const held = await Promise.all(others.map(async (s) => ({
      store: s, qty: await availableQtyByItem(db, s.id, short.map((l) => l.itemId), now),
    })));
    for (const line of short) {
      const offers = held
        .map((h) => ({ storeCode: h.store.code, storeName: h.store.name, available: h.qty.get(line.itemId) ?? 0 }))
        .filter((o) => o.available > 0)
        .sort((a, b) => b.available - a.available);
      line.source = offers.find((o) => o.available >= line.suggestBase) ?? offers[0] ?? null;
    }
  }
  // P2 — without levels, the cover suggestion is bought only when no other store can send it.
  for (const line of lines) {
    if (line.levels === null && line.suggestBase > 0 && line.source === null) {
      line.orderBase = Math.max(0, line.suggestBase - line.onOrderBase - line.inDraftBase);
    }
  }

  lines.sort((a, b) => RANK[a.status] - RANK[b.status]
    || (a.daysOfCover ?? Infinity) - (b.daysOfCover ?? Infinity)
    || a.code.localeCompare(b.code));
  expiring.sort((a, b) => a.daysLeft - b.daysLeft || a.code.localeCompare(b.code) || a.batchNo.localeCompare(b.batchNo));

  // The expired shelf may hold items no longer on sale: name them from the item master.
  const names = await itemsByIds(db, expired.map((e) => e.itemId));
  const expiredOnShelf: ExpiredLine[] = expired.map((e) => {
    const item = names.get(e.itemId);
    return { ...e, code: item?.code ?? "", name: item?.name ?? e.itemId, baseUom: item?.baseUom ?? "" };
  });

  return {
    asOf: now,
    store: { id: counter.id, code: counter.code },
    window: {
      days: REORDER_WINDOW_DAYS, minCoverDays: REORDER_MIN_COVER_DAYS, targetCoverDays: REORDER_TARGET_COVER_DAYS,
      nearExpiryDays: NEAR_EXPIRY_DAYS,
    },
    items: lines,
    expiring,
    expiredOnShelf,
  };
}
