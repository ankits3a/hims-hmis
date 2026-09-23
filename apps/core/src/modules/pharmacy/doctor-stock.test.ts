import { sql } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { MON, seedPharmacyBase, stockIn } from "../../../test/helpers/pharmacy";
import { stockForDoctor } from "./doctor-stock";
import { PharmacyDoctorController } from "./pharmacy-doctor.controller";
import type { Db } from "../../kernel/db/client";
import type { PharmacyFixture } from "../../../test/helpers/pharmacy";

/**
 * CONSULT V2 — the count beside each medicine on the doctor's screen (owner, 2026-09-23; D13).
 *
 * The fixture's shelf: Crocin 500 and Calpol 500 (generic equivalents, both paracetamol 500 mg), Azee 500.
 * Brufen 400 is in the formulary and NOT on the shelf. Alprax is Schedule X.
 */
describe("the doctor's read of the shelf", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: PharmacyFixture;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { fx?.unregister(); await teardown(); });

  beforeEach(async () => {
    fx?.unregister();
    await truncateAll(db);
    fx = await seedPharmacyBase(db);
  });

  it("counts SELLABLE stock: an expired batch is not something the pharmacy can hand over", async () => {
    await stockIn(db, fx, { itemId: fx.item.azithro, batchNo: "A1", qtyBase: 30 });
    await stockIn(db, fx, { itemId: fx.item.azithro, batchNo: "OLD", qtyBase: 50, expiryDate: "2026-01-31" });
    const [row] = await stockForDoctor(db, [fx.med.azithro], MON);
    expect(row).toEqual({ medicineId: fx.med.azithro, available: 30, unit: "tablet", alternatives: [] });
  });

  it("at zero it offers the same composition from the shelf, with stock, most first", async () => {
    await stockIn(db, fx, { itemId: fx.item.calpol, batchNo: "C1", qtyBase: 100 });
    const [row] = await stockForDoctor(db, [fx.med.crocin], MON);
    expect(row!.available).toBe(0);
    expect(row!.alternatives).toEqual([
      { medicineId: fx.med.calpol, brandName: "Calpol 500", strengthLabel: "500 mg", available: 100, unit: "tablet" },
    ]);
  });

  it("an alternative with nothing on the shelf is not offered", async () => {
    const [row] = await stockForDoctor(db, [fx.med.crocin], MON);
    expect(row!.available).toBe(0);
    expect(row!.alternatives).toEqual([]);
  });

  it("a medicine this pharmacy does not carry is a real zero", async () => {
    await stockIn(db, fx, { itemId: fx.item.azithro, batchNo: "A1", qtyBase: 30 });
    const [row] = await stockForDoctor(db, [fx.med.ibuprofen], MON);
    expect(row!.available).toBe(0);
  });

  it("UNKNOWN IS NOT ZERO: with nothing on sale at all, every answer is null", async () => {
    await truncateAll(db);
    fx.unregister();
    fx = await seedPharmacyBase(db);
    // A pharmacy whose store exists but whose shelf is empty is a pharmacy that is not open.
    await db.execute(sql`update pharmacy_sale_items set active = false`);
    const rows = await stockForDoctor(db, [fx.med.crocin, fx.med.azithro], MON);
    expect(rows.map((r) => r.available)).toEqual([null, null]);
  });

  it("the route takes a comma list and answers per medicine", async () => {
    await stockIn(db, fx, { itemId: fx.item.azithro, batchNo: "A1", qtyBase: 12 });
    const ctl = new PharmacyDoctorController(db);
    const res = await ctl.stock({ medicineIds: `${fx.med.azithro}, ${fx.med.crocin}` });
    expect(res.items.map((i) => [i.medicineId, i.available])).toEqual([[fx.med.azithro, 12], [fx.med.crocin, 0]]);
    await expect(ctl.stock({ medicineIds: "" })).rejects.toThrow();
  });
});
