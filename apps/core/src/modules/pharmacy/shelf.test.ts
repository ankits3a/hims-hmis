import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { MON, MON2, issueRx, line, openVisitWithoutRx, seedPharmacyBase, stockIn } from "../../../test/helpers/pharmacy";
import { testCfg } from "../../../test/helpers/opd";
import { withTx } from "../../kernel/db/client";
import { pharmacyDispenseLines } from "../../kernel/db/schema";
import { createStore, registerItem } from "../materials";
import { claimDispense, findAtCounter } from "./claim";
import { enterPaperPrescription } from "./paper-rx";
import { previewPaperDispense, searchShelfAt } from "./retail";
import { registerSaleItem } from "./sale-items";
import { shelfByMedicine } from "./shelf";
import { verifyDispense } from "./verify";
import type { Actor } from "@hmis/contracts";
import type { PharmacyFixture } from "../../../test/helpers/pharmacy";
import type { Db } from "../../kernel/db/client";
import type { DocumentStore } from "../../kernel/documents/store";

class FakeStore implements DocumentStore {
  readonly files = new Map<string, Buffer>();
  async put(key: string, bytes: Buffer): Promise<void> { this.files.set(key, bytes); }
  async get(key: string): Promise<Buffer> {
    const b = this.files.get(key);
    if (b === undefined) throw new Error("not found");
    return b;
  }
  async remove(key: string): Promise<void> { this.files.delete(key); }
}

/**
 * ═══ #1047 — TWO SALE ITEMS ON ONE MEDICINE: NEITHER HIDES THE OTHER'S STOCK ═══
 *
 * Staging, 2026-11-13: a second item registered on the same formulary medicine made the paper-Rx
 * search show only the new item ("75 on shelf") and hide the original's 380 tablets — the per-medicine
 * map kept the LAST item by code. The fixture's `CROC500` sorts first; `CROC500X` is the second item on
 * Crocin 500, registered for sale like any other. The rule now: the item with the most sellable stock
 * across every store, a tie to the code that sorts first; and where a person chooses, both are shown
 * and the one chosen is the one sold.
 */
