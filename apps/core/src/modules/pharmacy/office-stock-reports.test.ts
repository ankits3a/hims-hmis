import { and, eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { ensureRole, mkUser } from "../../../test/helpers/opd";
import { approveRequest } from "../../kernel/approvals/decisions";
import { grantPermissionToRole, syncPermissions } from "../../kernel/auth/permissions";
import { seedSodPairs } from "../../kernel/auth/sod";
import { withTx } from "../../kernel/db/client";
import { itemStockLevels, items, pharmacyShelfLocations, stockBalances, stockBatches } from "../../kernel/db/schema";
import { ModuleRegistry } from "../../kernel/modules/loader";
import { ALL_MANIFESTS } from "../../kernel/modules/manifests";
import {
  activateVendor, addVendorDocument, approveSupplierReturn, captureGrn, countSheet, createStore, createSupplierReturn, dispatchSupplierReturn,
  getCount, postAdjustments, postGrn, postMovement, postWriteOff, raiseWriteOff, registerItem, registerMaterialsApprovalTypes, registerVendor,
  requestCountAdjustment, runGateQc, scheduleCount, submitCount,
} from "../materials";
import { dailyStock, itemCatalogueReport, lossRegister } from "./office-stock-reports";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ PHARMACY GAP CLOSURE, STAGE C — DAILY STOCK, THE LOSS-BOOKING REGISTER, THE ITEM CATALOGUE ═══
 *
 * One store, one drug, three days, every kind of movement the ledger knows, each made by the real act:
 *   - 24 Sep: a GRN of 100 tablets;
 *   - 25 Sep: 7 sold, 10 issued to the ward store, 2 brought back by a patient, 20 returned to the
 *     supplier (debit note), 5 destroyed as damaged (write-off, granted by the medical superintendent);
 *   - 26 Sep: a count finds 4 short, written off as shrinkage (granted by the medical superintendent).
 * Then: daily stock closes (opening + in − out = closing) and its closing IS `stock_balances`; the loss
 * register lists the write-off and the shrinkage with who approved each, totalled by reason; the
 * catalogue carries the item master, its packs, the store's levels and its rack.
 */
const T0 = new Date("2026-09-24T04:30:00.000Z"); // 10:00 IST, 24 Sep 2026
const istAt = (day: string, hhmm: string): Date => new Date(Date.parse(`${day}T${hhmm}:00.000Z`) - 330 * 60_000);

describe("stage C: daily stock, the loss-booking register, the item catalogue", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let head: { id: string; actor: Actor };
  let pharmacist: { id: string; actor: Actor };
  let keeper: { id: string; actor: Actor };
  let owner: { id: string; actor: Actor };
  let ms: { id: string; actor: Actor };
  let incharge: { id: string; actor: Actor };
  let store: string;
  let ward: string;
  let vendor: string;
  let croc: string;
  let slow: string;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    const registry = new ModuleRegistry();
    for (const m of ALL_MANIFESTS) registry.install(m);
    await syncPermissions(db, registry);
    await seedSodPairs(db);
    await registerMaterialsApprovalTypes(db, { type: "user", id: "seed-materials" });
    for (const role of ["materials_head", "pharmacy", "storekeeper", "owner", "medical_superintendent", "pharmacy_incharge"]) await ensureRole(db, role);
    const grants: Record<string, string[]> = {
      materials_head: [
        "materials.stock.read", "materials.grn.capture", "materials.grn.qc", "materials.items.manage", "materials.returns.manage", "materials.returns.approve",
        "materials.counts.manage",
      ],
      pharmacy: ["materials.stock.read", "materials.grn.qc", "materials.returns.manage"],
      storekeeper: ["materials.stock.read", "materials.grn.capture", "materials.counts.perform"],
      owner: ["pharmacy.reports.read"],
      medical_superintendent: ["approvals.requests.decide", "approvals.requests.read"],
      pharmacy_incharge: ["materials.writeoffs.manage", "materials.stock.read"],
    };
    for (const [role, perms] of Object.entries(grants)) for (const p of perms) await grantPermissionToRole(db, registry, role, p);
    head = await mkUser(db, "mat.head", ["materials_head"]);
    pharmacist = await mkUser(db, "pharm.one", ["pharmacy"]);
    keeper = await mkUser(db, "store.keeper", ["storekeeper"]);
    owner = await mkUser(db, "the.owner", ["owner"]);
    ms = await mkUser(db, "the.ms", ["medical_superintendent"]);
    incharge = await mkUser(db, "ph.incharge", ["pharmacy_incharge"]);
    ({ resourceId: store } = await withTx(db, (tx) => createStore(tx, head.actor, { code: "PHARM-OPD", name: "OPD pharmacy" })));
    ({ resourceId: ward } = await withTx(db, (tx) => createStore(tx, head.actor, { code: "WARD-3", name: "Ward 3 store" })));
    const { vendorId } = await withTx(db, (tx) => registerVendor(tx, head.actor, { code: "ACME", legalName: "ACME Pharma Pvt Ltd", gstin: "27AAACA1234A1Z5" }));
    await withTx(db, (tx) => addVendorDocument(tx, head.actor, vendorId, { type: "gst_certificate", number: "g" }));
    await withTx(db, (tx) => addVendorDocument(tx, head.actor, vendorId, { type: "pan", number: "p" }));
    await withTx(db, (tx) => activateVendor(tx, head.actor, vendorId, T0));
    vendor = vendorId;
    croc = await anItem("CROC", "Crocin 500");
    slow = await anItem("SLOW", "Slowmove 10");
  });

  async function anItem(code: string, name: string): Promise<string> {
    const { itemId } = await withTx(db, (tx) => registerItem(tx, head.actor, {
      code, name, class: "consumable", baseUom: "tablet", batchTracked: true, gstRateBps: 1200, hsnCode: "30049099",
      uoms: [{ uom: "strip", toBaseMultiplier: 10, isPurchaseUom: true }, { uom: "box", toBaseMultiplier: 100 }],
    }));
    return itemId;
  }

  /** A posted GRN of `strips` strips at ₹25 a strip (₹2.50 a tablet). */
  async function received(itemId: string, strips: number, batchNo: string, postAt: Date): Promise<string> {
    const { grnId } = await withTx(db, (tx) => captureGrn(tx, keeper.actor, {
      vendorId: vendor, source: "challan", storeResourceId: store, challanNo: `CH-${batchNo}`, challanDate: new Date(postAt.getTime() + 330 * 60_000).toISOString().slice(0, 10), invoiceNo: `INV-${batchNo}`,
      lines: [{ itemId, uom: "strip", qtyInUom: strips, batchNo, expiryDate: "2028-06-30", unitCostPaise: 250 }],
      now: new Date(postAt.getTime() - 10 * 60_000),
    }));
    await withTx(db, (tx) => runGateQc(tx, pharmacist.actor, grnId));
    await withTx(db, (tx) => postGrn(tx, pharmacist.actor, grnId, postAt));
    const [batch] = await db.select().from(stockBatches).where(and(eq(stockBatches.itemId, itemId), eq(stockBatches.batchNo, batchNo)));
    return batch!.id;
  }

  /** The three days. Returns the write-off's number. */
  async function threeDays(): Promise<{ batchId: string; writeOffNo: string }> {
    const batchId = await received(croc, 10, "CR-1", T0);
    const move = (resourceId: string, qtyDelta: number, reason: "consume" | "issue" | "receive" | "return", occurredAt: Date) =>
      withTx(db, (tx) => postMovement(tx, head.actor, { resourceId, batchId, qtyDelta, reason, refType: "test", refId: `${reason}-${String(qtyDelta)}`, occurredAt }));
    await move(store, -7, "consume", istAt("2026-09-25", "09:00"));
    await move(store, -10, "issue", istAt("2026-09-25", "10:00"));
    await move(ward, 10, "receive", istAt("2026-09-25", "10:05"));
    await move(store, 2, "return", istAt("2026-09-25", "11:00"));
    const r = await createSupplierReturn(db, pharmacist.actor, { vendorId: vendor, lines: [{ batchId, storeResourceId: store, qtyBase: 20, reason: "damaged" }] }, { now: istAt("2026-09-25", "12:00") });
    await approveSupplierReturn(db, head.actor, r.id, istAt("2026-09-25", "12:05"));
    await dispatchSupplierReturn(db, pharmacist.actor, r.id, istAt("2026-09-25", "12:10"));
    const w = await raiseWriteOff(db, incharge.actor, { storeResourceId: store, reason: "damage", lines: [{ batchId, qtyBase: 5 }], note: "crushed carton" }, istAt("2026-09-25", "13:00"));
    await approveRequest(db, ms.actor, { approvalId: w.approvalId, note: "condemned" });
    await postWriteOff(db, incharge.actor, w.id, { disposalAgency: "BioCare CBWTF", manifestNo: "M-77", disposalDate: "2026-09-25" }, istAt("2026-09-25", "14:00"));
    // 26 Sep: the count finds 56 on the shelf; the books say 60.
    const count = await scheduleCount(db, head.actor, { storeResourceId: store }, istAt("2026-09-26", "09:00"));
    const sheet = await countSheet(db, keeper.actor, count.id);
    await submitCount(db, keeper.actor, count.id, { countedAt: istAt("2026-09-26", "09:30").toISOString(), lines: sheet.lines.map((l) => ({ lineId: l.lineId, countedQty: 56 })) }, istAt("2026-09-26", "09:35"));
    const review = await getCount(db, head.actor, count.id);
    const req = await requestCountAdjustment(db, head.actor, count.id, { lines: [{ lineId: review.lines[0]!.lineId, reasonCode: "shrinkage" }], note: "four tablets unaccounted" }, istAt("2026-09-26", "10:00"));
    await approveRequest(db, ms.actor, { approvalId: req.approvalId, note: "write off" });
    await postAdjustments(db, head.actor, req.approvalId, istAt("2026-09-26", "11:00"));
    return { batchId, writeOffNo: w.writeOffNo };
  }

  it("daily stock: opening + in − out = closing for every row, the closing is stock_balances, and each movement is counted in its own column", async () => {
    await threeDays();
    const now = istAt("2026-09-27", "10:00");
    const r = await dailyStock(db, owner.actor, { preset: "custom", from: "2026-09-25", to: "2026-09-26", storeCode: "pharm-opd" }, now);
    expect(r.rows.map((x) => x.itemCode)).toEqual(["CROC"]);
    const row = r.rows[0]!;
    expect(row).toMatchObject({
      openingQty: 100,
      in: { grn: 0, transferIn: 0, saleReturn: 2, adjustIn: 0 }, inQty: 2,
      out: { sale: 7, transferOut: 10, supplierReturn: 20, writeOff: 9 }, outQty: 46,
      closingQty: 56,
    });
    // The report's closing is summed from the ledger on its own; the identity is checked, not assumed.
    for (const x of r.rows) expect(x.openingQty + x.inQty - x.outQty).toBe(x.closingQty);
    const [bal] = await db.select().from(stockBalances).where(and(eq(stockBalances.resourceId, store), eq(stockBalances.itemId, croc)));
    expect(row.closingQty).toBe(bal!.qtyOnHand);
    expect(r.totals).toMatchObject({ items: 1, openingQty: 100, inQty: 2, outQty: 46, closingQty: 56 });

    // The first day alone: the GRN is the day's in, and nothing was there before it.
    const first = await dailyStock(db, owner.actor, { preset: "custom", from: "2026-09-24", to: "2026-09-24", storeCode: "PHARM-OPD" }, now);
    expect(first.rows[0]).toMatchObject({ openingQty: 0, in: { grn: 100 }, inQty: 100, outQty: 0, closingQty: 100 });
    // Every store: the transfer is out of one and into the other; the hospital's closing is every balance.
    const all = await dailyStock(db, owner.actor, { preset: "custom", from: "2026-09-24", to: "2026-09-26" }, now);
    expect(all.rows[0]).toMatchObject({ openingQty: 0, in: { grn: 100, transferIn: 10 }, out: { transferOut: 10 }, closingQty: 66 });
    const balances = await db.select().from(stockBalances).where(eq(stockBalances.itemId, croc));
    expect(all.rows[0]!.closingQty).toBe(balances.reduce((s, b) => s + b.qtyOnHand, 0));
    // A day before anything happened: no rows.
    expect((await dailyStock(db, owner.actor, { preset: "custom", from: "2026-09-20", to: "2026-09-20" }, now)).rows).toEqual([]);

    await expect(dailyStock(db, pharmacist.actor, { preset: "today" }, now)).rejects.toMatchObject({ code: "permission_denied" });
    await expect(dailyStock(db, owner.actor, { preset: "today", storeCode: "NOPE" }, now)).rejects.toMatchObject({ code: "store_missing" });
  });

  it("the loss register lists the destruction write-off and the count's shrinkage, each with who approved it, totalled by reason", async () => {
    const { writeOffNo } = await threeDays();
    const now = istAt("2026-09-27", "10:00");
    const r = await lossRegister(db, owner.actor, { preset: "custom", from: "2026-09-24", to: "2026-09-27" }, now);
    expect(r.rows.map((x) => [x.date, x.source, x.docNo, x.itemCode, x.batchNo, x.qtyBase, x.valuePaise, x.reason, x.approvedBy])).toEqual([
      ["2026-09-25", "write_off", writeOffNo, "CROC", "CR-1", 5, 5 * 250, "damage", "the.ms"],
      ["2026-09-26", "count", null, "CROC", "CR-1", 4, 4 * 250, "shrinkage", "the.ms"],
    ]);
    expect(r.rows[0]).toMatchObject({ disposalAgency: "BioCare CBWTF", manifestNo: "M-77", requestedBy: "ph.incharge", postedBy: "ph.incharge", storeCode: "PHARM-OPD" });
    expect(r.byReason).toEqual([
      { reason: "damage", lines: 1, qtyBase: 5, valuePaise: 1_250 },
      { reason: "shrinkage", lines: 1, qtyBase: 4, valuePaise: 1_000 },
    ]);
    expect(r.totals).toEqual({ lines: 2, qtyBase: 9, valuePaise: 2_250 });
    // A range is by the day the loss was POSTED.
    const d26 = await lossRegister(db, owner.actor, { preset: "custom", from: "2026-09-26", to: "2026-09-26" }, now);
    expect(d26.rows.map((x) => x.reason)).toEqual(["shrinkage"]);
    // The other store lost nothing.
    expect((await lossRegister(db, owner.actor, { preset: "custom", from: "2026-09-24", to: "2026-09-27", storeCode: "WARD-3" }, now)).rows).toEqual([]);
    await expect(lossRegister(db, pharmacist.actor, { preset: "today" }, now)).rejects.toMatchObject({ code: "permission_denied" });
  });

  it("the item catalogue: every active item with its master facts, its packs, the store's levels and its rack", async () => {
    await db.update(items).set({ lasa: true, manufacturer: "GSK", leadTimeDays: 3, storageClass: "cold_2_8" }).where(eq(items.id, croc));
    await db.insert(itemStockLevels).values({ id: newId(), itemId: croc, storeResourceId: store, minBase: 20, reorderBase: 50, maxBase: 200, updatedBy: head.id });
    await db.insert(itemStockLevels).values({ id: newId(), itemId: croc, storeResourceId: ward, minBase: 5, reorderBase: 10, maxBase: 40, updatedBy: head.id });
    await db.insert(pharmacyShelfLocations).values({ id: newId(), storeResourceId: store, itemId: croc, location: "R-12", setBy: head.id });
    // A deactivated item is not in the catalogue.
    const gone = await anItem("GONE", "Discontinued 5");
    await db.update(items).set({ active: false }).where(eq(items.id, gone));

    const all = await itemCatalogueReport(db, owner.actor, {});
    expect(all.rows.map((r) => r.code)).toEqual(["CROC", "SLOW"]);
    expect(all.rows[0]).toMatchObject({
      name: "Crocin 500", class: "consumable", hsnCode: "30049099", gstRateBps: 1200, baseUom: "tablet", storageClass: "cold_2_8", manufacturer: "GSK",
      leadTimeDays: 3, lasa: true, highAlert: false, schedule: null,
      packs: [{ uom: "strip", toBase: 10 }, { uom: "box", toBase: 100 }],
      racks: [{ storeCode: "PHARM-OPD", location: "R-12" }],
    });
    expect(all.rows[0]!.levels.map((l) => [l.storeCode, l.minBase, l.reorderBase, l.maxBase])).toEqual([["PHARM-OPD", 20, 50, 200], ["WARD-3", 5, 10, 40]]);
    const ward3 = await itemCatalogueReport(db, owner.actor, { storeCode: "WARD-3" });
    expect(ward3.rows[0]).toMatchObject({ racks: [], levels: [{ storeCode: "WARD-3", minBase: 5, reorderBase: 10, maxBase: 40 }] });
    expect(ward3.rows[1]).toMatchObject({ code: "SLOW", levels: [], racks: [] });
    void slow;
    await expect(itemCatalogueReport(db, pharmacist.actor, {})).rejects.toMatchObject({ code: "permission_denied" });
  });
});
