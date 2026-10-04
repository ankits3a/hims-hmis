import { grantPermissionToRole } from "../src/kernel/auth/permissions";
import { effectiveRegulation, listItems } from "../src/modules/materials";
import { importPriceList, matchPriceList, parsePack, rupeesToPaise } from "../src/modules/pharmacy/price-list-import";
import { setupTestDb, truncateAll } from "./helpers/db";
import { seedPharmacyBase } from "./helpers/pharmacy";
import type { PharmacyFixture } from "./helpers/pharmacy";
import type { Db } from "../src/kernel/db/client";

/**
 * Owner 2026-10-04 — a vendor's list (manufacturer, brand, composition, packing) into the item master: each row
 * matched to the national catalogue, reviewed, and the ticked ones made through `createStockDrug`.
 */
describe("a vendor's price list into the item master", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: PharmacyFixture;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });
  beforeEach(async () => {
    await truncateAll(db);
    fx = await seedPharmacyBase(db);
    await grantPermissionToRole(db, fx.registry, "pharmacy", "materials.items.manage");
  });
  afterEach(() => { fx.unregister(); });

  it("reads a pack and a price the way vendors write them", () => {
    expect(parsePack("10x15", "tablet")).toEqual({ packType: "tablet_strip", packSize: 15 });
    expect(parsePack("1 x 10 Cap", "")).toEqual({ packType: "capsule_strip", packSize: 10 });
    expect(parsePack("100 ml", "syrup")).toEqual({ packType: "bottle", packSize: 1 });
    expect(parsePack("1 vial", "injection")).toEqual({ packType: "vial", packSize: 1 });
    expect(parsePack("15 gm", "cream")).toEqual({ packType: "tube", packSize: 1 });
    expect(rupeesToPaise("₹ 35.50")).toBe(3550);
    expect(rupeesToPaise("Rs.1,120/-")).toBe(112_000);
    expect(rupeesToPaise("")).toBeNull();
  });

  it("matches each row to the catalogue, says when the brand is already stocked, and writes nothing", async () => {
    const before = (await listItems(db, { class: "drug" })).length;
    const rows = await matchPriceList(db, [
      { manufacturer: "Abbott", brand: "Brufen 400", composition: "Ibuprofen 400 mg", pack: "10x15", mrp: "₹ 42.10", gst: "5%" },
      { manufacturer: "GSK", brand: "Crocin 500", composition: "Paracetamol 500mg", pack: "10x15" },
      { manufacturer: "Nobody", brand: "Zzqx 99", composition: "", pack: "" },
    ]);
    expect(rows[0]).toMatchObject({ best: { medicineId: fx.med.ibuprofen, schedule: "H" }, existing: null, packType: "tablet_strip", packSize: 15, gstRateBps: 500, hsnCode: "3004", mrpPerPackPaise: 4210 });
    expect(rows[1]!.best?.medicineId).toBe(fx.med.crocin);
    expect(rows[1]!.existing).not.toBeNull(); // Crocin 500 is already in the item master
    expect(rows[2]!.best).toBeNull();
    expect((await listItems(db, { class: "drug" })).length).toBe(before);
  });

  it("makes each ticked row an item with its pack and MRP; a duplicate is refused for that row alone", async () => {
    const results = await importPriceList(db, fx.incharge.actor, [
      { line: 1, medicineId: fx.med.ibuprofen, brand: "Brufen 400", packType: "tablet_strip", packSize: 15, gstRateBps: 500, hsnCode: "3004", mrpPerPackPaise: 4210, storage: "ambient" },
      { line: 2, medicineId: fx.med.crocin, brand: "Crocin 500", packType: "tablet_strip", packSize: 15, gstRateBps: 500, hsnCode: "3004", mrpPerPackPaise: 3000, storage: "ambient" },
    ]);
    expect(results[0]).toMatchObject({ line: 1, ok: true });
    expect(results[1]).toMatchObject({ line: 2, ok: false, code: "duplicate_code" });
    const made = results[0]!.ok ? results[0]! : null;
    const reg = await effectiveRegulation(db, made!.itemId, new Date());
    expect(reg).toMatchObject({ mrpDefaultPaise: 4210, mrpUom: "strip" });
  });

  it("a person without the sale-item right is refused once, not once per row", async () => {
    await expect(importPriceList(db, fx.aide.actor, [
      { line: 1, medicineId: fx.med.ibuprofen, brand: "Brufen 400", packType: "tablet_strip", packSize: 15, gstRateBps: 500, hsnCode: "3004", mrpPerPackPaise: 4210, storage: "ambient" },
    ])).rejects.toMatchObject({ code: "permission_denied" });
  });
});
