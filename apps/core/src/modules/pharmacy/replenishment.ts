import { availableQtyByItem, consumedQtyByItem, findStoreByCode, listStores, uomsByItems } from "../materials";
import { OPD_PHARMACY_STORE_CODE, REORDER_MIN_COVER_DAYS, REORDER_TARGET_COVER_DAYS, REORDER_WINDOW_DAYS } from "./config";
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
  suggestBase: number;
  /** "2 strip" when the suggestion is a whole number of the item's issue pack. */
  suggestPacks: string | null;
  source: { storeCode: string; storeName: string; available: number } | null;
};

export type ReorderAdvice = {
  asOf: Date;
  window: { days: number; minCoverDays: number; targetCoverDays: number };
  items: ReorderLine[];
};

const RANK: Record<ReorderStatus, number> = { stock_out: 0, reorder: 1, ok: 2, no_movement: 3 };

export async function reorderAdvice(db: Db, now: Date = new Date()): Promise<ReorderAdvice> {
  const counter = await findStoreByCode(db, OPD_PHARMACY_STORE_CODE);
  if (counter === undefined || counter.status === "retired") {
    throw new PharmacyError("store_missing", `the OPD pharmacy store ${OPD_PHARMACY_STORE_CODE} does not exist — run seed:pharmacy`);
  }
  const sale = (await listSaleItems(db)).filter((i) => i.active && i.itemActive);
  const ids = sale.map((i) => i.itemId);
  const since = new Date(now.getTime() - REORDER_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const [available, used, uoms] = await Promise.all([
    availableQtyByItem(db, counter.id, ids, now),
    consumedQtyByItem(db, counter.id, ids, since, now),
    uomsByItems(db, ids),
  ]);

  const lines: ReorderLine[] = sale.map((item) => {
    const have = available.get(item.itemId) ?? 0;
    const usedQty = used.get(item.itemId) ?? 0;
    const perDay = usedQty / REORDER_WINDOW_DAYS;
    const daysOfCover = perDay === 0 ? null : Math.round((have / perDay) * 10) / 10;
    const status: ReorderStatus = usedQty === 0 ? "no_movement"
      : have === 0 ? "stock_out"
        : (daysOfCover as number) < REORDER_MIN_COVER_DAYS ? "reorder" : "ok";
    let suggestBase = 0;
    let suggestPacks: string | null = null;
    if (status === "stock_out" || status === "reorder") {
      const short = Math.max(0, Math.ceil(perDay * REORDER_TARGET_COVER_DAYS) - have);
      const pack = (uoms.get(item.itemId) ?? [])
        .filter((u) => u.isIssueUom && u.toBaseMultiplier > 1)
        .sort((a, b) => a.toBaseMultiplier - b.toBaseMultiplier)[0];
      suggestBase = pack === undefined ? short : Math.ceil(short / pack.toBaseMultiplier) * pack.toBaseMultiplier;
      if (pack !== undefined && suggestBase > 0) suggestPacks = `${String(suggestBase / pack.toBaseMultiplier)} ${pack.uom}`;
    }
    return {
      itemId: item.itemId, code: item.code, name: item.name, baseUom: item.baseUom,
      status, available: have, usedInWindow: usedQty, daysOfCover, suggestBase, suggestPacks, source: null,
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

  lines.sort((a, b) => RANK[a.status] - RANK[b.status]
    || (a.daysOfCover ?? Infinity) - (b.daysOfCover ?? Infinity)
    || a.code.localeCompare(b.code));
  return {
    asOf: now,
    window: { days: REORDER_WINDOW_DAYS, minCoverDays: REORDER_MIN_COVER_DAYS, targetCoverDays: REORDER_TARGET_COVER_DAYS },
    items: lines,
  };
}
