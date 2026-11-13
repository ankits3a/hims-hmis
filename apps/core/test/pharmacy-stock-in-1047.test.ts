import { and, eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { grantPermissionToRole } from "../src/kernel/auth/permissions";
import { withTx } from "../src/kernel/db/client";
import { grns, itemBarcodes, stockBatches, supplierBills, supplierCreditNotes } from "../src/kernel/db/schema";
import {
  activateVendor, addBarcode, addVendorDocument, billDraftFromGrn, cancelGrn, cancelStandaloneCredit, captureGrn, createPurchaseOrder,
  effectiveRegulation, getGrn, grnReceivedTotals, itemUomRows, lastPurchaseByItem, listStandaloneCredits, postGrn, purchaseRegister,
  recordStandaloneCredit, registerItem, registerVendor, replaceItemUom, runGateQc, setPriceRegulation, supplierLedger, unbilledGrns, vendorCredits,
} from "../src/modules/materials";
import {
  captureOpeningStock, captureSupplierInvoice, estimatedPackCostPaise, invoiceStores, planOpeningGrid, planSupplierInvoice, rateWithoutGstPaise,
} from "../src/modules/pharmacy/opening-stock";
import { grnWorklist } from "../src/modules/materials/grn";
import { stockEntrySuppliers } from "../src/modules/pharmacy/stock-drug";
import { setupTestDb, truncateAll } from "./helpers/db";
import { seedPharmacyBase } from "./helpers/pharmacy";
import type { InvoiceHeader, OpeningGridRow } from "../src/modules/pharmacy/opening-stock";
import type { PharmacyFixture } from "./helpers/pharmacy";
import type { Db } from "../src/kernel/db/client";

/**
 * #1047 — the pharmacy stock-in go-live, beyond its locked acceptance checks
 * (`src/modules/pharmacy/acceptance/stock-in-go-live-1047.test.ts`): the opening count is a SOURCE, the
 * invoice grid's header rules, the standalone credit's edges, and what moves with a corrected pack.
 */
describe("#1047 pharmacy stock-in — sources, the invoice header, credits and pack corrections", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: PharmacyFixture;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });
  beforeEach(async () => {
    await truncateAll(db);
    fx = await seedPharmacyBase(db);
    for (const p of ["materials.items.manage", "materials.vendors.manage", "materials.bills.manage", "materials.po.raise", "materials.stock.read"]) {
      await grantPermissionToRole(db, fx.registry, "pharmacy", p);
    }
  });
  afterEach(() => { fx.unregister(); });

  const today = (): string =>
    new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const yy = (): string => String(new Date().getUTCFullYear() + 1).slice(2);
  async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
    try { await p; return undefined; } catch (e) { return (e as { code?: string }).code ?? String(e); }
  }
  async function aSupplier(code = "MEDPLUS"): Promise<string> {
    const { vendorId } = await withTx(db, (tx) => registerVendor(tx, fx.incharge.actor, { code, legalName: `${code} Distributors Pvt Ltd`, tradeName: code }));
    await withTx(db, (tx) => addVendorDocument(tx, fx.incharge.actor, vendorId, { type: "gst_certificate", number: "g" }));
    await withTx(db, (tx) => addVendorDocument(tx, fx.incharge.actor, vendorId, { type: "pan", number: "p" }));
    await withTx(db, (tx) => activateVendor(tx, fx.incharge.actor, vendorId, new Date()));
    return vendorId;
  }
  const gridRow = (over: Partial<OpeningGridRow> = {}): OpeningGridRow => ({
    itemId: fx.item.crocin, batch: "S1", expiry: `08/${yy()}`, mrpPerPack: "120.00", packSize: "10", packs: "5",
    ratePerPack: "80.00", discountPct: "", freePacks: "", packType: "tablet_strip", rack: "", supplier: "", ...over,
  });
  async function qcAndPost(grnId: string): Promise<void> {
    await withTx(db, (tx) => runGateQc(tx, fx.pharmacist.actor, grnId));
    await withTx(db, (tx) => postGrn(tx, fx.pharmacist.actor, grnId, new Date()));
  }

  it("the two sums, in integers: the estimate (MRP without GST less 20%) and a rate typed with GST, both rounded down", () => {
    expect(estimatedPackCostPaise(11_200, 1200)).toBe(8000);
    expect(estimatedPackCostPaise(3550, 1200)).toBe(2535); // 3550 ÷ 1.12 × 0.8 = 2535.71
    expect(estimatedPackCostPaise(1000, null)).toBe(800); // no GST slab: taken at 0%, as the counter sells it
    expect(rateWithoutGstPaise(8960, 1200)).toBe(8000);
    expect(rateWithoutGstPaise(10_000, 500)).toBe(9523); // 9523.8
  });

  it("opening stock is a SOURCE: a row naming a real supplier stays out of the last purchase, the bills to match, billing and the purchases metric", async () => {
    const vendorId = await aSupplier();
    const plan = await planOpeningGrid(db, [gridRow({ supplier: "MEDPLUS" })], new Date());
    expect(plan.rows[0]!.reasons).toEqual([]);
    const done = await captureOpeningStock(db, fx.incharge.actor, plan, new Date());
    const grnId = done.captured[0]!.grnId;
    expect((await getGrn(db, grnId))).toMatchObject({ vendorId, source: "opening_stock" });
    await qcAndPost(grnId);

    expect((await lastPurchaseByItem(db, [fx.item.crocin])).has(fx.item.crocin)).toBe(false);
    expect((await unbilledGrns(db, fx.incharge.actor)).map((g) => g.grnId)).not.toContain(grnId);
    await expect(billDraftFromGrn(db, fx.incharge.actor, grnId)).rejects.toMatchObject({ code: "bill_invalid" });
    const day = new Date(`${today()}T00:00:00+05:30`);
    const range = [day, new Date(day.getTime() + 86_400_000)] as const;
    expect(await grnReceivedTotals(db, ...range)).toEqual({ grns: 0, valuePaise: 0 });

    // A real delivery from the same supplier IS a purchase, and is counted.
    const inv = await captureSupplierInvoice(db, fx.incharge.actor, {
      vendorId, invoiceNo: "SI/1", invoiceDate: today(), storeResourceId: fx.storeId,
    }, [gridRow({ batch: "S2" })], new Date());
    await qcAndPost(inv.grnId);
    expect(await grnReceivedTotals(db, ...range)).toEqual({ grns: 1, valuePaise: 50 * 800 });
    expect((await lastPurchaseByItem(db, [fx.item.crocin])).get(fx.item.crocin)?.vendorId).toBe(vendorId);
  });

  it("the grid names only real suppliers; the hospital's own OPENING STOCK vendor is picked by leaving it blank", async () => {
    await aSupplier();
    const done = await captureOpeningStock(db, fx.incharge.actor, await planOpeningGrid(db, [gridRow()], new Date()), new Date());
    expect(done.vendorCreated).toBe(true);
    expect((await stockEntrySuppliers(db)).map((s) => s.code)).toEqual(["MEDPLUS"]);
    const named = await planOpeningGrid(db, [gridRow({ batch: "S9", supplier: "OPENING-STOCK" })], new Date());
    expect(named.rows[0]!.reasons.join()).toMatch(/not an active vendor/);
  });

  it("a cancelled opening capture is off the books: the same sheet captures again", async () => {
    const rows = [gridRow()];
    const first = await captureOpeningStock(db, fx.incharge.actor, await planOpeningGrid(db, rows, new Date()), new Date());
    await withTx(db, (tx) => cancelGrn(tx, fx.incharge.actor, first.captured[0]!.grnId, "counted the wrong shelf", new Date()));
    const again = await planOpeningGrid(db, rows, new Date());
    expect(again.grns.map((g) => g.state)).toEqual(["new"]);
    const second = await captureOpeningStock(db, fx.incharge.actor, again, new Date());
    expect(second.captured).toHaveLength(1);
    expect(second.captured[0]!.grnId).not.toBe(first.captured[0]!.grnId);
    // A cancelled GRN takes no QC either.
    await expect(withTx(db, (tx) => runGateQc(tx, fx.pharmacist.actor, first.captured[0]!.grnId))).rejects.toMatchObject({ code: "grn_cancelled" });
  });

  it("the invoice's header: a supplier, the number and date, an invoice store — and the same invoice twice is refused", async () => {
    const vendorId = await aSupplier();
    const header: InvoiceHeader = { vendorId, invoiceNo: "INV-26/77", invoiceDate: today(), storeResourceId: fx.storeId };
    const blank = await planSupplierInvoice(db, { vendorId: null, invoiceNo: " ", invoiceDate: "", storeResourceId: null }, [gridRow()], new Date());
    expect(blank.headerReasons).toEqual([
      "choose the supplier", "the supplier's invoice number is required (at most 64 characters)", "the invoice date is required",
      "choose the store it is received into",
    ]);
    const future = await planSupplierInvoice(db, { ...header, invoiceDate: "2999-01-01" }, [gridRow()], new Date());
    expect(future.headerReasons.join()).toMatch(/after today/);
    const ndps = await planSupplierInvoice(db, { ...header, storeResourceId: newId() }, [gridRow()], new Date());
    expect(ndps.headerReasons.join()).toMatch(/PHARM-OPD or PHARM-RETAIL/);
    expect((await invoiceStores(db)).map((s) => s.code)).toEqual(["PHARM-OPD"]);

    // A paid row needs its rate; a free-only row does not.
    const noRate = await planSupplierInvoice(db, header, [gridRow({ ratePerPack: "" }), gridRow({ batch: "F1", packs: "", freePacks: "2", ratePerPack: "" })], new Date());
    expect(noRate.rows.map((r) => r.reasons.length)).toEqual([1, 0]);
    await expect(captureSupplierInvoice(db, fx.incharge.actor, header, [gridRow({ ratePerPack: "" })], new Date())).rejects.toMatchObject({ code: "invoice_refused" });

    const ok = await captureSupplierInvoice(db, fx.incharge.actor, header, [gridRow()], new Date());
    expect(await codeOf(captureSupplierInvoice(db, fx.incharge.actor, { ...header, invoiceNo: "inv 26 77" }, [gridRow({ batch: "S3" })], new Date())))
      .toBe("invoice_already_captured");
    // Cancelled, the invoice is off the books and may be typed again.
    await withTx(db, (tx) => cancelGrn(tx, fx.incharge.actor, ok.grnId, "wrong batch typed", new Date()));
    expect((await captureSupplierInvoice(db, fx.incharge.actor, header, [gridRow()], new Date())).grnId).not.toBe(ok.grnId);
  });

  it("an invoice against a purchase order is the GRN gate's: the order's vendor and headroom are asked at capture", async () => {
    const vendorId = await aSupplier();
    const other = await aSupplier("OTHERCO");
    const po = await createPurchaseOrder(db, fx.pharmacist.actor, { vendorId: other, storeResourceId: fx.storeId, lines: [{ itemId: fx.item.crocin, qtyPacks: 5, ratePaise: 8000 }] });
    expect(await codeOf(captureSupplierInvoice(db, fx.incharge.actor, {
      vendorId, invoiceNo: "SI/9", invoiceDate: today(), storeResourceId: fx.storeId, purchaseOrderId: po.id,
    }, [gridRow()], new Date()))).toBe("po_wrong_status");
  });

  it("a credit note without a return: only from a real supplier, once per supplier note, cancelled while unspent, and on the ledger and register", async () => {
    const vendorId = await aSupplier();
    const input = { vendorId, kind: "scheme" as const, vendorCreditNoteNo: "CN/SC/1", creditNoteDate: today(), taxablePaise: 20_000, gstPaise: 2_400, note: "Q3 scheme" };
    const c = await recordStandaloneCredit(db, fx.incharge.actor, input);
    expect(c.amountPaise).toBe(22_400);
    expect(await codeOf(recordStandaloneCredit(db, fx.incharge.actor, { ...input, vendorCreditNoteNo: "cn/sc/1" }))).toBe("credit_invalid");
    expect(await codeOf(recordStandaloneCredit(db, fx.incharge.actor, { ...input, vendorCreditNoteNo: "CN/2", taxablePaise: 0, gstPaise: 0 }))).toBe("credit_invalid");
    expect(await codeOf(recordStandaloneCredit(db, fx.incharge.actor, { ...input, vendorCreditNoteNo: "CN/3", creditNoteDate: "2999-01-01" }))).toBe("credit_invalid");
    expect(await codeOf(recordStandaloneCredit(db, fx.pharmacist.actor, { ...input, vendorCreditNoteNo: "CN/4", kind: "freebie" as never }))).toBe("credit_invalid");

    expect((await vendorCredits(db, [vendorId])).get(vendorId)?.availablePaise).toBe(22_400);
    const ledger = await supplierLedger(db, fx.incharge.actor, vendorId, {});
    expect(ledger.entries.find((e) => e.kind === "credit_note")).toMatchObject({ voucherNo: c.creditNo, debitPaise: 22_400, reference: "CN/SC/1 · scheme" });
    const reg = await purchaseRegister(db, today(), today());
    expect(reg.rows.find((r) => r.kind === "credit_note")).toMatchObject({
      docNo: c.creditNo, vendorDocNo: "CN/SC/1", ref: "scheme", taxablePaise: 20_000, cgstPaise: 1_200, sgstPaise: 1_200, igstPaise: 0, totalPaise: 22_400,
    });
    expect((await listStandaloneCredits(db, fx.incharge.actor)).map((x) => [x.creditNo, x.kind, x.status])).toEqual([[c.creditNo, "scheme", "accepted"]]);

    await cancelStandaloneCredit(db, fx.incharge.actor, c.creditNoteId, "typed against the wrong supplier");
    expect((await vendorCredits(db, [vendorId])).get(vendorId)?.availablePaise ?? 0).toBe(0);
    const [row] = await db.select().from(supplierCreditNotes).where(eq(supplierCreditNotes.id, c.creditNoteId));
    expect(row).toMatchObject({ status: "cancelled", cancelReason: "typed against the wrong supplier" });
    // The same supplier note may now be recorded again, correctly.
    expect((await recordStandaloneCredit(db, fx.incharge.actor, input)).amountPaise).toBe(22_400);
  });

  it("a credit note is never from the hospital's own stock", async () => {
    await captureOpeningStock(db, fx.incharge.actor, await planOpeningGrid(db, [gridRow()], new Date()), new Date());
    const [opening] = await db.select({ vendorId: grns.vendorId }).from(grns);
    expect(await codeOf(recordStandaloneCredit(db, fx.incharge.actor, {
      vendorId: opening!.vendorId, kind: "other", vendorCreditNoteNo: "X", creditNoteDate: today(), taxablePaise: 100, gstPaise: 0,
    }))).toBe("credit_invalid");
  });

  it("a corrected pack takes what only names it — barcodes, the MRP on file — and is refused for the base unit, an open order or a captured GRN", async () => {
    const mk = async (code: string): Promise<string> => (await withTx(db, (tx) => registerItem(tx, fx.incharge.actor, {
      code, name: `${code} tablet`, class: "drug", baseUom: "tablet", batchTracked: true, formularyMedicineId: fx.med.crocin, gstRateBps: 1200,
      uoms: [{ uom: "strip10", toBaseMultiplier: 10, isPurchaseUom: true, isIssueUom: true }],
    }))).itemId;
    const a = await mk("PACKA");
    await withTx(db, (tx) => addBarcode(tx, fx.incharge.actor, a, { code: "8901234567890", packUom: "strip10" }));
    await withTx(db, (tx) => setPriceRegulation(tx, fx.incharge.actor, a, { mrpDefaultPaise: 5325, mrpUom: "strip10", effectiveFrom: new Date(Date.now() - 60_000) }));
    const done = await withTx(db, (tx) => replaceItemUom(tx, fx.incharge.actor, a, { fromUom: "STRIP10", uom: "strip15", toBaseMultiplier: 15 }));
    expect(done.repointed).toEqual(["barcodes", "price_regulation"]);
    expect((await db.select().from(itemBarcodes).where(eq(itemBarcodes.itemId, a)))[0]?.packUom).toBe("strip15");
    expect(await effectiveRegulation(db, a, new Date())).toMatchObject({ mrpDefaultPaise: 5325, mrpUom: "strip15" });
    expect(await codeOf(withTx(db, (tx) => replaceItemUom(tx, fx.incharge.actor, a, { fromUom: "tablet", uom: "tab", toBaseMultiplier: 2 })))).toBe("base_uom_required");
    expect(await codeOf(withTx(db, (tx) => replaceItemUom(tx, fx.incharge.actor, a, { fromUom: "strip15", uom: "strip20", toBaseMultiplier: 1 })))).toBe("base_uom_required");

    const vendorId = await aSupplier();
    const ordered = await mk("PACKB");
    await createPurchaseOrder(db, fx.pharmacist.actor, { vendorId, storeResourceId: fx.storeId, lines: [{ itemId: ordered, qtyPacks: 2, ratePaise: 1000 }] });
    expect(await codeOf(withTx(db, (tx) => replaceItemUom(tx, fx.incharge.actor, ordered, { fromUom: "strip10", uom: "strip15", toBaseMultiplier: 15 })))).toBe("pack_in_use");

    const captured = await mk("PACKC");
    await withTx(db, (tx) => captureGrn(tx, fx.incharge.actor, {
      vendorId, source: "challan", storeResourceId: fx.storeId, challanNo: "CH/P", challanDate: today(), now: new Date(),
      lines: [{ itemId: captured, uom: "strip10", qtyInUom: 1, batchNo: "P1", expiryDate: `20${yy()}-08-31`, mrpPaise: 1000, mrpUom: "tablet", unitCostPaise: 50 }],
    }));
    expect(await codeOf(withTx(db, (tx) => replaceItemUom(tx, fx.incharge.actor, captured, { fromUom: "strip10", uom: "strip15", toBaseMultiplier: 15 })))).toBe("pack_in_use");
    expect((await itemUomRows(db, captured)).map((u) => u.uom).sort()).toEqual(["strip10", "tablet"]);
  });

  it("an opening row with no rate on an item whose batch exists keeps the batch's first cost — the estimate flag travels with the batch that it created", async () => {
    const vendorId = await aSupplier();
    const inv = await captureSupplierInvoice(db, fx.incharge.actor, { vendorId, invoiceNo: "SI/E", invoiceDate: today(), storeResourceId: fx.storeId }, [gridRow({ batch: "E1" })], new Date());
    await qcAndPost(inv.grnId);
    const done = await captureOpeningStock(db, fx.incharge.actor, await planOpeningGrid(db, [gridRow({ batch: "E1", ratePerPack: "" })], new Date()), new Date());
    await qcAndPost(done.captured[0]!.grnId);
    const [b] = await db.select().from(stockBatches).where(and(eq(stockBatches.itemId, fx.item.crocin), eq(stockBatches.batchNo, "E1")));
    expect([b?.landedCostPaise, b?.estimatedCost]).toEqual([800, false]);
  });

  it("a supplier bill draft without an invoice date falls back to the challan date", async () => {
    const vendorId = await aSupplier();
    const { grnId } = await withTx(db, (tx) => captureGrn(tx, fx.incharge.actor, {
      vendorId, source: "challan", storeResourceId: fx.storeId, challanNo: "CH/X", challanDate: today(), invoiceNo: "TAX/1", now: new Date(),
      lines: [{ itemId: fx.item.crocin, uom: "strip", qtyInUom: 1, batchNo: "X1", expiryDate: `20${yy()}-08-31`, mrpPaise: 12_000, mrpUom: "strip", unitCostPaise: 800 }],
    }));
    await qcAndPost(grnId);
    expect(await billDraftFromGrn(db, fx.incharge.actor, grnId)).toMatchObject({ vendorBillNo: "TAX/1", billDate: today() });
    // and the accepted bill table is untouched by a draft
    expect(await db.select().from(supplierBills)).toEqual([]);
  });

  it("walk 2026-11-13: an expiry typed as a phone's number pad types it (0828, 082028) is the label's month, and a refusal names the forms", async () => {
    const y = yy();
    const plan = await planOpeningGrid(db, [gridRow({ expiry: `08${y}` }), gridRow({ batch: "S2", expiry: `0820${y}` }), gridRow({ batch: "S3", expiry: `13${y}` })], new Date());
    expect(plan.rows.map((r) => r.expiryDate)).toEqual([`20${y}-08-31`, `20${y}-08-31`, ""]);
    expect(plan.rows[0]!.reasons).toEqual([]);
    expect(plan.rows[2]!.reasons).toContain(`expiry must be a month like 08/28, 0828 or 08/2028, got "13${y}"`);
  });

  it("walk 2026-11-13: the GRN list names each delivery's supplier and its value at cost", async () => {
    const vendorId = await aSupplier();
    const header: InvoiceHeader = { vendorId, invoiceNo: "SI/LIST/1", invoiceDate: today(), storeResourceId: fx.storeId };
    // 5 strips of 10 at Rs 80.00 a strip (800 paise a tablet) and a free strip at no cost: Rs 400.00.
    const { grnId } = await captureSupplierInvoice(db, fx.incharge.actor, header, [gridRow({ freePacks: "1" })], new Date());
    const captured = (await grnWorklist(db)).find((g) => g.id === grnId);
    expect(captured).toMatchObject({ vendorName: "MEDPLUS", invoiceNo: "SI/LIST/1", status: "gate_qc", valuePaise: 40_000 });
    await qcAndPost(grnId);
    expect((await grnWorklist(db, { vendorId })).map((g) => [g.grnNo, g.vendorName, g.valuePaise])).toEqual([[captured!.grnNo, "MEDPLUS", 40_000]]);
  });
});
