import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { MON2, issueRx, line, seedPharmacyBase } from "../../../test/helpers/pharmacy";
import { testCfg } from "../../../test/helpers/opd";
import { withTx } from "../../kernel/db/client";
import { events } from "../../kernel/db/schema";
import { createStore, registerItem } from "../materials";
import { claimDispense, findAtCounter } from "./claim";
import { RETAIL_PHARMACY_STORE_CODE } from "./config";
import { getDispense } from "./queue";
import { setShelfLocation } from "./shelf-locations";
import type { Actor } from "@hmis/contracts";
import type { PharmacyFixture } from "../../../test/helpers/pharmacy";
import type { Db } from "../../kernel/db/client";

/**
 * PD-D18 — WHERE THE DRUG IS. One label per (counter's store, item), set by whoever manages the
 * counter's items, and printed on the line beside the batch — the walk to the shelf is the
 * pharmacist's slowest act, and nothing used to say where to walk.
 */
describe("the shelf location on the line (PD-D18)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: PharmacyFixture;
  const HEAD: Actor = { type: "user", id: "01HMATERIALSHEAD00000000001" };

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); fx = await seedPharmacyBase(db); });
  afterEach(() => { fx.unregister(); });

  async function claimedCrocin(): Promise<string> {
    const { issued } = await issueRx(db, fx, [line({ drug: "Crocin 500", medicineId: fx.med.crocin })]);
    const r = await findAtCounter(db, testCfg, fx.pharmacist.actor, issued.qrPayload, MON2);
    if (r.kind !== "dispense") throw new Error("expected a dispense");
    await claimDispense(db, fx.pharmacist.actor, { dispenseId: r.dispense.id, door: "rx_qr" }, MON2);
    return r.dispense.id;
  }
  const located = async (id: string): Promise<string | null> => (await getDispense(db, fx.pharmacist.actor, id, MON2)).lines[0]!.location;
  const shelfEvents = async (): Promise<unknown[]> =>
    (await db.select().from(events).where(eq(events.name, "shelf.location_set"))).map((e) => e.payload);

  it("set, replaced and cleared — the line says it, and every change is on the record with who made it", async () => {
    const id = await claimedCrocin();
    expect(await located(id)).toBeNull();

    expect(await setShelfLocation(db, fx.pharmacist.actor, { storeResourceId: fx.storeId, itemId: fx.item.crocin, location: "  R-12 " }, MON2)).toEqual({ location: "R-12" });
    expect(await located(id)).toBe("R-12");
    await setShelfLocation(db, fx.pharmacist.actor, { storeResourceId: fx.storeId, itemId: fx.item.crocin, location: "rack 3 · shelf 2" }, MON2);
    expect(await located(id)).toBe("rack 3 · shelf 2");
    expect(await setShelfLocation(db, fx.pharmacist.actor, { storeResourceId: fx.storeId, itemId: fx.item.crocin, location: " " }, MON2)).toEqual({ location: null });
    expect(await located(id)).toBeNull();

    expect(await shelfEvents()).toEqual([
      { storeResourceId: fx.storeId, itemId: fx.item.crocin, location: "R-12" },
      { storeResourceId: fx.storeId, itemId: fx.item.crocin, location: "rack 3 · shelf 2" },
      { storeResourceId: fx.storeId, itemId: fx.item.crocin, location: null },
    ]);
  });

  it("is the store's, not the item's: the retail counter's drawer is not the OPD counter's rack", async () => {
    const { resourceId: retail } = await withTx(db, (tx) => createStore(tx, HEAD, { code: RETAIL_PHARMACY_STORE_CODE, name: "Retail pharmacy" }));
    const id = await claimedCrocin();
    await setShelfLocation(db, fx.pharmacist.actor, { storeResourceId: retail, itemId: fx.item.crocin, location: "drawer 2" }, MON2);
    expect(await located(id)).toBeNull();
  });

  it("refuses a store that is no counter's, an item the counter does not sell, and a label too long to print", async () => {
    const { resourceId: main } = await withTx(db, (tx) => createStore(tx, HEAD, { code: "MAIN-STORE", name: "Main store" }));
    await expect(setShelfLocation(db, fx.pharmacist.actor, { storeResourceId: main, itemId: fx.item.crocin, location: "R-1" }, MON2))
      .rejects.toThrow(expect.objectContaining({ code: "store_missing" }));
    const { itemId: gauze } = await withTx(db, (tx) => registerItem(tx, HEAD, {
      code: "GAUZE", name: "Gauze roll", class: "consumable", baseUom: "roll", batchTracked: false, gstRateBps: 1200,
      uoms: [{ uom: "box", toBaseMultiplier: 10, isPurchaseUom: true, isIssueUom: true }],
    }));
    await expect(setShelfLocation(db, fx.pharmacist.actor, { storeResourceId: fx.storeId, itemId: gauze, location: "R-1" }, MON2))
      .rejects.toThrow(expect.objectContaining({ code: "unknown_sale_item" }));
    await expect(setShelfLocation(db, fx.pharmacist.actor, { storeResourceId: fx.storeId, itemId: fx.item.crocin, location: "R".repeat(25) }, MON2))
      .rejects.toThrow(expect.objectContaining({ code: "invalid_shelf_location" }));
    expect(await shelfEvents()).toEqual([]);
  });
});
