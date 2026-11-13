import { and, eq } from "drizzle-orm";
import { counterPackOf, newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { mkUser } from "../../../../test/helpers/opd";
import { seedPharmacyBase, stockIn } from "../../../../test/helpers/pharmacy";
import { approveRequest } from "../../../kernel/approvals/decisions";
import { grantPermissionToRole } from "../../../kernel/auth/permissions";
import { seedSodPairs } from "../../../kernel/auth/sod";
import { withTx } from "../../../kernel/db/client";
import { events, grnLines, stockBatches, supplierBills, supplierCreditNotes } from "../../../kernel/db/schema";
import {
  activateVendor, addVendorDocument, balances, billDraftFromGrn, cancelGrn, captureGrn, createPurchaseOrder, decidePurchaseOrder, getGrn,
  itemUomRows, listGrns, planPaymentRun, postGrn, recordStandaloneCredit, registerItem, registerMaterialsApprovalTypes, registerVendor,
  replaceItemUom, requestMrpRevisionApproval, runGateQc, stockValuationAt, submitPurchaseOrder, uomsByItems,
} from "../../materials";
import { counterPacks } from "../bill-rows";
import { captureOpeningStock, captureSupplierInvoice, planOpeningStock, readOpeningSheet } from "../opening-stock";
import { priceBatchSale } from "../price";
import type { PharmacyFixture } from "../../../../test/helpers/pharmacy";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../../kernel/db/client";

/**
 * ACCEPTANCE — issue #1047, spec docs/specs/1047-pharmacy-stock-in-go-live.md (owner APPROVED 2026-11-13,
 * "Both A and B"; ruling 0093). Real pharmacy stock goes in by a batch-wise recount into the stock-entry grid,
 * then every supplier delivery by GRN. D5 (the control file) and the desk half of D1 are the web's:
 * apps/web/src/screens/acceptance/stock-in-go-live-1047.test.tsx.
 *
 * Dates are read from the real clock (today's IST day, next year's August), never pinned.
 */
describe("pharmacy stock-in go-live (spec #1047)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: PharmacyFixture;
  let head: { id: string; actor: Actor };

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });
  beforeEach(async () => {
    await truncateAll(db);
    fx = await seedPharmacyBase(db);
    await seedSodPairs(db);
    await registerMaterialsApprovalTypes(db, { type: "user", id: "seed-materials" });
    for (const p of [
      "materials.items.manage", "materials.vendors.manage", "materials.grn.capture", "materials.grn.qc", "materials.po.raise", "materials.bills.manage",
    ]) await grantPermissionToRole(db, fx.registry, "pharmacy", p);
    head = await mkUser(db, "mat.head", ["materials_head"]);
  });
  afterEach(() => { fx.unregister(); });

  const today = (): string =>
    new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const nextYear = (): number => new Date().getUTCFullYear() + 1;

  /** The refusal's code, or undefined when it did not refuse. */
  async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
    try {
      await p;
      return undefined;
    } catch (e) {
      return (e as { code?: string }).code ?? String(e);
    }
  }

  async function aSupplier(code = "MEDPLUS"): Promise<string> {
    const { vendorId } = await withTx(db, (tx) => registerVendor(tx, fx.incharge.actor, { code, legalName: `${code} Distributors Pvt Ltd` }));
    await withTx(db, (tx) => addVendorDocument(tx, fx.incharge.actor, vendorId, { type: "gst_certificate", number: "g" }));
    await withTx(db, (tx) => addVendorDocument(tx, fx.incharge.actor, vendorId, { type: "pan", number: "p" }));
    await withTx(db, (tx) => activateVendor(tx, fx.incharge.actor, vendorId, new Date()));
    return vendorId;
  }

  async function heldOf(batchId: string): Promise<number> {
    return (await balances(db, { batchId })).reduce((n, b) => n + b.qtyOnHand, 0);
  }

  it("spec #1047 D1: an item with no stock has its strip10 pack replaced by strip15; refused while a batch uses strip10; desk and server pick one counter pack", async () => {
    const mk = async (code: string, uoms: { uom: string; toBaseMultiplier: number; isPurchaseUom?: boolean; isIssueUom?: boolean }[]): Promise<string> =>
      (await withTx(db, (tx) => registerItem(tx, fx.incharge.actor, {
        code, name: `${code} tablet`, class: "drug", baseUom: "tablet", batchTracked: true, formularyMedicineId: fx.med.crocin, gstRateBps: 1200, uoms,
      }))).itemId;
    const loaderDefault = [{ uom: "strip10", toBaseMultiplier: 10, isPurchaseUom: true, isIssueUom: true }];
    const fresh = await mk("FRESH650", loaderDefault);
    const stocked = await mk("STOCK650", loaderDefault);
    await stockIn(db, fx, { itemId: stocked, batchNo: "S1", mrpPaise: 3550, mrpUom: "strip10", qtyBase: 100 });

    // No stock: the pack is corrected in place, and the change is on the record, old → new.
    await withTx(db, (tx) => replaceItemUom(tx, fx.incharge.actor, fresh, { fromUom: "strip10", uom: "strip15", toBaseMultiplier: 15 }));
    expect((await itemUomRows(db, fresh)).map((u) => `${u.uom}×${String(u.toBaseMultiplier)}`).sort()).toEqual(["strip15×15", "tablet×1"]);
    const audit = await db.select({ payload: events.payload }).from(events).where(eq(events.name, "item.uom_replaced"));
    expect(audit).toHaveLength(1);
    expect(audit[0]!.payload).toMatchObject({
      itemId: fresh, from: { uom: "strip10", toBaseMultiplier: 10 }, to: { uom: "strip15", toBaseMultiplier: 15 },
    });

    // A batch is priced in the old pack: refused, and nothing changed.
    expect(await codeOf(withTx(db, (tx) => replaceItemUom(tx, fx.incharge.actor, stocked, { fromUom: "strip10", uom: "strip15", toBaseMultiplier: 15 }))))
      .toBe("pack_in_use");
    expect((await itemUomRows(db, stocked)).map((u) => u.uom).sort()).toEqual(["strip10", "tablet"]);

    // One counter-pack rule for server and desk: the issue pack — not the smallest (the old server) nor the largest (the old desk).
    const three = await mk("THREE650", [
      { uom: "strip10", toBaseMultiplier: 10, isPurchaseUom: true },
      { uom: "strip15", toBaseMultiplier: 15, isIssueUom: true },
      { uom: "box150", toBaseMultiplier: 150 },
    ]);
    expect((await counterPacks(db, [three])).get(three)?.uom).toBe("strip15");
    expect(counterPackOf((await uomsByItems(db, [three])).get(three) ?? [])?.uom).toBe("strip15");
  });

  it("spec #1047 D2: a captured GRN is cancelled with a reason before posting and stops counting against its PO", async () => {
    const vendorId = await aSupplier();
    const po = await createPurchaseOrder(db, fx.pharmacist.actor, {
      vendorId, storeResourceId: fx.storeId, lines: [{ itemId: fx.item.crocin, qtyPacks: 10, ratePaise: 8000 }],
    });
    await submitPurchaseOrder(db, fx.pharmacist.actor, po.id);
    await decidePurchaseOrder(db, head.actor, po.id, "approve", "ok");
    const delivery = (challanNo: string): Promise<{ grnId: string; grnNo: string }> => withTx(db, (tx) => captureGrn(tx, fx.incharge.actor, {
      vendorId, source: "challan", storeResourceId: fx.storeId, challanNo, challanDate: today(), purchaseOrderId: po.id, now: new Date(),
      lines: [{
        itemId: fx.item.crocin, uom: "strip", qtyInUom: 10, batchNo: "PO1", expiryDate: `${String(nextYear())}-08-31`,
        mrpPaise: 12_000, mrpUom: "strip", unitCostPaise: 800,
      }],
    }));

    const first = await delivery("CH/1");
    // The whole order is captured once: a second full delivery is over the order.
    expect(await codeOf(delivery("CH/2"))).toBe("po_over_receipt");

    // A reason is required, then the captured GRN is cancelled and on the record.
    expect(await codeOf(withTx(db, (tx) => cancelGrn(tx, fx.incharge.actor, first.grnId, "  ", new Date())))).toBe("reason_required");
    await withTx(db, (tx) => cancelGrn(tx, fx.incharge.actor, first.grnId, "typed against the wrong challan", new Date()));
    const cancelled = await getGrn(db, first.grnId);
    expect(cancelled?.status).toBe("cancelled");
    expect(cancelled?.cancelReason).toBe("typed against the wrong challan");
    expect(await db.select({ seq: events.seq }).from(events).where(eq(events.name, "grn.cancelled"))).toHaveLength(1);

    // Out of the QC worklist, and never posted.
    expect((await listGrns(db, { status: "gate_qc" })).map((g) => g.id)).not.toContain(first.grnId);
    expect(await codeOf(withTx(db, (tx) => postGrn(tx, fx.pharmacist.actor, first.grnId, new Date())))).toBe("grn_cancelled");

    // It no longer holds the order's headroom: the real delivery is captured, posted, and then cannot be cancelled.
    const second = await delivery("CH/2");
    await withTx(db, (tx) => runGateQc(tx, fx.pharmacist.actor, second.grnId));
    await withTx(db, (tx) => postGrn(tx, fx.pharmacist.actor, second.grnId, new Date()));
    expect((await getGrn(db, second.grnId))?.status).toBe("posted");
    expect(await codeOf(withTx(db, (tx) => cancelGrn(tx, fx.incharge.actor, second.grnId, "too late", new Date())))).toBe("already_received");
  });

  it("spec #1047 D3: a supplier invoice typed in the grid (invoice no. and date, MM/YY, a free pack, rate with GST) posts the right stock and cost, and the bill draft carries the invoice number and date", async () => {
    const vendorId = await aSupplier();
    const invoiceDate = today();
    const yy = String(nextYear()).slice(2);
    const done = await captureSupplierInvoice(
      db, fx.incharge.actor,
      { vendorId, invoiceNo: "SI/26/0451", invoiceDate, purchaseOrderId: null, storeResourceId: fx.storeId, rateIncludesGst: true },
      // Crocin: GST 12%, a strip of 10. ₹89.60 a strip with GST is ₹80.00 without it: 800 paise a tablet.
      [{ itemId: fx.item.crocin, batch: "INV1", expiry: `08/${yy}`, packSize: "10", packs: "5", freePacks: "1", mrpPerPack: "120.00", ratePerPack: "89.60", discountPct: "" }],
      new Date(),
    );

    const grn = await getGrn(db, done.grnId);
    expect(grn).toMatchObject({ vendorId, invoiceNo: "SI/26/0451", invoiceDate, storeResourceId: fx.storeId, status: "gate_qc" });
    const paid = grn!.lines.find((l) => !l.freeGoods)!;
    const free = grn!.lines.find((l) => l.freeGoods)!;
    expect([paid.qtyInUom, paid.qtyBase, paid.unitCostPaise, paid.expiryDate]).toEqual([5, 50, 800, `${String(nextYear())}-08-31`]);
    expect([free.qtyInUom, free.qtyBase, free.unitCostPaise]).toEqual([1, 10, 0]);

    await withTx(db, (tx) => runGateQc(tx, fx.pharmacist.actor, done.grnId));
    await withTx(db, (tx) => postGrn(tx, fx.pharmacist.actor, done.grnId, new Date()));
    const [batch] = await db.select().from(stockBatches).where(and(eq(stockBatches.itemId, fx.item.crocin), eq(stockBatches.batchNo, "INV1")));
    expect(batch?.landedCostPaise).toBe(800);
    expect(await heldOf(batch!.id)).toBe(60);

    const draft = await billDraftFromGrn(db, fx.incharge.actor, done.grnId);
    expect(draft.vendorBillNo).toBe("SI/26/0451");
    expect(draft.billDate).toBe(invoiceDate);
  });

  it("spec #1047 D4: a rate-difference credit note is recorded without a return and sets off in the next payment run", async () => {
    const vendorId = await aSupplier();
    const day = today();
    await db.insert(supplierBills).values({
      id: newId(), billNo: "MSB-1047-1", vendorId, vendorBillNo: "SI/1", vendorBillKey: "SI1", billDate: day, fy: "2026-27", status: "accepted",
      taxablePaise: 50_000, totalPaise: 50_000, expectedTotalPaise: 50_000, acceptedBy: fx.incharge.id, acceptedAt: new Date(), acceptanceDate: day,
      dueDate: day, createdBy: fx.incharge.id, updatedBy: fx.incharge.id,
    });

    const credit = await recordStandaloneCredit(db, fx.incharge.actor, {
      vendorId, kind: "rate_difference", vendorCreditNoteNo: "CN/RD/9", creditNoteDate: day, taxablePaise: 10_000, gstPaise: 1_200,
    }, new Date());
    expect(credit.amountPaise).toBe(11_200);
    const [row] = await db.select().from(supplierCreditNotes).where(eq(supplierCreditNotes.id, credit.creditNoteId));
    expect(row).toMatchObject({
      returnId: null, kind: "rate_difference", vendorId, amountPaise: 11_200, status: "accepted", vendorCreditNoteNo: "CN/RD/9",
    });

    const plan = await planPaymentRun(db, new Date());
    const mine = plan.groups.find((g) => g.vendorId === vendorId);
    expect(mine?.creditPaise).toBe(11_200);
    expect(mine?.bills[0]?.payablePaise).toBe(50_000 - 11_200);
  });

  it("spec #1047 D6: the same batch arriving at a new MRP waits for approval, then posts, and the batch sells at the new MRP", async () => {
    const vendorId = await aSupplier();
    const y = String(nextYear());
    const receive = (challanNo: string, mrpPaise: number, expiryDate: string): Promise<{ grnId: string; grnNo: string }> =>
      withTx(db, (tx) => captureGrn(tx, fx.incharge.actor, {
        vendorId, source: "challan", storeResourceId: fx.storeId, challanNo, challanDate: today(), now: new Date(),
        lines: [{ itemId: fx.item.crocin, uom: "strip", qtyInUom: 10, batchNo: "REV1", expiryDate, mrpPaise, mrpUom: "strip", unitCostPaise: 800 }],
      }));
    const batchRow = async (): Promise<typeof stockBatches.$inferSelect> =>
      (await db.select().from(stockBatches).where(and(eq(stockBatches.itemId, fx.item.crocin), eq(stockBatches.batchNo, "REV1"))))[0]!;

    const old = await receive("CH/OLD", 12_000, `${y}-08-31`);
    await withTx(db, (tx) => runGateQc(tx, fx.pharmacist.actor, old.grnId));
    await withTx(db, (tx) => postGrn(tx, fx.pharmacist.actor, old.grnId, new Date()));
    expect((await batchRow()).mrpPaise).toBe(12_000);

    // The same batch and expiry month at a new MRP: held at QC as mrp_revised, not refused.
    const revised = await receive("CH/NEW", 12_600, `${y}-08-15`);
    const qc = await withTx(db, (tx) => runGateQc(tx, fx.pharmacist.actor, revised.grnId));
    expect(qc.status).toBe("accepted");
    expect(qc.verdicts.map((v) => v.verdict)).toEqual(["mrp_revised"]);
    expect(await codeOf(withTx(db, (tx) => postGrn(tx, fx.pharmacist.actor, revised.grnId, new Date())))).toBe("mrp_revision_unapproved");

    // Asked, still pending: still waits. Granted by the materials head: posts.
    const { approvalId } = await withTx(db, (tx) => requestMrpRevisionApproval(tx, fx.pharmacist.actor, revised.grnId, "the maker's new price list"));
    expect(await codeOf(withTx(db, (tx) => postGrn(tx, fx.pharmacist.actor, revised.grnId, new Date())))).toBe("mrp_revision_unapproved");
    expect((await batchRow()).mrpPaise).toBe(12_000);
    await approveRequest(db, head.actor, { approvalId, note: "seen the price list" });
    await withTx(db, (tx) => postGrn(tx, fx.pharmacist.actor, revised.grnId, new Date()));

    const after = await batchRow();
    expect([after.mrpPaise, after.mrpUom]).toEqual([12_600, "strip"]);
    expect(await heldOf(after.id)).toBe(200);
    const audit = await db.select({ payload: events.payload }).from(events).where(eq(events.name, "batch.mrp_revised"));
    expect(audit).toHaveLength(1);
    expect(audit[0]!.payload).toMatchObject({ batchId: after.id, from: { mrpPaise: 12_000, mrpUom: "strip" }, to: { mrpPaise: 12_600, mrpUom: "strip" } });
    // It sells at the new MRP: a full strip is ₹126.00.
    const uoms = await itemUomRows(db, fx.item.crocin);
    expect(priceBatchSale({ uoms, batch: { mrpPaise: after.mrpPaise, mrpUom: after.mrpUom }, regulation: null, taxRateBps: 1200 }, 10).amountPaise).toBe(12_600);

    // A different expiry month is still a mismatch, refused at post.
    const wrong = await receive("CH/WRONG", 12_600, `${y}-09-30`);
    await withTx(db, (tx) => runGateQc(tx, fx.pharmacist.actor, wrong.grnId));
    expect(await codeOf(withTx(db, (tx) => postGrn(tx, fx.pharmacist.actor, wrong.grnId, new Date())))).toBe("batch_mismatch");
  });

  it("spec #1047 D7: an opening-stock row with no rate is valued at MRP without GST less 20% and shows as estimated", async () => {
    const exp = `08/${String(nextYear())}`;
    // Crocin and Calpol: GST 12%, a strip of 10. ₹112.00 with GST is ₹100.00 without it; less 20% is ₹80.00 a strip.
    const text = `brand,batch,expiry,mrp_per_pack,pack_size,packs,purchase_rate_per_pack\nCrocin 500,EST1,${exp},112.00,10,5,\nCalpol 500,ZERO1,${exp},112.00,10,3,0\n`;
    const plan = await planOpeningStock(db, readOpeningSheet(text), text, new Date());
    expect(plan.rows.flatMap((r) => r.reasons)).toEqual([]);
    expect(plan.rows.map((r) => [r.costPerBasePaise, r.estimatedCost])).toEqual([[800, true], [0, false]]);

    const done = await captureOpeningStock(db, fx.incharge.actor, plan, new Date());
    for (const g of done.captured) {
      await withTx(db, (tx) => runGateQc(tx, fx.pharmacist.actor, g.grnId));
      await withTx(db, (tx) => postGrn(tx, fx.pharmacist.actor, g.grnId, new Date()));
    }
    const [line] = await db.select().from(grnLines).where(eq(grnLines.batchNo, "EST1"));
    expect([line?.unitCostPaise, line?.estimatedCost]).toEqual([800, true]);
    const batches = await db.select().from(stockBatches);
    const est = batches.find((b) => b.batchNo === "EST1")!;
    const zero = batches.find((b) => b.batchNo === "ZERO1")!;
    expect([est.landedCostPaise, est.estimatedCost]).toEqual([800, true]);
    expect([zero.landedCostPaise, zero.estimatedCost]).toEqual([0, false]);

    // The valuation shows the estimate apart from what is known.
    const v = await stockValuationAt(db, today());
    expect(v.rows.find((r) => r.batchNo === "EST1")?.estimatedCost).toBe(true);
    expect(v.rows.find((r) => r.batchNo === "ZERO1")?.estimatedCost).toBe(false);
    expect(v.totals.costValuePaise).toBe(50 * 800);
    expect(v.totals.estimatedCostValuePaise).toBe(50 * 800);
    expect(v.totals.knownCostValuePaise).toBe(0);
  });
});
