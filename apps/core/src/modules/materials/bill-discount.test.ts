import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { ensureRole, mkUser } from "../../../test/helpers/opd";
import { grantPermissionToRole, syncPermissions } from "../../kernel/auth/permissions";
import { seedSodPairs } from "../../kernel/auth/sod";
import { withTx } from "../../kernel/db/client";
import { ModuleRegistry } from "../../kernel/modules/loader";
import { ALL_MANIFESTS } from "../../kernel/modules/manifests";
import { registerMaterialsApprovalTypes } from "./approval-types";
import { captureGrn, postGrn, runGateQc } from "./grn";
import { registerItem } from "./items";
import { createPurchaseOrder, decidePurchaseOrder, submitPurchaseOrder } from "./purchase-orders";
import { vendorDiscountReport } from "./reports";
import { createStore } from "./stores";
import { acceptSupplierBill, billDraftFromGrn, createSupplierBill, matchSupplierBill } from "./supplier-bills";
import { activateVendor, addVendorDocument, registerVendor } from "./vendors";
import { MaterialsError } from "./errors";
import { MaterialsController } from "./materials.controller";
import type { BillDraft, BillLineInput } from "./supplier-bills";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * #637 — the vendor's trade discount on a supplier bill line (list rate, then a percent OR an amount per pack off it),
 * GST on the discounted value, prefilled from the PO line, and read back by vendor. Fixtures: a strip is 10 tablets.
 * Rounding (DECIDED $, as the PO line, #450): a percent discount gives the net rate per pack half up to the paisa;
 * taxable = packs × net rate; GST half up per line on that taxable value.
 */
const T0 = new Date("2026-09-24T04:30:00.000Z"); // 10:00 IST, 24 Sep 2026
const at = (minutes: number): Date => new Date(T0.getTime() + minutes * 60_000);

describe("#637 the vendor discount on supplier bill lines, the PO paper and the by-vendor report", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let head: { id: string; actor: Actor };
  let pharmacist: { id: string; actor: Actor };
  let keeper: { id: string; actor: Actor };
  let store: string;
  let vendor: string;
  let taxed: string; // GST 12%
  let zero: string; // GST nil — for the tolerance edges, so GST cannot move the total

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    const registry = new ModuleRegistry();
    for (const m of ALL_MANIFESTS) registry.install(m);
    await syncPermissions(db, registry);
    await seedSodPairs(db);
    await registerMaterialsApprovalTypes(db, { type: "user", id: "seed-materials" });
    for (const role of ["materials_head", "pharmacy", "storekeeper", "owner"]) await ensureRole(db, role);
    const grants: Record<string, string[]> = {
      materials_head: [
        "materials.po.raise", "materials.stock.read", "materials.grn.capture", "materials.grn.qc", "materials.items.manage",
        "approvals.requests.decide", "approvals.requests.read", "materials.bills.manage", "materials.bills.accept_difference",
        "materials.payments.prepare", "materials.payments.record",
      ],
      pharmacy: ["materials.po.raise", "materials.stock.read", "materials.grn.qc", "materials.bills.manage"],
      storekeeper: ["materials.stock.read", "materials.grn.capture"],
      // The owner also holds prepare and record HERE, so the two SoD pairs — not a missing grant — are what refuse.
      owner: ["approvals.requests.decide", "approvals.requests.read", "materials.payments.prepare", "materials.payments.record"],
    };
    for (const [role, perms] of Object.entries(grants)) for (const p of perms) await grantPermissionToRole(db, registry, role, p);
    head = await mkUser(db, "mat.head", ["materials_head"]);
    pharmacist = await mkUser(db, "pharm.one", ["pharmacy"]);
    keeper = await mkUser(db, "store.keeper", ["storekeeper"]);
    ({ resourceId: store } = await withTx(db, (tx) => createStore(tx, head.actor, { code: "PHARM-OPD", name: "OPD pharmacy" })));
    vendor = await aVendor("ACME", { paymentTermsDays: null });
    taxed = await anItem("CROC", 1200);
    zero = await anItem("ZERO", 0);
  });

  async function aVendor(code: string, over: { msmeClass?: string | null; paymentTermsDays?: number | null } = {}): Promise<string> {
    const { vendorId } = await withTx(db, (tx) => registerVendor(tx, head.actor, { code, legalName: `${code} Pharma Pvt Ltd`, ...over }));
    await withTx(db, (tx) => addVendorDocument(tx, head.actor, vendorId, { type: "gst_certificate", number: "g" }));
    await withTx(db, (tx) => addVendorDocument(tx, head.actor, vendorId, { type: "pan", number: "p" }));
    await withTx(db, (tx) => activateVendor(tx, head.actor, vendorId, T0));
    return vendorId;
  }

  async function anItem(code: string, gstRateBps: number): Promise<string> {
    const { itemId } = await withTx(db, (tx) => registerItem(tx, head.actor, {
      code, name: `Item ${code}`, class: "consumable", baseUom: "tablet", batchTracked: true, gstRateBps,
      uoms: [{ uom: "strip", toBaseMultiplier: 10, isPurchaseUom: true }],
    }));
    return itemId;
  }

  /** A posted GRN of `strips` strips, against an approved PO line at list `list` less `discountBps`. */
  async function received(v: string, itemId: string, strips: number, list: number, discountBps = 0): Promise<string> {
    const po = await createPurchaseOrder(db, pharmacist.actor, {
      vendorId: v, storeResourceId: store, lines: [{ itemId, qtyPacks: strips, ratePaise: list, ...(discountBps === 0 ? {} : { discountBps }) }],
    }, { now: T0 });
    await submitPurchaseOrder(db, pharmacist.actor, po.id, at(1));
    await decidePurchaseOrder(db, head.actor, po.id, "approve", "ok", at(2));
    const net = discountBps === 0 ? list : Math.floor((list * (10_000 - discountBps) + 5_000) / 10_000);
    const { grnId } = await withTx(db, (tx) => captureGrn(tx, keeper.actor, {
      vendorId: v, source: "challan", storeResourceId: store, challanNo: `CH-${String(Math.random()).slice(2, 8)}`, challanDate: "2026-09-24",
      invoiceNo: "INV/26-27/0042", purchaseOrderId: po.id,
      lines: [{ itemId, uom: "strip", qtyInUom: strips, batchNo: `B-${String(Math.random()).slice(2, 6)}`, expiryDate: "2028-06-30", unitCostPaise: Math.round(net / 10) }],
      now: at(10),
    }));
    await withTx(db, (tx) => runGateQc(tx, pharmacist.actor, grnId));
    await withTx(db, (tx) => postGrn(tx, pharmacist.actor, grnId, at(20)));
    return grnId;
  }
  const bill = (d: BillDraft, no: string, line: Partial<BillLineInput>) => createSupplierBill(db, pharmacist.actor, {
    vendorId: d.vendorId, vendorBillNo: no, billDate: "2026-09-24", interState: false,
    lines: d.lines.map((l) => ({ grnId: l.grnId, itemId: l.itemId, uom: l.uom, qtyPacks: l.qtyPacks, gstRateBps: l.gstRateBps, ...line })),
  }, { source: "manual", now: at(60) });
  const code = async (p: Promise<unknown>): Promise<string> => {
    try { await p; } catch (e) { if (e instanceof MaterialsError) return e.code; throw e; }
    return "did not refuse";
  };

  it("the prefill carries the PO line's list rate and discount; a 10% line bills at the net rate and GST is on the discounted value", async () => {
    const grn = await received(vendor, taxed, 10, 25_000, 1_000);
    const d = await billDraftFromGrn(db, pharmacist.actor, grn);
    expect(d.lines.map((l) => [l.listRatePaise, l.discountBps, l.ratePaise])).toEqual([[25_000, 1_000, 22_500]]);
    const b = await matchSupplierBill(db, pharmacist.actor, (await bill(d, "D-1", { listRatePaise: 25_000, discountBps: 1_000 })).id, at(61));
    expect(b.status).toBe("matched");
    expect(b.lines[0]).toMatchObject({ listRatePaise: 25_000, discountBps: 1_000, discountPaise: 2_500, ratePaise: 22_500, taxablePaise: 225_000, mismatch: [] });
    // GST 12% on ₹2,250, not on ₹2,500: ₹135 + ₹135.
    expect([b.taxablePaise, b.cgstPaise, b.sgstPaise, b.totalPaise]).toEqual([225_000, 13_500, 13_500, 252_000]);
  });

  it("an amount off per pack is kept as typed; a percent rounds the net rate per pack half up", async () => {
    const d1 = await billDraftFromGrn(db, pharmacist.actor, await received(vendor, zero, 10, 25_000));
    const amt = await bill(d1, "A-1", { listRatePaise: 25_000, discountPaise: 1_234 });
    expect(amt.lines[0]).toMatchObject({ listRatePaise: 25_000, discountBps: 0, discountPaise: 1_234, ratePaise: 23_766, taxablePaise: 237_660 });
    const d2 = await billDraftFromGrn(db, pharmacist.actor, await received(vendor, zero, 10, 9_999));
    // ₹99.99 less 12.5% = ₹87.49125 → ₹87.49 a strip.
    const pct = await bill(d2, "P-1", { listRatePaise: 9_999, discountBps: 1_250 });
    expect(pct.lines[0]).toMatchObject({ discountPaise: 1_250, ratePaise: 8_749, taxablePaise: 87_490 });
  });

  it("refuses a percent and an amount together, a discount above the list rate, and a rate that is not list less discount", async () => {
    const d = await billDraftFromGrn(db, pharmacist.actor, await received(vendor, zero, 10, 25_000));
    expect(await code(bill(d, "X-1", { listRatePaise: 25_000, discountBps: 500, discountPaise: 100 }))).toBe("bill_invalid");
    expect(await code(bill(d, "X-2", { listRatePaise: 25_000, discountPaise: 25_001 }))).toBe("bill_invalid");
    expect(await code(bill(d, "X-3", { listRatePaise: 25_000, discountBps: 1_000, ratePaise: 23_000 }))).toBe("bill_invalid");
    expect(await code(bill(d, "X-4", { discountBps: 1_000, ratePaise: 23_000 }))).toBe("bill_invalid");
  });

  it("the wire carries the list rate and a percent or an amount; the server sets the net rate", async () => {
    const d = await billDraftFromGrn(db, pharmacist.actor, await received(vendor, zero, 10, 25_000));
    const ctl = new MaterialsController(db);
    const out = await ctl.createBill(pharmacist.actor, {
      vendorId: d.vendorId, vendorBillNo: "W-1", billDate: "2026-09-24", interState: false,
      lines: d.lines.map((l) => ({ grnId: l.grnId, itemId: l.itemId, uom: l.uom, qtyPacks: l.qtyPacks, gstRateBps: l.gstRateBps, listRatePaise: 25_000, discountPaise: 1_234 })),
    });
    expect(out.bill.lines[0]).toMatchObject({ listRatePaise: 25_000, discountPaise: 1_234, ratePaise: 23_766 });
  });

  it("the by-vendor report adds gross, discount, taxable and GST of booked bills in the period", async () => {
    const other = await aVendor("BETA", { paymentTermsDays: 30 });
    const b1 = await bill(await billDraftFromGrn(db, pharmacist.actor, await received(vendor, taxed, 10, 25_000, 1_000)), "R-1", { listRatePaise: 25_000, discountBps: 1_000 });
    const b2 = await bill(await billDraftFromGrn(db, pharmacist.actor, await received(other, zero, 4, 10_000)), "R-2", { ratePaise: 10_000 });
    for (const id of [b1.id, b2.id]) {
      await matchSupplierBill(db, pharmacist.actor, id, at(61));
      await acceptSupplierBill(db, pharmacist.actor, id, at(62));
    }
    const r = await vendorDiscountReport(db, "2026-09-01", "2026-09-30");
    expect(r.rows.map((x) => [x.vendorCode, x.bills, x.grossPaise, x.discountPaise, x.taxablePaise, x.gstPaise, x.totalPaise, x.discountBps])).toEqual([
      ["ACME", 1, 250_000, 25_000, 225_000, 27_000, 252_000, 1_000],
      ["BETA", 1, 40_000, 0, 40_000, 0, 40_000, 0],
    ]);
    expect(r.totals).toMatchObject({ bills: 2, grossPaise: 290_000, discountPaise: 25_000, taxablePaise: 265_000, gstPaise: 27_000, totalPaise: 292_000 });
    expect((await vendorDiscountReport(db, "2026-10-01", "2026-10-31")).rows).toEqual([]);
  });
});
