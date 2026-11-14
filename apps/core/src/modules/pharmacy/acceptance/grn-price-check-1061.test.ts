import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { mkUser } from "../../../../test/helpers/opd";
import { seedPharmacyBase } from "../../../../test/helpers/pharmacy";
import { grantPermissionToRole } from "../../../kernel/auth/permissions";
import { seedSodPairs } from "../../../kernel/auth/sod";
import { withTx } from "../../../kernel/db/client";
import { events, grnLines } from "../../../kernel/db/schema";
import {
  activateVendor, addItemUom, addVendorDocument, captureGrn, createPurchaseOrder, decidePurchaseOrder, postGrn,
  recordStandaloneCredit, registerMaterialsApprovalTypes, registerVendor, runGateQc, setVendorRates, submitPurchaseOrder,
} from "../../materials";
import { MaterialsController } from "../../materials/materials.controller";
import { officePurchaseAnalysis } from "../office-reports";
import { captureSupplierInvoice, planSupplierInvoice } from "../opening-stock";
import type { OpeningGridRow } from "../opening-stock";
import type { PharmacyFixture } from "../../../../test/helpers/pharmacy";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../../kernel/db/client";

/**
 * ACCEPTANCE — issue #1061, spec docs/specs/1061-grn-price-check.md (owner APPROVED 2026-11-14, ruling 0096):
 * every paid supplier GRN line is checked per base unit against the item's last paid receipt (any supplier) and
 * this supplier's contract rate; more than 2% above either is amber and needs a reason. The grid's half of D1 and
 * D7 (what the screen shows) is the web's: apps/web/src/screens/acceptance/grn-price-check-1061.test.tsx.
 *
 * Dates are read from the real clock (today's IST day, past receipts a few days back), never pinned.
 */
