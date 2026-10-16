import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { MON, addAllergy, issueRx, line, seedPharmacyBase, stockIn } from "../../../test/helpers/pharmacy";
import { ensureRole, mkUser } from "../../../test/helpers/opd";
import { withTx } from "../../kernel/db/client";
import { pharmacyShelfLocations } from "../../kernel/db/schema";
import { createStore } from "../materials";
import { RETAIL_PHARMACY_STORE_CODE } from "./config";
import { retailBatches, retailPatientContext } from "./retail";
import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import type { PharmacyFixture } from "../../../test/helpers/pharmacy";
import type { Db } from "../../kernel/db/client";

/**
 * #638 (UX audit §5.9) — what the walk-in desk's lane and cart now read: an item's saleable batches at the retail store
 * with its shelf, for a manual choice; and the customer's active allergies and current medicines. Read-only, behind the
 * seller's own grant.
 */
const HEAD: Actor = { type: "user", id: "01HMATERIALSHEAD00000000001" };
const DAY = 24 * 60 * 60_000;

describe("the walk-in desk's reads (#638)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: PharmacyFixture;
  let retailId: string;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    fx = await seedPharmacyBase(db);
    ({ resourceId: retailId } = await withTx(db, (tx) => createStore(tx, HEAD, { code: RETAIL_PHARMACY_STORE_CODE, name: "Walk-in retail pharmacy" })));
  });
  afterEach(() => { fx.unregister(); });

  it("lists the item's saleable batches at the retail store, earliest expiry first, with its shelf; never an expired, empty or other store's batch", async () => {
    await stockIn(db, fx, { itemId: fx.item.crocin, batchNo: "OPD-1", qtyBase: 50, expiryDate: "2027-01-31" });
    await stockIn(db, fx, { itemId: fx.item.crocin, batchNo: "OLD", qtyBase: 10, expiryDate: "2026-08-01", resourceId: retailId });
    const late = await stockIn(db, fx, { itemId: fx.item.crocin, batchNo: "LATE", qtyBase: 30, expiryDate: "2028-03-31", resourceId: retailId });
    const soon = await stockIn(db, fx, { itemId: fx.item.crocin, batchNo: "SOON", qtyBase: 20, expiryDate: "2027-06-30", resourceId: retailId });
    await db.insert(pharmacyShelfLocations).values({ id: newId(), storeResourceId: retailId, itemId: fx.item.crocin, location: "rack 3 · shelf 2", setBy: HEAD.id });
    const r = await retailBatches(db, fx.pharmacist.actor, fx.item.crocin, MON);
    expect(r.location).toBe("rack 3 · shelf 2");
    expect(r.batches.map((b) => [b.batchId, b.batchNo, b.expiryDate, b.available])).toEqual([
      [soon, "SOON", "2027-06-30", 20], [late, "LATE", "2028-03-31", 30],
    ]);
    await expect(retailBatches(db, fx.aide.actor, fx.item.crocin, MON)).rejects.toMatchObject({ code: "permission_denied" });
  });

  it("the customer's active allergies and the medicines still current on an issued prescription; a stranger to the grant is refused", async () => {
    await addAllergy(db, fx.patient.id, "Penicillin");
    await issueRx(db, fx, [line({ drug: "Crocin 500 tablet", durationDays: 5 }), line({ drug: "Azee 500 tablet", durationDays: 30, frequency: "OD" })]);
    const ctx = await retailPatientContext(db, fx.pharmacist.actor, fx.patient.id, new Date(MON.getTime() + 10 * DAY));
    expect(ctx.allergies.map((a) => a.substance)).toEqual(["Penicillin"]);
    // Ten days on, the five-day line has ended; the thirty-day line is current.
    expect(ctx.currentMedicines.map((m) => [m.drug, m.frequency, m.assumedCurrent])).toEqual([["Azee 500 tablet", "OD", false]]);
    await ensureRole(db, "nobody");
    const stranger = await mkUser(db, "no.grant", ["nobody"]);
    await expect(retailPatientContext(db, stranger.actor, fx.patient.id, MON)).rejects.toMatchObject({ code: "permission_denied" });
  });
});
