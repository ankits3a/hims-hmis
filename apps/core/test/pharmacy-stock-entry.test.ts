import { eq } from "drizzle-orm";
import { withTx } from "../src/kernel/db/client";
import { formularyMedicines } from "../src/kernel/db/schema";
import { grantPermissionToRole } from "../src/kernel/auth/permissions";
import { effectiveRegulation, getItem, listItems, registerItem } from "../src/modules/materials";
import { createService } from "../src/modules/tariff";
import { getSaleItem } from "../src/modules/pharmacy";
import { captureOpeningStock, costPerBase, planOpeningGrid, planOpeningStock, readOpeningSheet } from "../src/modules/pharmacy/opening-stock";
import { createStockDrug, stockEntryItems, stockEntryMedicine } from "../src/modules/pharmacy/stock-drug";
import { setupTestDb, truncateAll } from "./helpers/db";
import { seedPharmacyBase } from "./helpers/pharmacy";
import type { OpeningGridRow } from "../src/modules/pharmacy/opening-stock";
import type { NewStockDrug } from "../src/modules/pharmacy/stock-drug";
import type { PharmacyFixture } from "./helpers/pharmacy";
import type { Db } from "../src/kernel/db/client";

/**
 * ═══ STOCK ENTRY ON SCREEN (2026-09-29) — THE GRID'S DOOR, ITS SEARCH, AND THE NEW-DRUG TRANSACTION ═══
 *
 * The grid sends the picked item and the cells as typed; `planOpeningGrid` turns them into the sheet's rows
 * and judges them with the SAME function as the CSV (`planOpeningRows`) — pinned here by sending one row both
 * ways and getting one judgement. A new drug is item + pack + MRP + sale registration in ONE transaction,
 * with the permissions of the acts it reuses.
 */
