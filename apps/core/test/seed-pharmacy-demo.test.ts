import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "./helpers/db";
import { seedPharmacyBase } from "./helpers/pharmacy";
import { ensureRole } from "./helpers/opd";
import { assertDemoDataAllowed, seedPharmacyDemo } from "../scripts/seed-pharmacy-demo";
import { ensurePharmacyCounter } from "../scripts/seed-pharmacy";
import { assignRole, grantPermissionToRole } from "../src/kernel/auth/permissions";
import { roleAssignments, stockBatches } from "../src/kernel/db/schema";
import { availableQty, balances, findStoreByCode, listVendors } from "../src/modules/materials";
import { listSaleItems } from "../src/modules/pharmacy";
import type { PharmacyFixture } from "./helpers/pharmacy";
import type { Db } from "../src/kernel/db/client";

/**
 * ═══ THE PHARMACY DEMO SHELF ═══
 *
 * The counter is deployed and opens onto nothing: `seed:pharmacy` establishes the store and the
 * workflow definition and stops, correctly, because everything after that is hospital master data.
 * This seed is the demo shelf, and this suite exists because a seed nobody tests is a seed that rots
 * between the day it is written and the day somebody stands a hospital up with it.
 *
 * THE ASSERTION THAT MATTERS MOST IS NOT "rows were created". It is that the shelf behaves the way
 * the COUNTER will read it — that `availableQty`, the predicate `fefoPick` actually picks from,
 * agrees with what was received, and that the deliberately expired delivery is present on the shelf
 * and absent from what can be sold. A seed that hand-inserted its batches would satisfy a row count
 * and fail the first scan.
 */
