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

    expect(advice.window).toEqual({ days: 30, minCoverDays: 3, targetCoverDays: 7 });
    expect(advice.items.map((i) => [i.code, i.status, i.available, i.usedInWindow, i.daysOfCover, i.suggestBase, i.suggestPacks, i.source])).toEqual([
      // 10 in 30 days is a third a day: 7 days is 3 tablets, rounded up to a strip.
      ["CALP500", "stock_out", 0, 10, 0, 10, "1 strip", null],
      // 38 in 30 days: 7 days is 9, less the 2 on the shelf is 7, rounded up to a strip.
      ["AZEE500", "reorder", 2, 38, 1.6, 10, "1 strip", { storeCode: "MAIN-STORE", storeName: "Main store", available: 50 }],
      ["CROC500", "no_movement", 30, 0, null, 0, null, null],
    ]);
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