describe("purchase price check (spec #1061)", () => {
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
      "materials.items.manage", "materials.vendors.manage", "materials.grn.capture", "materials.grn.qc", "materials.po.raise",
      "materials.bills.manage", "pharmacy.reports.margin",
    ]) await grantPermissionToRole(db, fx.registry, "pharmacy", p);
    head = await mkUser(db, "mat.head", ["materials_head"]);
  });
  afterEach(() => { fx.unregister(); });

  const DAY = 86_400_000;
  const today = (): string =>
    new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const nextYear = (): number => new Date().getUTCFullYear() + 1;
  const yy = (): string => String(nextYear()).slice(2);

  async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
    try {
      await p;
      return undefined;
    } catch (e) {
      return (e as { code?: string }).code ?? String(e);
    }
  }

  async function aSupplier(code: string): Promise<string> {
    const { vendorId } = await withTx(db, (tx) => registerVendor(tx, fx.incharge.actor, { code, legalName: `${code} Distributors Pvt Ltd` }));
    await withTx(db, (tx) => addVendorDocument(tx, fx.incharge.actor, vendorId, { type: "gst_certificate", number: "g" }));
    await withTx(db, (tx) => addVendorDocument(tx, fx.incharge.actor, vendorId, { type: "pan", number: "p" }));
    await withTx(db, (tx) => activateVendor(tx, fx.incharge.actor, vendorId, new Date()));
    return vendorId;
  }

  /** A delivery captured, QC'd and posted `daysAgo` days back: Crocin, ₹120 MRP a strip, at `costPerBase` paise a tablet. */
  async function bought(vendorId: string, costPerBase: number, daysAgo: number, opts: { uom?: string; packs?: number; source?: string; free?: boolean; batch?: string } = {}): Promise<string> {
    const at = new Date(Date.now() - daysAgo * DAY);
    const uom = opts.uom ?? "strip";
    const mult = uom === "box100" ? 100 : 10;
    const { grnId } = await withTx(db, (tx) => captureGrn(tx, fx.incharge.actor, {
      vendorId, source: opts.source ?? "challan", storeResourceId: fx.storeId, challanNo: `CH-${String(daysAgo)}-${String(costPerBase)}`,
      challanDate: today(), now: at,
      lines: [{
        itemId: fx.item.crocin, uom, qtyInUom: opts.packs ?? 5, batchNo: opts.batch ?? `B${String(daysAgo)}${String(costPerBase)}`,
        expiryDate: `${String(nextYear())}-08-31`, mrpPaise: 12_000 * (mult / 10), mrpUom: uom,
        unitCostPaise: opts.free === true ? 0 : costPerBase, ...(opts.free === true ? { freeGoods: true } : {}),
      }],
    }));
    await withTx(db, (tx) => runGateQc(tx, fx.pharmacist.actor, grnId));
    await withTx(db, (tx) => postGrn(tx, fx.pharmacist.actor, grnId, at));
    return grnId;
  }

  const header = (vendorId: string, invoiceNo: string) => ({
    vendorId, invoiceNo, invoiceDate: today(), purchaseOrderId: null, storeResourceId: fx.storeId, rateIncludesGst: false,
  });
  /** One Crocin row of the grid: a strip of 10 at `rate` rupees (without GST). */
  const row = (rate: string, extra: Partial<OpeningGridRow> = {}): OpeningGridRow => ({
    itemId: fx.item.crocin, batch: "NEW1", expiry: `08/${yy()}`, packSize: "10", packs: "5", freePacks: "", mrpPerPack: "120.00",
    ratePerPack: rate, discountPct: "", ...extra,
  });

  it("spec #1061 D1: a line more than 2% above the last paid receipt is amber with the last three receipts, and capture is refused until a reason is given", async () => {
    const a = await aSupplier("ALPHA");
    const b = await aSupplier("BRAVO");
    await bought(a, 800, 3);
    await bought(b, 790, 2);
    await bought(a, 800, 1);

    // ₹84 a strip = 840 paise a tablet: 5% above the last receipt (800).
    const plan = await planSupplierInvoice(db, header(b, "INV-D1"), [row("84.00")], new Date());
    const check = plan.rows[0]!.priceCheck!;
    expect(check.status).toBe("amber");
    expect(check.refKind).toBe("last_receipt");
    expect(check.refPaisePerBase).toBe(800);
    expect(check.receipts.map((r) => r.paisePerBase)).toEqual([800, 790, 800]);
    expect(check.cheaper?.paisePerBase).toBe(790);
    expect(plan.rows[0]!.reasons).toEqual([]);

    expect(await codeOf(captureSupplierInvoice(db, fx.incharge.actor, header(b, "INV-D1"), [row("84.00")], new Date()))).toBe("price_reason_required");
    // "Other" needs its words.
    expect(await codeOf(captureSupplierInvoice(db, fx.incharge.actor, header(b, "INV-D1"), [row("84.00", { priceReason: "other", priceReasonText: " " })], new Date())))
      .toBe("price_reason_required");

    const done = await captureSupplierInvoice(db, fx.incharge.actor, header(b, "INV-D1"), [row("84.00", { priceReason: "urgent_buy" })], new Date());
    const [line] = await db.select().from(grnLines).where(eq(grnLines.grnId, done.grnId));
    expect(line).toMatchObject({ priceReasonCode: "urgent_buy", priceRefPaisePerBase: 800, priceRefKind: "last_receipt" });
    const emitted = await db.select({ payload: events.payload }).from(events).where(eq(events.name, "grn.price_above_reference"));
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.payload).toMatchObject({ grnId: done.grnId, itemId: fx.item.crocin, unitCostPaise: 840, refPaisePerBase: 800, reasonCode: "urgent_buy" });
  });

  it("spec #1061 D2: a line within 2% captures with no reason asked", async () => {
    const a = await aSupplier("ALPHA");
    await bought(a, 800, 1);
    // ₹81.60 = 816 paise: exactly 2% above, which is not MORE than 2%.
    const plan = await planSupplierInvoice(db, header(a, "INV-D2"), [row("81.60")], new Date());
    expect(plan.rows[0]!.priceCheck?.status).toBe("ok");
    const done = await captureSupplierInvoice(db, fx.incharge.actor, header(a, "INV-D2"), [row("81.60")], new Date());
    const [line] = await db.select().from(grnLines).where(eq(grnLines.grnId, done.grnId));
    expect(line?.priceReasonCode).toBeNull();
    expect(await db.select({ seq: events.seq }).from(events).where(eq(events.name, "grn.price_above_reference"))).toHaveLength(0);
  });

  it("spec #1061 D3: per base unit — a box-of-100 receipt and a strip-of-10 line compare correctly; opening stock and free lines are never the last receipt", async () => {
    await withTx(db, (tx) => addItemUom(tx, fx.incharge.actor, fx.item.crocin, { uom: "box100", toBaseMultiplier: 100, isPurchaseUom: true }));
    const a = await aSupplier("ALPHA");
    // A box of 100 at ₹800 is 800 paise a tablet.
    await bought(a, 800, 3, { uom: "box100", packs: 1 });
    // Newer, and neither is a purchase: the shelf's counted stock at a low cost, and a free strip.
    await bought(a, 500, 2, { source: "opening_stock" });
    await bought(a, 0, 1, { free: true });

    // A strip of 10 at ₹80 is the same 800 a tablet: no rise.
    const same = await planSupplierInvoice(db, header(a, "INV-D3a"), [row("80.00")], new Date());
    expect(same.rows[0]!.priceCheck).toMatchObject({ status: "ok", refPaisePerBase: 800 });
    expect(same.rows[0]!.priceCheck!.receipts.map((r) => r.paisePerBase)).toEqual([800]);
    // A strip at ₹85 is 850 a tablet: 6.25% above the box's 800, not 70% above the opening count's 500.
    const dearer = await planSupplierInvoice(db, header(a, "INV-D3b"), [row("85.00")], new Date());
    expect(dearer.rows[0]!.priceCheck).toMatchObject({ status: "amber", refKind: "last_receipt", refPaisePerBase: 800 });

    // An opening-stock capture is never checked, whatever its cost.
    expect(await codeOf(withTx(db, (tx) => captureGrn(tx, fx.incharge.actor, {
      vendorId: a, source: "opening_stock", storeResourceId: fx.storeId, challanNo: "OPEN-2", challanDate: today(), now: new Date(),
      lines: [{ itemId: fx.item.crocin, uom: "strip", qtyInUom: 2, batchNo: "OP2", expiryDate: `${String(nextYear())}-08-31`, mrpPaise: 12_000, mrpUom: "strip", unitCostPaise: 2_000 }],
    })))).toBeUndefined();
  });

  it("spec #1061 D4: a line above this supplier's contract rate is amber even when the last receipt was dearer", async () => {
    const a = await aSupplier("ALPHA");
    await bought(a, 850, 1);
    // Contract: ₹78 a strip = 780 a tablet.
    await setVendorRates(db, fx.incharge.actor, a, [{ itemId: fx.item.crocin, uom: "strip", ratePaise: 7_800 }]);

    // ₹82 a strip = 820: below the last receipt (850), 5.1% above the contract (780).
    const plan = await planSupplierInvoice(db, header(a, "INV-D4"), [row("82.00")], new Date());
    expect(plan.rows[0]!.priceCheck).toMatchObject({ status: "amber", refKind: "contract", refPaisePerBase: 780 });

    const refused = withTx(db, (tx) => captureGrn(tx, fx.incharge.actor, {
      vendorId: a, source: "challan", storeResourceId: fx.storeId, challanNo: "CH-D4", challanDate: today(), now: new Date(),
      lines: [{ itemId: fx.item.crocin, uom: "strip", qtyInUom: 5, batchNo: "D4", expiryDate: `${String(nextYear())}-08-31`, mrpPaise: 12_000, mrpUom: "strip", unitCostPaise: 820 }],
    }));
    await expect(refused).rejects.toMatchObject({ code: "price_reason_required", detail: { lines: [{ index: 0, check: { refKind: "contract", refPaisePerBase: 780 } }] } });
  });

  it("spec #1061 D5: a PO receipt (POST /materials/grns) with an amber line is refused without a reason, as the grid is", async () => {
    const a = await aSupplier("ALPHA");
    await bought(a, 800, 1);
    const po = await createPurchaseOrder(db, fx.pharmacist.actor, {
      vendorId: a, storeResourceId: fx.storeId, lines: [{ itemId: fx.item.crocin, qtyPacks: 10, ratePaise: 9_000 }],
    });
    await submitPurchaseOrder(db, fx.pharmacist.actor, po.id);
    await decidePurchaseOrder(db, head.actor, po.id, "approve", "ok");

    const controller = new MaterialsController(db);
    const body = (priceReason?: { code: string; text?: string }) => ({
      vendorId: a, source: "challan", storeResourceId: fx.storeId, challanNo: "CH-D5", challanDate: today(), purchaseOrderId: po.id,
      lines: [{
        itemId: fx.item.crocin, uom: "strip", qtyInUom: 10, batchNo: "D5", expiryDate: `${String(nextYear())}-08-31`, mrpPaise: 12_000, mrpUom: "strip",
        unitCostPaise: 900, ...(priceReason === undefined ? {} : { priceReason }),
      }],
    });
    // 900 a tablet is 12.5% above the last receipt (800).
    await expect(controller.capture(fx.incharge.actor, body())).rejects.toMatchObject({ response: { code: "price_reason_required" } });
    const { grnId } = await controller.capture(fx.incharge.actor, body({ code: "scheme_changed" }));
    const [line] = await db.select().from(grnLines).where(eq(grnLines.grnId, grnId));
    expect(line).toMatchObject({ priceReasonCode: "scheme_changed", priceRefPaisePerBase: 800, priceRefKind: "last_receipt" });
  });

  it("spec #1061 D6: an item with no past receipt and no contract captures as first purchase, no reason asked", async () => {
    const a = await aSupplier("ALPHA");
    const plan = await planSupplierInvoice(db, header(a, "INV-D6"), [row("99.00")], new Date());
    expect(plan.rows[0]!.priceCheck).toMatchObject({ status: "first", refPaisePerBase: null, receipts: [] });
    const done = await captureSupplierInvoice(db, fx.incharge.actor, header(a, "INV-D6"), [row("99.00")], new Date());
    const [line] = await db.select().from(grnLines).where(eq(grnLines.grnId, done.grnId));
    expect(line?.priceReasonCode).toBeNull();
  });

  it("spec #1061 D7: an invoice from a supplier with accepted, unspent credit shows the unused amount", async () => {
    const a = await aSupplier("ALPHA");
    const b = await aSupplier("BRAVO");
    await recordStandaloneCredit(db, fx.incharge.actor, {
      vendorId: a, kind: "rate_difference", vendorCreditNoteNo: "CN/7", creditNoteDate: today(), taxablePaise: 10_000, gstPaise: 1_200,
    }, new Date());
    expect((await planSupplierInvoice(db, header(a, "INV-D7"), [row("80.00")], new Date())).unusedCreditPaise).toBe(11_200);
    expect((await planSupplierInvoice(db, header(b, "INV-D7"), [row("80.00")], new Date())).unusedCreditPaise).toBe(0);
  });

  it("spec #1061 D8: the Purchase analysis report lists every amber line with reference, rate paid, extra rupees, reason and who, with per-supplier totals", async () => {
    const a = await aSupplier("ALPHA");
    const b = await aSupplier("BRAVO");
    await bought(a, 800, 2);
    // Amber, with reasons: 5 strips at 840 (+40 × 50 tablets = ₹20), then 2 strips at 900 (+100 × 20 = ₹20).
    await captureSupplierInvoice(db, fx.incharge.actor, header(b, "INV-D8a"), [row("84.00", { priceReason: "urgent_buy" })], new Date());
    await captureSupplierInvoice(db, fx.incharge.actor, header(b, "INV-D8b"), [row("90.00", { packs: "2", priceReason: "other", priceReasonText: "only stockist" })], new Date());
    // Within 2%: not on the report.
    await captureSupplierInvoice(db, fx.incharge.actor, header(a, "INV-D8c"), [row("80.50")], new Date());

    const r = await officePurchaseAnalysis(db, fx.incharge.actor, { preset: "today", from: null, to: null }, new Date());
    expect(r.rows).toHaveLength(2);
    expect(r.rows.map((x) => [x.refPaisePerBase, x.paidPaisePerBase, x.extraPaise, x.reasonCode]).sort()).toEqual([
      [800, 840, 2_000, "urgent_buy"], [800, 900, 2_000, "other"],
    ].sort());
    expect(r.rows.find((x) => x.reasonCode === "other")).toMatchObject({ reasonText: "only stockist", capturedBy: fx.incharge.id });
    expect(r.byVendor).toEqual([expect.objectContaining({ vendorId: b, lines: 2, extraPaise: 4_000 })]);
    expect(r.totalExtraPaise).toBe(4_000);
  });
});