describe("stock entry on screen — the grid, the brand search and the new drug", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: PharmacyFixture;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });
  beforeEach(async () => {
    await truncateAll(db);
    fx = await seedPharmacyBase(db);
    for (const p of ["materials.items.manage", "materials.vendors.manage"]) await grantPermissionToRole(db, fx.registry, "pharmacy", p);
  });
  afterEach(() => { fx.unregister(); });

  const year = (): string => String(new Date().getUTCFullYear() + 1).slice(2);
  const row = (over: Partial<OpeningGridRow> = {}): OpeningGridRow => ({
    itemId: fx.item.crocin, batch: "G1", expiry: `08/${year()}`, mrpPerPack: "40.00", packSize: "10", packs: "3",
    ratePerPack: "28.00", discountPct: "", freePacks: "", packType: "tablet_strip", rack: "", supplier: "", ...over,
  });

  it("the cost of a unit: rate × (1 − d/100) ÷ pack, in integers, rounded down", () => {
    expect(costPerBase(2800, 0, 10)).toBe(280);
    expect(costPerBase(2800, 1000, 10)).toBe(252);
    expect(costPerBase(3550, 1250, 15)).toBe(207); // 3550 × 0.875 / 15 = 207.08
    expect(costPerBase(0, 0, 10)).toBe(0);
  });

  it("the grid and the sheet get ONE judgement: the same row both ways gives the same reasons and the same cost", async () => {
    const now = new Date();
    const cells = [row({ mrpPerPack: "35.555" }), row({ batch: "G2", expiry: "01/20" }), row({ batch: "G3", discountPct: "12.5" })];
    const grid = await planOpeningGrid(db, cells, now);
    const csv = `brand,batch,expiry,mrp_per_pack,pack_size,packs,rack,supplier_name,purchase_rate_per_pack,pack_type,free_packs,trade_discount_pct\n${
      cells.map((c) => ["Crocin 500", c.batch, c.expiry, c.mrpPerPack, c.packSize, c.packs, "", "", c.ratePerPack, c.packType, c.freePacks, c.discountPct].join(",")).join("\n")}\n`;
    const sheet = await planOpeningStock(db, readOpeningSheet(csv), csv, now);
    const judged = (p: typeof grid): unknown[] => p.rows.map((r) => [r.itemId, r.reasons, r.costPerBasePaise, r.uom]);
    expect(judged(grid)).toEqual(judged(sheet));
    expect(grid.rows[0]!.reasons.join()).toMatch(/mrp_per_pack must be rupees like 35.50, got "35.555"/);
    expect(grid.rows[1]!.reasons.join()).toMatch(/expired/);
    expect(grid.rows[2]).toMatchObject({ reasons: [], costPerBasePaise: 245, discountBps: 1250 });
  });

  it("the grid refuses an item the counter does not sell, captures once, and leaves the QC to the pharmacist", async () => {
    const now = new Date();
    const { itemId: unsold } = await withTx(db, (tx) => registerItem(tx, fx.incharge.actor, {
      code: "NOSALE1", name: "Nosale 10 tablet", class: "drug", baseUom: "tablet", batchTracked: true, formularyMedicineId: fx.med.ibuprofen,
    }));
    const refused = await planOpeningGrid(db, [row({ itemId: unsold })], now);
    expect(refused.rows[0]!.reasons.join()).toMatch(/not sold at the counter yet/);
    await expect(captureOpeningStock(db, fx.incharge.actor, refused, now)).rejects.toMatchObject({ code: "opening_stock_refused" });

    const rows = [row(), row({ itemId: fx.item.calpol, batch: "K1", packSize: "15", mrpPerPack: "35.50", ratePerPack: "", freePacks: "1", rack: "B2" })];
    const plan = await planOpeningGrid(db, rows, now);
    expect(plan).toMatchObject({ refusals: 0, newUoms: 1, units: 30 + 60, zeroCost: 1 });
    expect(plan.rows[1]).toMatchObject({ uom: "strip15", newUom: true });
    const done = await captureOpeningStock(db, fx.incharge.actor, plan, now);
    expect(done).toMatchObject({ uomsAdded: 1, vendorCreated: true, racksSet: 1 });
    expect(done.captured).toHaveLength(1);
    expect(done.captured[0]!.challanNo).toMatch(/^OPENING\//); // the office's Today lists it for the pharmacist's QC
    // The same grid again captures nothing — the sheet's once-only promise.
    expect(await captureOpeningStock(db, fx.incharge.actor, await planOpeningGrid(db, rows, now), now)).toMatchObject({ captured: [], alreadyOnBooks: 1 });
  });

  it("the brand search: every word must match; strength, form, packs, schedule, on-sale and the MRP on file", async () => {
    const hits = await stockEntryItems(db, "croc 500");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      itemId: fx.item.crocin, code: "CROC500", baseUom: "tablet", onSale: true, strength: "500 mg", form: "tablet", schedule: "OTC",
      packs: [{ uom: "tablet", multiplier: 1 }, { uom: "strip", multiplier: 10 }], gstRateBps: 1200, mrpPaise: null,
    });
    expect(await stockEntryItems(db, "croc 650")).toEqual([]);
    expect(await stockEntryItems(db, "c")).toEqual([]);
  });

  const DOLO: NewStockDrug = {
    brandName: "Dolo 650", strength: "650 mg", medicineId: "", form: "tablet", packType: "tablet_strip", packSize: 15,
    hsnCode: "3004", gstRateBps: 500, schedule: null, mrpPerPackPaise: 3360, storage: "ambient",
  };

  it("a NEW DRUG is item + pack + MRP + sale registration in one call, and the grid can receive it at once", async () => {
    const now = new Date();
    expect(await stockEntryMedicine(db, fx.med.crocin)).toMatchObject({ form: "tablet", strength: "500 mg", schedule: "OTC" });
    const made = await createStockDrug(db, fx.incharge.actor, { ...DOLO, medicineId: fx.med.crocin }, now);
    expect(made).toMatchObject({ code: "DOLO650", name: "Dolo 650 tablet", uom: "strip", packSize: 15, gstRateBps: 500 });
    const item = await getItem(db, made.itemId);
    expect(item).toMatchObject({ class: "drug", baseUom: "tablet", formularyMedicineId: fx.med.crocin, hsnCode: "3004", gstRateBps: 500, storageClass: "ambient" });
    expect(item?.uoms.map((u) => [u.uom, u.toBaseMultiplier])).toEqual(expect.arrayContaining([["tablet", 1], ["strip", 15]]));
    expect(await effectiveRegulation(db, made.itemId, new Date(now.getTime() + 1000))).toMatchObject({ mrpDefaultPaise: 3360, mrpUom: "strip" });
    expect(await getSaleItem(db, made.itemId)).toMatchObject({ active: true });
    expect((await stockEntryItems(db, "dolo"))[0]).toMatchObject({ itemId: made.itemId, onSale: true, mrpPaise: 3360 });
    const plan = await planOpeningGrid(db, [row({ itemId: made.itemId, packSize: "15", mrpPerPack: "33.60", ratePerPack: "24.00" })], now);
    expect(plan.rows[0]).toMatchObject({ reasons: [], uom: "strip", newUom: false, costPerBasePaise: 160 });

    // The same drug twice is refused with the one that exists named; a bottle counts bottles.
    await expect(createStockDrug(db, fx.incharge.actor, { ...DOLO, medicineId: fx.med.crocin }, now)).rejects.toMatchObject({ code: "duplicate_code" });
    const syrup = await createStockDrug(db, fx.incharge.actor, {
      ...DOLO, brandName: "Calpol syrup", strength: "", form: "", packType: "bottle", packSize: 1, gstRateBps: 0, mrpPerPackPaise: 4550, medicineId: fx.med.calpol,
    }, now);
    expect(syrup).toMatchObject({ code: "CALPOLSYRUP", uom: "bottle", packSize: 1, gstRateBps: 0 });
    expect((await getItem(db, syrup.itemId))?.baseUom).toBe("bottle");
  });

  it("a NEW DRUG asks for the acts' own permissions, changes the schedule only with formulary.manage, and is all or nothing", async () => {
    const now = new Date();
    // The aide holds neither pharmacy.sale_items.manage nor formulary.manage: refused before anything is written.
    await expect(createStockDrug(db, fx.aide.actor, { ...DOLO, medicineId: fx.med.crocin }, now))
      .rejects.toMatchObject({ code: "permission_denied", detail: { lacking: ["pharmacy.sale_items.manage"] } });
    await expect(createStockDrug(db, fx.incharge.actor, { ...DOLO, medicineId: fx.med.crocin, schedule: "H" }, now))
      .rejects.toMatchObject({ code: "permission_denied", detail: { lacking: ["formulary.manage"] } });
    expect((await listItems(db, { search: "dolo" }))).toEqual([]);

    await grantPermissionToRole(db, fx.registry, "pharmacy", "formulary.manage");
    await createStockDrug(db, fx.incharge.actor, { ...DOLO, medicineId: fx.med.crocin, schedule: "H" }, now);
    const [med] = await db.select({ flag: formularyMedicines.scheduleFlag }).from(formularyMedicines).where(eq(formularyMedicines.id, fx.med.crocin));
    expect(med?.flag).toBe("H");

    // A failure in the LAST act (the sale registration's service code is taken) leaves no item behind.
    await withTx(db, (tx) => createService(tx, fx.incharge.actor, { code: "RX-ZOLO5", name: "taken", category: "pharmacy_5", regulated: false }));
    await expect(createStockDrug(db, fx.incharge.actor, { ...DOLO, brandName: "Zolo 5", strength: "5 mg", medicineId: fx.med.calpol }, now)).rejects.toBeDefined();
    expect((await listItems(db, { search: "zolo" }))).toEqual([]);
  });
});
