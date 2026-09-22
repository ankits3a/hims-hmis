import { sql } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { seedPharmacyBase, stockIn } from "../../../test/helpers/pharmacy";
import { withTx } from "../../kernel/db/client";
import { createStore, postMovement } from "../materials";
import { reorderAdvice } from "./replenishment";
import type { Actor } from "@hmis/contracts";
import type { PharmacyFixture } from "../../../test/helpers/pharmacy";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ PHARMACY P4 — THE REORDER LIST: WHAT THE COUNTER WILL RUN OUT OF, AND WHERE IT CAN COME FROM ═══
 *
 * Phase doc `docs/superpowers/plans/2026-09-16-phase-pharmacy-p4-reorder-advice.md`. Doc 16 §9's
 * Replenishment automation, drafting tier: it proposes, a storekeeper issues and a purchase officer
 * orders. Nothing here moves stock.
 */
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-09-16T06:00:00.000Z");
const ago = (days: number): Date => new Date(NOW.getTime() - days * DAY);
const HEAD: Actor = { type: "user", id: "01HMATERIALSHEAD00000000001" };

describe("the reorder list (pharmacy P4)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: PharmacyFixture;
  let mainStore: string;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    fx = await seedPharmacyBase(db);
    ({ resourceId: mainStore } = await withTx(db, (tx) => createStore(tx, HEAD, { code: "MAIN-STORE", name: "Main store" })));
  });
  afterEach(() => { fx.unregister(); });

  const consume = (batchId: string, qty: number, at: Date, resourceId = fx.storeId) =>
    withTx(db, (tx) => postMovement(tx, HEAD, { resourceId, batchId, qtyDelta: -qty, reason: "consume", refType: "test", refId: batchId, occurredAt: at }));

  it("orders the counter's shelf by urgency, counts only the window's use at this store, and names a store that can supply it", async () => {
    // Calpol: sold out. 100 went 40 days ago (outside the window) and 10 went two days ago.
    const calpol = await stockIn(db, fx, { itemId: fx.item.calpol, batchNo: "CP-1", qtyBase: 110, at: ago(45), expiryDate: "2027-12-31" });
    await consume(calpol, 100, ago(40));
    await consume(calpol, 10, ago(2));
    // Azee: 2 left after 38 went in three days. The main store holds 55 and itself used 5.
    const azee = await stockIn(db, fx, { itemId: fx.item.azithro, batchNo: "AZ-1", qtyBase: 40, at: ago(20), expiryDate: "2027-12-31" });
    await consume(azee, 38, ago(3));
    const azeeMain = await stockIn(db, fx, { itemId: fx.item.azithro, batchNo: "AZ-M", qtyBase: 55, at: ago(20), expiryDate: "2027-12-31", resourceId: mainStore });
    await consume(azeeMain, 5, ago(1), mainStore);
    // Crocin: on the shelf, not sold in the window.
    await stockIn(db, fx, { itemId: fx.item.crocin, batchNo: "CR-1", qtyBase: 30, at: ago(20), expiryDate: "2027-12-31" });

    const advice = await reorderAdvice(db, NOW);

    expect(advice.window).toEqual({ days: 30, minCoverDays: 3, targetCoverDays: 7, nearExpiryDays: 90 });
    expect(advice.items.map((i) => [i.code, i.status, i.available, i.usedInWindow, i.daysOfCover, i.suggestBase, i.suggestPacks, i.source])).toEqual([
      // 10 in 30 days is a third a day: 7 days is 3 tablets, rounded up to a strip.
      ["CALP500", "stock_out", 0, 10, 0, 10, "1 strip", null],
      // 38 in 30 days: 7 days is 9, less the 2 on the shelf is 7, rounded up to a strip.
      ["AZEE500", "reorder", 2, 38, 1.6, 10, "1 strip", { storeCode: "MAIN-STORE", storeName: "Main store", available: 50 }],
      ["CROC500", "no_movement", 30, 0, null, 0, null, null],
    ]);
  });

  /**
   * ═══ PHARMACY P8 — NEAR EXPIRY AT THE COUNTER ═══
   *
   * Phase doc `docs/superpowers/plans/2026-09-16-phase-pharmacy-p8-near-expiry.md`. Today is
   * 2026-09-16 (IST). FEFO sells the earliest batch first, so at the window's pace each batch has
   * the days between the batches before it and its own expiry date. What it cannot sell in them
   * expires on the shelf: it is not cover, and it should go back before it does.
   */
  it("forecasts what will expire unsold at the counter, does not count it as cover, and lists what has already expired", async () => {
    // Azee: 90 used in the window (3 a day). AZ-SOON has 60 left and 10 selling days (today to the
    // 25th), so it sells 30 and 30 expire. AZ-LATE's 30 sell after it.
    const soon = await stockIn(db, fx, { itemId: fx.item.azithro, batchNo: "AZ-SOON", qtyBase: 150, at: ago(40), expiryDate: "2026-09-25" });
    await consume(soon, 90, ago(10));
    await stockIn(db, fx, { itemId: fx.item.azithro, batchNo: "AZ-LATE", qtyBase: 30, at: ago(5), expiryDate: "2027-12-31" });
    // Calpol: 90 used. CP-1 has 10 left and 31 selling days, so it sells in time. CP-2 comes after it:
    // by its last day (35 selling days) the counter sells 105 in all, 10 of them from CP-1, so CP-2
    // sells 95 of its 100 and 5 expire. CP-OLD expired on the 10th with 12 still on the shelf;
    // CP-GONE expired empty.
    const cp = await stockIn(db, fx, { itemId: fx.item.calpol, batchNo: "CP-1", qtyBase: 100, at: ago(40), expiryDate: "2026-10-16" });
    await consume(cp, 90, ago(3));
    await stockIn(db, fx, { itemId: fx.item.calpol, batchNo: "CP-2", qtyBase: 100, at: ago(5), expiryDate: "2026-10-20" });
    await stockIn(db, fx, { itemId: fx.item.calpol, batchNo: "CP-OLD", qtyBase: 12, at: ago(45), expiryDate: "2026-09-10" });
    const gone = await stockIn(db, fx, { itemId: fx.item.calpol, batchNo: "CP-GONE", qtyBase: 5, at: ago(45), expiryDate: "2026-09-12" });
    await consume(gone, 5, ago(40));
    // Crocin: not sold in the window, so all 20 near-expiry tablets will expire. CR-EMPTY went
    // before the window and has nothing left to forecast.
    await stockIn(db, fx, { itemId: fx.item.crocin, batchNo: "CR-NEAR", qtyBase: 20, at: ago(20), expiryDate: "2026-11-30" });
    const empty = await stockIn(db, fx, { itemId: fx.item.crocin, batchNo: "CR-EMPTY", qtyBase: 5, at: ago(45), expiryDate: "2026-10-01" });
    await consume(empty, 5, ago(40));
    // Expired stock at ANOTHER store is that store's shelf, not the counter's.
    await stockIn(db, fx, { itemId: fx.item.azithro, batchNo: "AZ-M-OLD", qtyBase: 5, at: ago(45), expiryDate: "2026-09-01", resourceId: mainStore });

    const advice = await reorderAdvice(db, NOW);

    expect(advice.items.map((i) => [i.code, i.status, i.available, i.unsoldByExpiry, i.daysOfCover, i.suggestBase])).toEqual([
      // 90 on the shelf but 30 will expire: 60 is 20 days of cover, not 30.
      ["AZEE500", "ok", 90, 30, 20, 0],
      // 110 on the shelf, 5 will expire: 105 at 3 a day is 35 days.
      ["CALP500", "ok", 110, 5, 35, 0],
      ["CROC500", "no_movement", 20, 20, null, 0],
    ]);
    expect(advice.expiring.map((e) => [e.code, e.batchNo, e.expiryDate, e.daysLeft, e.available, e.unsoldByExpiry, e.action])).toEqual([
      ["AZEE500", "AZ-SOON", "2026-09-25", 9, 60, 30, "move_back"],
      ["CALP500", "CP-1", "2026-10-16", 30, 10, 0, "sell_first"],
      ["CALP500", "CP-2", "2026-10-20", 34, 100, 5, "move_back"],
      ["CROC500", "CR-NEAR", "2026-11-30", 75, 20, 20, "move_back"],
    ]);
    expect(advice.expiredOnShelf.map((e) => [e.code, e.batchNo, e.expiryDate, e.onHand])).toEqual([["CALP500", "CP-OLD", "2026-09-10", 12]]);
  });

  it("counts cover short when near-expiry stock will not sell, and suggests the shortfall", async () => {
    // 60 used (2 a day). The 40 left expire today: one selling day sells 2, and 38 expire. The
    // shelf looks like 20 days of cover and is one.
    const b = await stockIn(db, fx, { itemId: fx.item.crocin, batchNo: "CR-TODAY", qtyBase: 100, at: ago(40), expiryDate: "2026-09-16" });
    await consume(b, 60, ago(4));
    const advice = await reorderAdvice(db, NOW);
    // 7 days is 14; 14 - 2 = 12, rounded up to a strip of 10: 20.
    expect(advice.items.find((i) => i.code === "CROC500")).toMatchObject({
      status: "reorder", available: 40, unsoldByExpiry: 38, daysOfCover: 1, suggestBase: 20, suggestPacks: "2 strip",
    });
    expect(advice.expiring).toMatchObject([{ batchNo: "CR-TODAY", daysLeft: 0, unsoldByExpiry: 38, action: "move_back" }]);
    // Its last selling day is today: near expiry, not expired.
    expect(advice.expiredOnShelf).toEqual([]);
  });

  it("says nothing needs ordering when the cover is enough, and refuses without the counter's store", async () => {
    const crocin = await stockIn(db, fx, { itemId: fx.item.crocin, batchNo: "CR-1", qtyBase: 100, at: ago(20), expiryDate: "2027-12-31" });
    await consume(crocin, 30, ago(5));
    const advice = await reorderAdvice(db, NOW);
    expect(advice.items.find((i) => i.code === "CROC500")).toMatchObject({ status: "ok", available: 70, usedInWindow: 30, daysOfCover: 70, suggestBase: 0 });

    await db.execute(sql`update resources set code = 'RETIRED-PHARM', status = 'retired' where lower(code) = 'pharm-opd'`);
    await expect(reorderAdvice(db, NOW)).rejects.toMatchObject({ code: "store_missing" });
  });
});