describe("two sale items on one medicine (#1047)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: PharmacyFixture;
  let second: string;
  const HEAD: Actor = { type: "user", id: "01HMATERIALSHEAD00000000001" };

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    fx = await seedPharmacyBase(db);
    second = await withTx(db, async (tx) => {
      const { itemId } = await registerItem(tx, HEAD, {
        code: "CROC500X", name: "Crocin 500 new pack", class: "drug", baseUom: "tablet", batchTracked: true, formularyMedicineId: fx.med.crocin, gstRateBps: 1200,
        uoms: [{ uom: "strip", toBaseMultiplier: 10, isPurchaseUom: true, isIssueUom: true }],
      });
      await registerSaleItem(tx, fx.pharmacist.actor, itemId);
      return itemId;
    });
  });
  afterEach(() => { fx.unregister(); });

  it("the item holding the stock is the medicine's, though it sorts first — summed over every store", async () => {
    const ward = (await withTx(db, (tx) => createStore(tx, HEAD, { code: "WARD-STORE", name: "Ward store" }))).resourceId;
    await stockIn(db, fx, { itemId: fx.item.crocin, batchNo: "CR-A", qtyBase: 50 });
    await stockIn(db, fx, { itemId: fx.item.crocin, batchNo: "CR-W", qtyBase: 330, resourceId: ward });
    await stockIn(db, fx, { itemId: second, batchNo: "CR-X", qtyBase: 75 });
    const shelf = await shelfByMedicine(db);
    expect(shelf.get(fx.med.crocin)?.item.code).toBe("CROC500");
    expect(shelf.size).toBe(3);
  });

  it("with no stock on either, the code that sorts first", async () => {
    expect((await shelfByMedicine(db)).get(fx.med.crocin)?.item.code).toBe("CROC500");
    await stockIn(db, fx, { itemId: second, batchNo: "CR-X", qtyBase: 10 });
    expect((await shelfByMedicine(db)).get(fx.med.crocin)?.item.code).toBe("CROC500X");
  });

  it("the counter's search lists both items, each with its own stock, the better-stocked first", async () => {
    await stockIn(db, fx, { itemId: fx.item.crocin, batchNo: "CR-A", qtyBase: 380 });
    await stockIn(db, fx, { itemId: second, batchNo: "CR-X", qtyBase: 75 });
    const found = await searchShelfAt(db, fx.storeId, "crocin", MON);
    expect(found.map((f) => [f.medicineId, f.itemCode, f.available])).toEqual([
      [fx.med.crocin, "CROC500", 380],
      [fx.med.crocin, "CROC500X", 75],
    ]);
  });

  /*
    RE-WALK 2026-11-13 — the walk-in counter listed "10 available" above "40 available": the rows were in
    the hospital-wide order (`shelfItemsByMedicine`), and the counter sells only from its own store. A row
    is ordered by what THIS store can sell, best first, a tie to the code — across medicines too.
  */
  it("the counter's search orders rows by the stock at the store searched, not over every store; a tie goes to the code", async () => {
    const ward = (await withTx(db, (tx) => createStore(tx, HEAD, { code: "WARD-STORE", name: "Ward store" }))).resourceId;
    await stockIn(db, fx, { itemId: fx.item.crocin, batchNo: "CR-A", qtyBase: 10 });
    await stockIn(db, fx, { itemId: fx.item.crocin, batchNo: "CR-W", qtyBase: 330, resourceId: ward });
    await stockIn(db, fx, { itemId: second, batchNo: "CR-X", qtyBase: 40 });
    await stockIn(db, fx, { itemId: fx.item.calpol, batchNo: "CP-1", qtyBase: 60 });
    const found = await searchShelfAt(db, fx.storeId, "500", MON);
    expect(found.map((f) => [f.itemCode, f.available])).toEqual([["CALP500", 60], ["CROC500X", 40], ["CROC500", 10], ["AZEE500", 0]]);
    expect((await searchShelfAt(db, ward, "crocin", MON)).map((f) => [f.itemCode, f.available])).toEqual([["CROC500", 330], ["CROC500X", 0]]);
  });

  /*
    RE-WALK 2026-11-13 — "pantoprazole" did not find Pan 40 on the shelf: the salt was asked only when no
    item NAME matched, and a generic item called "Pantoprazole 40 mg tablet" matched. The answer is both:
    the items named so first, then every other item carrying the salt, each group by this store's stock.
  */
  it("a salt's name lists the items named so first, then the other brands carrying the salt — once each", async () => {
    const generic = await withTx(db, async (tx) => {
      const { itemId } = await registerItem(tx, HEAD, {
        code: "PCM500", name: "Paracetamol 500 tablet", class: "drug", baseUom: "tablet", batchTracked: true, formularyMedicineId: fx.med.crocin, gstRateBps: 1200,
        uoms: [{ uom: "strip", toBaseMultiplier: 10, isPurchaseUom: true, isIssueUom: true }],
      });
      await registerSaleItem(tx, fx.pharmacist.actor, itemId);
      return itemId;
    });
    await stockIn(db, fx, { itemId: generic, batchNo: "PC-1", qtyBase: 5 });
    await stockIn(db, fx, { itemId: fx.item.calpol, batchNo: "CP-1", qtyBase: 90 });
    const found = await searchShelfAt(db, fx.storeId, "paracetamol", MON);
    expect(found.map((f) => [f.itemCode, f.available])).toEqual([["PCM500", 5], ["CALP500", 90], ["CROC500", 0], ["CROC500X", 0]]);
  });

  it("a paper dispense sells the item the person chose, and the medicine's own item when none is named", async () => {
    await stockIn(db, fx, { itemId: fx.item.crocin, batchNo: "CR-A", qtyBase: 380 });
    await stockIn(db, fx, { itemId: second, batchNo: "CR-X", qtyBase: 75 });
    const chosen = { medicineId: fx.med.crocin, itemId: second, qtyBase: 10 };
    const plain = { medicineId: fx.med.crocin, qtyBase: 10 };
    const preview = await previewPaperDispense(db, fx.pharmacist.actor, { storeCode: "PHARM-OPD", occurredAt: MON, lines: [chosen, plain] }, MON2);
    expect(preview.lines.map((l) => l.itemId)).toEqual([second, fx.item.crocin]);
    const stranger = { medicineId: fx.med.crocin, itemId: fx.item.calpol, qtyBase: 10 };
    await expect(previewPaperDispense(db, fx.pharmacist.actor, { storeCode: "PHARM-OPD", occurredAt: MON, lines: [stranger] }, MON2))
      .rejects.toMatchObject({ code: "unknown_sale_item" });
  });

  it("a paper Rx keeps the item the pharmacist chose through verify, though another item holds more", async () => {
    await stockIn(db, fx, { itemId: fx.item.crocin, batchNo: "CR-A", qtyBase: 50 });
    await stockIn(db, fx, { itemId: second, batchNo: "CR-X", qtyBase: 80 });
    await openVisitWithoutRx(db, fx);
    const d = await enterPaperPrescription(db, testCfg, new FakeStore(), fx.pharmacist.actor, {
      patientId: fx.patient.id, rxDate: "2026-08-17", lines: [{ itemId: fx.item.crocin, qtyBase: 5 }],
    }, MON2);
    await verifyDispense(db, fx.pharmacist.actor, fx.decls, d.id, { lines: [{ lineIdx: 0, qtyBase: 5 }] }, MON2);
    const [l] = await db.select().from(pharmacyDispenseLines).where(eq(pharmacyDispenseLines.dispenseId, d.id));
    expect(l!.itemId).toBe(fx.item.crocin);
  });

  it("a doctor's Rx is claimed and verified on the item holding the stock, not the one that sorts last", async () => {
    await stockIn(db, fx, { itemId: fx.item.crocin, batchNo: "CR-A", qtyBase: 380 });
    const { issued } = await issueRx(db, fx, [line({ drug: "Crocin 500", medicineId: fx.med.crocin, frequency: "TDS", durationDays: 5 })]);
    const r = await findAtCounter(db, testCfg, fx.pharmacist.actor, issued.qrPayload, MON2);
    if (r.kind !== "dispense") throw new Error("no dispense");
    await claimDispense(db, fx.pharmacist.actor, { dispenseId: r.dispense.id, door: "rx_qr" }, MON2);
    const lineItem = async (): Promise<string | null> =>
      (await db.select().from(pharmacyDispenseLines).where(eq(pharmacyDispenseLines.dispenseId, r.dispense.id)))[0]!.itemId;
    expect(await lineItem()).toBe(fx.item.crocin);
    await verifyDispense(db, fx.pharmacist.actor, fx.decls, r.dispense.id, { lines: [{ lineIdx: 0, qtyBase: 15 }] }, MON2);
    expect(await lineItem()).toBe(fx.item.crocin);
  });

  it("an item not registered for sale does not shadow the one that is", async () => {
    await withTx(db, (tx) => registerItem(tx, HEAD, {
      code: "CROC500Z", name: "Crocin 500 store-only", class: "drug", baseUom: "tablet", batchTracked: true, formularyMedicineId: fx.med.crocin, gstRateBps: 1200,
      uoms: [{ uom: "strip", toBaseMultiplier: 10, isPurchaseUom: true, isIssueUom: true }],
    }));
    await stockIn(db, fx, { itemId: fx.item.crocin, batchNo: "CR-A", qtyBase: 380 });
    const { issued } = await issueRx(db, fx, [line({ drug: "Crocin 500", medicineId: fx.med.crocin, frequency: "TDS", durationDays: 5 })]);
    const r = await findAtCounter(db, testCfg, fx.pharmacist.actor, issued.qrPayload, MON2);
    if (r.kind !== "dispense") throw new Error("no dispense");
    await claimDispense(db, fx.pharmacist.actor, { dispenseId: r.dispense.id, door: "rx_qr" }, MON2);
    await verifyDispense(db, fx.pharmacist.actor, fx.decls, r.dispense.id, { lines: [{ lineIdx: 0, qtyBase: 15 }] }, MON2);
    const [l] = await db.select().from(pharmacyDispenseLines).where(eq(pharmacyDispenseLines.dispenseId, r.dispense.id));
    expect(l!.itemId).toBe(fx.item.crocin);
  });
});
