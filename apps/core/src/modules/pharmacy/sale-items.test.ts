import { eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { withTx } from "../../kernel/db/client";
import { formularyMedicines, pharmacySaleItems, services } from "../../kernel/db/schema";
import { registerItem } from "../materials";
import { PharmacyError } from "./errors";
import {
  listSaleItems, registerSaleItem, requireActiveSaleItem, saleItemCandidates, setSaleItemActive,
} from "./sale-items";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

const HEAD: Actor = { type: "user", id: "01HMATERIALSHEAD00000000001" };
const PHARMACIST: Actor = { type: "user", id: "01HPHARMACIST000000000001" };

/**
 * PLAN 16c T2 / D3 — the bridge. Items are made through `materials/index.ts` (`registerItem`) and
 * the medicine row is inserted in the storage shape the item FK needs (the `items.test.ts` shape);
 * the SERVICE is read back from `services` to prove the bridge wrote one through tariff.
 */
describe("sale items — the item → service bridge (16c T2)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let seq = 0;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); seq = 0; });

  async function medicine(): Promise<string> {
    const id = newId();
    seq += 1;
    await db.insert(formularyMedicines).values({
      id, brandName: `Brand #${String(seq)}`, form: "tablet", strengthLabel: "500 mg", createdBy: HEAD.id, updatedBy: HEAD.id,
    });
    return id;
  }

  async function drug(code: string, gstRateBps: number | null = 1200): Promise<string> {
    const medicineId = await medicine();
    const { itemId } = await withTx(db, (tx) => registerItem(tx, HEAD, {
      code, name: `${code} tablet`, class: "drug", baseUom: "tablet", batchTracked: true,
      formularyMedicineId: medicineId, gstRateBps, uoms: [{ uom: "strip", toBaseMultiplier: 10 }],
    }));
    return itemId;
  }

  it("registers a drug item as RX-<code> in the slab's category, unregulated, and lists it", async () => {
    const itemId = await drug("AZI500", 500);
    const r = await withTx(db, (tx) => registerSaleItem(tx, PHARMACIST, itemId));
    expect(r).toMatchObject({ itemId, serviceCode: "RX-AZI500", category: "pharmacy_5" });
    const [svc] = await db.select().from(services).where(eq(services.id, r.serviceId));
    expect(svc).toMatchObject({ code: "RX-AZI500", name: "AZI500 tablet", category: "pharmacy_5", regulated: false, active: true });
    const [row] = await db.select().from(pharmacySaleItems).where(eq(pharmacySaleItems.itemId, itemId));
    expect(row).toMatchObject({ serviceId: r.serviceId, active: true, createdBy: PHARMACIST.id });

    const views = await listSaleItems(db);
    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({ itemId, code: "AZI500", serviceCode: "RX-AZI500", category: "pharmacy_5", gstRateBps: 500, active: true, itemActive: true });
    expect(await listSaleItems(db, { search: "azi" })).toHaveLength(1);
    expect(await listSaleItems(db, { search: "zzz" })).toHaveLength(0);
    expect(await requireActiveSaleItem(db, itemId)).toMatchObject({ serviceId: r.serviceId });
  });

  it("refuses a consumable, an unknown item, a second registration, and an unknown GST slab", async () => {
    const { itemId: gauze } = await withTx(db, (tx) => registerItem(tx, HEAD, {
      code: "GAUZE", name: "Gauze roll", class: "consumable", baseUom: "roll", batchTracked: false,
    }));
    await expect(withTx(db, (tx) => registerSaleItem(tx, PHARMACIST, gauze))).rejects.toThrow(expect.objectContaining({ code: "not_a_drug" }));
    await expect(withTx(db, (tx) => registerSaleItem(tx, PHARMACIST, newId()))).rejects.toThrow(expect.objectContaining({ code: "unknown_item" }));
    const itemId = await drug("PARA500");
    await withTx(db, (tx) => registerSaleItem(tx, PHARMACIST, itemId));
    await expect(withTx(db, (tx) => registerSaleItem(tx, PHARMACIST, itemId))).rejects.toThrow(expect.objectContaining({ code: "sale_item_exists" }));
    const odd = await drug("ODD28", 2800);
    await expect(withTx(db, (tx) => registerSaleItem(tx, PHARMACIST, odd))).rejects.toThrow(PharmacyError);
    // the refusal wrote NO service — the bridge is one transaction
    expect(await db.select().from(services).where(eq(services.code, "RX-ODD28"))).toHaveLength(0);
  });

  it("candidates are the active drugs not yet registered; deactivating stops the sale, not the item", async () => {
    const a = await drug("A1");
    const b = await drug("B2");
    await withTx(db, (tx) => registerItem(tx, HEAD, { code: "SWAB", name: "Swab", class: "consumable", baseUom: "piece", batchTracked: false }));
    expect((await saleItemCandidates(db)).map((i) => i.code).sort()).toEqual(["A1", "B2"]);
    await withTx(db, (tx) => registerSaleItem(tx, PHARMACIST, a));
    expect((await saleItemCandidates(db)).map((i) => i.code)).toEqual(["B2"]);
    expect((await saleItemCandidates(db, { search: "a1" })).map((i) => i.code)).toEqual([]);

    await withTx(db, (tx) => setSaleItemActive(tx, PHARMACIST, a, false));
    await expect(requireActiveSaleItem(db, a)).rejects.toThrow(expect.objectContaining({ code: "sale_item_inactive" }));
    expect((await listSaleItems(db))[0]).toMatchObject({ active: false, itemActive: true });
    await expect(withTx(db, (tx) => setSaleItemActive(tx, PHARMACIST, b, false))).rejects.toThrow(expect.objectContaining({ code: "unknown_sale_item" }));
    await expect(requireActiveSaleItem(db, b)).rejects.toThrow(expect.objectContaining({ code: "unknown_sale_item" }));
  });
});