describe("seed:pharmacy-demo — the synthetic catalogue and shelf", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: PharmacyFixture;
  let storeId: string;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });

  beforeEach(async () => {
    await truncateAll(db);
    fx = await seedPharmacyBase(db);
    /* The seed resolves BOTH actors before it writes: §2 of the runbook is two people. The fixture
       gives us a `pharmacy` holder; `materials_head` is the other half and nothing else creates it —
       not the role, not the grant, not the holder. `seed:roles` mints role keys on a real box; here
       the fixture has to. */
    await ensureRole(db, "materials_head");
    await grantPermissionToRole(db, fx.registry, "materials_head", "materials.items.manage");
    await assignRole(db, { userId: fx.pharmacist.id, roleKey: "materials_head", scopeType: "hospital" });
    await ensurePharmacyCounter(db, fx.pharmacist.actor);
    const store = await findStoreByCode(db, "PHARM-OPD");
    storeId = store!.id;
  });
  afterEach(() => { fx.unregister(); });

  it("puts stock on the shelf through the REAL GRN path — a vendor, a challan and a QC verdict behind every batch", async () => {
    const report = await seedPharmacyDemo(db);

    /* ENSURED, NOT CREATED — and the distinction is the seed's whole contract. `seedPharmacyBase`
       already carries three of the eight (CROC500, CALP500, AZEE500), so a `created === 8`
       assertion would be testing the FIXTURE rather than the seed, and would break the day anyone
       added a fourth. What the seed promises is that all eight are there afterwards, however many
       it had to make. */
    expect(report.itemsCreated + report.itemsExisting).toBe(8);
    expect(report.saleItemsRegistered + report.saleItemsExisting).toBe(8);
    expect(report.medicinesCreated + report.medicinesExisting).toBe(8);
    expect(report.grnsPosted).toBe(2);
    expect(report.vendorCreated).toBe(true);

    /* The vendor is ACTIVE, which means it passed the document gate: gst_certificate and pan for
       any vendor, plus BOTH halves of the wholesale licence because it is drugLicensed. A demo
       shelf whose vendor is still `draft` would be stock no GRN could legally have accepted. */
    const vendor = (await listVendors(db, { search: "DEMO-PHARMA-DIST" }))
      .find((v) => v.code === "DEMO-PHARMA-DIST");
    expect(vendor?.status).toBe("active");

    /* EVERY batch carries the GRN line that created it. This is the assertion a hand-INSERT
       (test/helpers/pharmacy.ts `stockIn`) could not satisfy, and it is the reason the seed does
       not reuse that helper's shape. */
    const batches = await db.select().from(stockBatches);
    expect(batches.length).toBe(16); // 8 medicines x 2 deliveries
    expect(batches.every((b) => b.grnLineId !== null)).toBe(true);
    expect(batches.every((b) => b.vendorId === vendor?.id)).toBe(true);
  });

  /**
   * THE POINT OF THE AGED CHALLAN.
   *
   * QC rule 5 refuses a near-expiry line at the bay, so expired stock cannot be RECEIVED today —
   * the only honest way onto a demo shelf is the way a real pharmacy gets it: a delivery accepted
   * long ago that has since gone out of date. The runbook's §3.5 expiry proof needs exactly that,
   * and `sellableBatchRows` must refuse to offer it.
   *
   * DISCRIMINATION: both numbers are asserted. `sellableUnits > 0` alone would pass on a shelf with
   * no expired stock at all, and `expiredUnitsOnShelf > 0` alone would pass on a shelf that is
   * entirely expired. It is the GAP between them that says the seed built the right shelf.
   */
  it("the aged delivery is ON the shelf and NOT sellable — the gap the runbook's expiry drill needs", async () => {
    const report = await seedPharmacyDemo(db);

    expect(report.sellableUnits).toBeGreaterThan(0);
    expect(report.expiredUnitsOnShelf).toBeGreaterThan(0);

    const onShelf = (await balances(db, { resourceId: storeId })).reduce((n, b) => n + b.qtyOnHand, 0);
    expect(onShelf).toBe(report.sellableUnits + report.expiredUnitsOnShelf);

    /* Per item the counter sees exactly one delivery's worth, not two: 20 strips x 10 tablets. */
    const sale = await listSaleItems(db);
    const crocin = sale.find((s) => s.code === "CROC500");
    expect(await availableQty(db, storeId, crocin!.itemId)).toBe(200);
  });

  /**
   * "A seed an operator is afraid to run twice is a seed they run once and then work around."
   *
   * The pharmacy road has no natural re-run key — `grns` is unique on the GENERATED `grn_no` only,
   * so a second run of the same challan would post a second delivery and silently double the shelf.
   * The seed supplies the idempotency the module does not, and this is what proves it.
   */
  it("is idempotent — a second run adds no ninth medicine and no third delivery", async () => {
    const first = await seedPharmacyDemo(db);
    const second = await seedPharmacyDemo(db);

    expect(second.medicinesCreated).toBe(0);
    expect(second.medicinesExisting).toBe(8);
    expect(second.itemsCreated).toBe(0);
    expect(second.saleItemsRegistered).toBe(0);
    expect(second.saleItemsExisting).toBe(8);
    expect(second.vendorCreated).toBe(false);
    expect(second.grnsPosted).toBe(0);
    expect(second.grnsSkipped).toBe(2);

    /* The shelf is the real proof: the same stock, not twice the stock. */
    expect(second.batchesOnShelf).toBe(first.batchesOnShelf);
    expect(second.sellableUnits).toBe(first.sellableUnits);
    expect((await db.select().from(stockBatches)).length).toBe(16);
  });

  it("refuses, with an instruction, when no user holds a role it needs", async () => {
    await db.delete(roleAssignments).where(eq(roleAssignments.roleKey, "materials_head"));
    await expect(seedPharmacyDemo(db)).rejects.toThrow(/no user holds the "materials_head" role/);
    /* And it refuses BEFORE writing: a half-populated catalogue is worse than none, because the
       operator has to work out what landed. */
    expect((await db.select().from(stockBatches)).length).toBe(0);
  });

  describe("the synthetic-data door", () => {
    it("refuses without the explicit opt-in, and NAMES the database it would have written to", () => {
      expect(() => assertDemoDataAllowed({}, "hmis_prod"))
        .toThrow(/hmis_prod/);
    });
    it("refuses under NODE_ENV=production even WITH the opt-in", () => {
      expect(() => assertDemoDataAllowed({ NODE_ENV: "production", ALLOW_DEMO_DATA: "yes" }, "hmis_uat"))
        .toThrow(/NODE_ENV=production/);
    });
    it("names the drug licence in its refusal, because that is what makes it more than demo data", () => {
      expect(() => assertDemoDataAllowed({}, "hmis_uat")).toThrow(/drug-licence/);
    });
    it("allows exactly the one spelling, off production", () => {
      expect(() => assertDemoDataAllowed({ ALLOW_DEMO_DATA: "yes" }, "hmis_uat")).not.toThrow();
      expect(() => assertDemoDataAllowed({ ALLOW_DEMO_DATA: "true" }, "hmis_uat")).toThrow();
    });
  });
});
