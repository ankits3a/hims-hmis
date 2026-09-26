import { and, eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { ensureRole, mkUser } from "../../../test/helpers/opd";
import { grantPermissionToRole, syncPermissions } from "../../kernel/auth/permissions";
import { seedSodPairs } from "../../kernel/auth/sod";
import { withTx } from "../../kernel/db/client";
import { stockBalances, stockBatches } from "../../kernel/db/schema";
import { ModuleRegistry } from "../../kernel/modules/loader";
import { ALL_MANIFESTS } from "../../kernel/modules/manifests";
import {
  acceptSupplierBill, activateVendor, addVendorDocument, approveSupplierReturn, billDraftFromGrn, captureGrn, createStore, createSupplierBill,
  createSupplierReturn, dispatchSupplierReturn, matchSupplierBill, postGrn, postMovement, recordVendorCredit, registerItem,
  registerMaterialsApprovalTypes, registerVendor, runGateQc, updateSupplierBill,
} from "../materials";
import { documentActivity, recentActivity } from "./activity";
import { officeNonMoving, officePurchaseRegister, officeStockValuation } from "./office-reports";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ PHARMACY PARITY P5 — THE OFFICE'S STOCK AND PURCHASE REPORTS, AND THE ACTIVITY DIFF ═══
 *
 *   - the purchase register: a bill booked as payable, our debit note and the vendor's credit note,
 *     each its own row, with the input GST as billed; purchases net of returns;
 *   - stock valuation: today's quantities are exactly `stock_balances` (the ledger's invariant, read
 *     back from the ledger), and a past day does not see what came in after it;
 *   - non-moving stock: the window's first IST midnight is INSIDE it — stock that left at 00:00 of
 *     that day has moved, stock that last left a minute earlier has not;
 *   - the activity view: an edited supplier bill shows what the edit changed, before and after;
 *   - the owner reads all of it without a single materials grant; the pharmacist at the counter reads
 *     none of it.
 */
const T0 = new Date("2026-09-24T04:30:00.000Z"); // 10:00 IST, 24 Sep 2026
const at = (minutes: number): Date => new Date(T0.getTime() + minutes * 60_000);
/** An instant on an IST calendar day at hh:mm IST. */
const istAt = (day: string, hhmm: string): Date => new Date(Date.parse(`${day}T${hhmm}:00.000Z`) - 330 * 60_000);

describe("the office's purchase, stock and activity reports (parity P5)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let head: { id: string; actor: Actor };
  let pharmacist: { id: string; actor: Actor };
  let keeper: { id: string; actor: Actor };
  let owner: { id: string; actor: Actor };
  let store: string;
  let vendor: string;
  let taxed: string;
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
    for (const role of ["materials_head", "pharmacy", "storekeeper", "owner"]) await ensureRole(db, role);
    const grants: Record<string, string[]> = {
      materials_head: [
        "materials.po.raise", "materials.stock.read", "materials.grn.capture", "materials.grn.qc", "materials.items.manage", "materials.bills.manage",
        "materials.bills.accept_difference", "materials.returns.manage", "materials.returns.approve", "pharmacy.reports.read",
      ],
      pharmacy: ["materials.stock.read", "materials.grn.qc", "materials.bills.manage", "materials.returns.manage"],
      storekeeper: ["materials.stock.read", "materials.grn.capture"],
      // The owner reads the reports and holds NO materials grant: the reports' own permission is the gate.
      owner: ["pharmacy.reports.read"],
    };
    for (const [role, perms] of Object.entries(grants)) for (const p of perms) await grantPermissionToRole(db, registry, role, p);
    head = await mkUser(db, "mat.head", ["materials_head"]);
    pharmacist = await mkUser(db, "pharm.one", ["pharmacy"]);
    keeper = await mkUser(db, "store.keeper", ["storekeeper"]);
    owner = await mkUser(db, "the.owner", ["owner"]);
    ({ resourceId: store } = await withTx(db, (tx) => createStore(tx, head.actor, { code: "PHARM-OPD", name: "OPD pharmacy" })));
    const { vendorId } = await withTx(db, (tx) => registerVendor(tx, head.actor, { code: "ACME", legalName: "ACME Pharma Pvt Ltd", gstin: "27AAACA1234A1Z5" }));
    await withTx(db, (tx) => addVendorDocument(tx, head.actor, vendorId, { type: "gst_certificate", number: "g" }));
    await withTx(db, (tx) => addVendorDocument(tx, head.actor, vendorId, { type: "pan", number: "p" }));
    await withTx(db, (tx) => activateVendor(tx, head.actor, vendorId, T0));
    vendor = vendorId;
    taxed = await anItem("CROC", 1200);
    slow = await anItem("SLOW", 1200);
  });

  async function anItem(code: string, gstRateBps: number): Promise<string> {
    const { itemId } = await withTx(db, (tx) => registerItem(tx, head.actor, {
      code, name: `Item ${code}`, class: "consumable", baseUom: "tablet", batchTracked: true, gstRateBps, hsnCode: "30049099",
      uoms: [{ uom: "strip", toBaseMultiplier: 10, isPurchaseUom: true }],
    }));
    return itemId;
  }

  /** A posted GRN of `strips` strips at ₹25 a strip (₹2.50 a tablet). */
  async function received(itemId: string, strips: number, batchNo: string, postAt: Date = at(20)): Promise<{ grnId: string; batchId: string }> {
    const { grnId } = await withTx(db, (tx) => captureGrn(tx, keeper.actor, {
      vendorId: vendor, source: "challan", storeResourceId: store, challanNo: `CH-${batchNo}`, challanDate: new Date(postAt.getTime() + 330 * 60_000).toISOString().slice(0, 10), invoiceNo: `INV-${batchNo}`,
      lines: [{ itemId, uom: "strip", qtyInUom: strips, batchNo, expiryDate: "2028-06-30", unitCostPaise: 250 }],
      now: new Date(postAt.getTime() - 10 * 60_000),
    }));
    await withTx(db, (tx) => runGateQc(tx, pharmacist.actor, grnId));
    await withTx(db, (tx) => postGrn(tx, pharmacist.actor, grnId, postAt));
    const [batch] = await db.select().from(stockBatches).where(and(eq(stockBatches.itemId, itemId), eq(stockBatches.batchNo, batchNo)));
    return { grnId, batchId: batch!.id };
  }

  async function bookedBill(grnId: string, vendorBillNo: string): Promise<{ id: string; billNo: string }> {
    const d = await billDraftFromGrn(db, pharmacist.actor, grnId);
    const b = await createSupplierBill(db, pharmacist.actor, {
      vendorId: vendor, vendorBillNo, billDate: "2026-09-24", interState: false,
      lines: d.lines.map((l) => ({ grnId: l.grnId, itemId: l.itemId, uom: l.uom, qtyPacks: l.qtyPacks, ratePaise: l.ratePaise, gstRateBps: l.gstRateBps })),
    }, { now: at(60) });
    await matchSupplierBill(db, pharmacist.actor, b.id, at(61));
    await acceptSupplierBill(db, pharmacist.actor, b.id, at(62));
    return { id: b.id, billNo: b.billNo };
  }

  it("the purchase register lists the booked bill, our debit note and the vendor's credit, each once, with purchases net of returns", async () => {
    const { grnId, batchId } = await received(taxed, 10, "CR-1");
    const bill = await bookedBill(grnId, "ACME/0042");
    // A draft bill is not in the books.
    const other = await received(taxed, 2, "CR-2");
    const d2 = await billDraftFromGrn(db, pharmacist.actor, other.grnId);
    await createSupplierBill(db, pharmacist.actor, { vendorId: vendor, vendorBillNo: "ACME/0043", billDate: "2026-09-24", lines: d2.lines.map((l) => ({ grnId: l.grnId, itemId: l.itemId, uom: l.uom, qtyPacks: l.qtyPacks, ratePaise: l.ratePaise, gstRateBps: l.gstRateBps })) }, { now: at(63) });
    // Two strips (20 tablets) go back damaged: the head approves, the pharmacist dispatches, the vendor credits it whole.
    const r = await createSupplierReturn(db, pharmacist.actor, { vendorId: vendor, lines: [{ batchId, storeResourceId: store, qtyBase: 20, reason: "damaged" }] }, { now: at(100) });
    await approveSupplierReturn(db, head.actor, r.id, at(101));
    const sent = await dispatchSupplierReturn(db, pharmacist.actor, r.id, at(102));
    await recordVendorCredit(db, pharmacist.actor, r.id, { vendorCreditNoteNo: "ACME-CN-7", creditNoteDate: "2026-09-24", amountPaise: sent.totalPaise }, at(103));

    const reg = await officePurchaseRegister(db, owner.actor, { preset: "custom", from: "2026-09-01", to: "2026-09-30" }, at(200));
    expect(reg.rows.map((x) => [x.kind, x.docNo.slice(0, 3), x.vendorDocNo, x.totalPaise])).toEqual([
      ["bill", "MSB", "ACME/0042", 28_000],
      ["debit_note", "MDN", null, sent.totalPaise],
      ["credit_note", "MCN", "ACME-CN-7", sent.totalPaise],
    ]);
    expect(reg.rows[0]).toMatchObject({ taxablePaise: 25_000, cgstPaise: 1_500, sgstPaise: 1_500, igstPaise: 0, paidPaise: 0, duePaise: 28_000, docNo: bill.billNo });
    expect(reg.rows[0]!.lines).toMatchObject([{ itemCode: "CROC", qty: 10, uom: "strip", ratePaise: 2_500, taxablePaise: 25_000, gstRateBps: 1200 }]);
    // 20 tablets at ₹2.50 = ₹50 + 12% = ₹56; the credit reads exactly like the debit note it answers.
    expect([sent.taxablePaise, sent.totalPaise]).toEqual([5_000, 5_600]);
    expect(reg.rows[2]).toMatchObject({ taxablePaise: 5_000, cgstPaise: 300, sgstPaise: 300, ref: sent.debitNoteNo });
    expect(reg.totals.net).toMatchObject({ taxablePaise: 20_000, cgstPaise: 1_200, sgstPaise: 1_200, totalPaise: 22_400 });
    expect([reg.totals.bills.count, reg.totals.debitNotes.count, reg.totals.creditNotes.count]).toEqual([1, 1, 1]);

    await expect(officePurchaseRegister(db, pharmacist.actor, { preset: "month" }, at(200))).rejects.toMatchObject({ code: "permission_denied" });
    await expect(officePurchaseRegister(db, owner.actor, { preset: "custom", from: "2026-09-30", to: "2026-09-01" }, at(200))).rejects.toMatchObject({ code: "invalid_range" });
    await expect(officePurchaseRegister(db, owner.actor, { preset: "custom", from: "2025-09-01", to: "2026-09-30" }, at(200))).rejects.toMatchObject({ code: "invalid_range" });
  });

  it("today's valuation is stock_balances exactly, read from the ledger; a past day does not see what came after it", async () => {
    const a = await received(taxed, 10, "CR-1", at(20));
    await received(slow, 5, "SL-1", istAt("2026-09-26", "11:00"));
    // 7 tablets leave the counter on the 25th.
    await withTx(db, (tx) => postMovement(tx, head.actor, { resourceId: store, batchId: a.batchId, qtyDelta: -7, reason: "consume", refType: "test", refId: "t1", occurredAt: istAt("2026-09-25", "12:00") }));

    const now = istAt("2026-09-27", "10:00");
    const today = await officeStockValuation(db, owner.actor, {}, now);
    const balances = await db.select().from(stockBalances);
    expect(today.rows.map((r) => [r.batchId, r.qtyBase]).sort()).toEqual(balances.filter((b) => b.qtyOnHand !== 0).map((b) => [b.batchId, b.qtyOnHand]).sort());
    expect(today.rows.find((r) => r.batchId === a.batchId)).toMatchObject({ qtyBase: 93, landedCostPaise: 250, costValuePaise: 23_250 });
    expect(today.totals.costValuePaise).toBe(93 * 250 + 50 * 250);

    const past = await officeStockValuation(db, owner.actor, { asOf: "2026-09-24" }, now);
    expect(past.rows.map((r) => [r.itemCode, r.qtyBase])).toEqual([["CROC", 100]]);
    const mid = await officeStockValuation(db, owner.actor, { asOf: "2026-09-25" }, now);
    expect(mid.rows.map((r) => [r.itemCode, r.qtyBase])).toEqual([["CROC", 93]]);
    await expect(officeStockValuation(db, owner.actor, { asOf: "2026-09-28" }, now)).rejects.toMatchObject({ code: "invalid_day" });
    await expect(officeStockValuation(db, pharmacist.actor, {}, now)).rejects.toMatchObject({ code: "permission_denied" });
  });

  it("non-moving: stock that left at 00:00 IST on the window's first day has moved; a minute earlier it has not", async () => {
    const now = istAt("2026-12-31", "10:00");
    // 90 days before 31 Dec is 2 Oct: the window opens at 00:00 IST on 2 Oct.
    const moving = await received(taxed, 10, "CR-1");
    const idle = await received(slow, 10, "SL-1");
    await withTx(db, (tx) => postMovement(tx, head.actor, { resourceId: store, batchId: moving.batchId, qtyDelta: -1, reason: "consume", refType: "test", refId: "m", occurredAt: istAt("2026-10-02", "00:00") }));
    await withTx(db, (tx) => postMovement(tx, head.actor, { resourceId: store, batchId: idle.batchId, qtyDelta: -1, reason: "consume", refType: "test", refId: "i", occurredAt: istAt("2026-10-01", "23:59") }));

    const r = await officeNonMoving(db, owner.actor, { days: 90 }, now);
    expect(r.since).toBe("2026-10-02");
    expect(r.rows.map((x) => [x.itemCode, x.qtyBase, x.idleDays])).toEqual([["SLOW", 99, 91]]);
    expect(r.rows[0]).toMatchObject({ costValuePaise: 99 * 250, suggestion: "watch", supplierKind: "supplier" });
    expect(r.totals).toMatchObject({ batches: 1, items: 1, costValuePaise: 99 * 250 });
    // A receipt is not a movement: stock that only ever came in is non-moving too.
    const never = await received(taxed, 1, "CR-9");
    void never;
    const again = await officeNonMoving(db, owner.actor, { days: 90 }, now);
    expect(again.rows.map((x) => x.itemCode)).toEqual(["SLOW"]); // CROC moved inside the window: every CROC batch is moving
    const d30 = await officeNonMoving(db, owner.actor, { days: 30 }, now);
    expect(d30.rows.map((x) => [x.itemCode, x.batchNo, x.lastMovedAt === null]).sort()).toEqual([["CROC", "CR-1", false], ["CROC", "CR-9", false], ["SLOW", "SL-1", false]]);
    await expect(officeNonMoving(db, owner.actor, { days: 45 }, now)).rejects.toMatchObject({ code: "invalid_range" });
  });

  it("the activity view: an edited supplier bill shows each change, before and after, and the owner reads it", async () => {
    const { grnId } = await received(taxed, 10, "CR-1");
    const d = await billDraftFromGrn(db, pharmacist.actor, grnId);
    const b = await createSupplierBill(db, pharmacist.actor, {
      vendorId: vendor, vendorBillNo: "ACME/0042", billDate: "2026-09-24",
      lines: d.lines.map((l) => ({ grnId: l.grnId, itemId: l.itemId, uom: l.uom, qtyPacks: l.qtyPacks, ratePaise: l.ratePaise, gstRateBps: l.gstRateBps })),
    }, { now: at(60) });
    // The vendor's invoice said ₹26 a strip, not ₹25: the pharmacist corrects the line.
    await updateSupplierBill(db, pharmacist.actor, b.id, {
      lines: d.lines.map((l) => ({ grnId: l.grnId, itemId: l.itemId, uom: l.uom, qtyPacks: l.qtyPacks, ratePaise: 2_600, gstRateBps: l.gstRateBps })),
    }, at(70));
    await matchSupplierBill(db, pharmacist.actor, b.id, at(71));

    const t = await documentActivity(db, owner.actor, b.billNo.toLowerCase());
    expect(t).toMatchObject({ kind: "supplier_bill", id: b.id, no: b.billNo });
    expect(t.entries.map((e) => [e.name, e.status, e.actorName])).toEqual([
      ["supplier_bill.drafted", "draft", "pharm.one"],
      ["supplier_bill.updated", "draft", "pharm.one"],
      ["supplier_bill.matched", "held_for_match", "pharm.one"],
    ]);
    const edit = t.entries[1]!.changes;
    expect(edit.map((c) => [c.field, c.before, c.after])).toEqual(expect.arrayContaining([
      ["taxablePaise", 25_000, 26_000], ["totalPaise", 28_000, 29_120],
      [`lines.${taxed}.ratePaise`, 2_500, 2_600], [`lines.${taxed}.taxablePaise`, 25_000, 26_000],
    ]));
    expect(edit.find((c) => c.field === `lines.${taxed}.ratePaise`)?.label).toBe("Item CROC · Rate");
    // The match (₹1 a strip over the GRN's cost is 4%, past the tolerance) moved the status, derived from consecutive states.
    expect(t.entries[2]!.changes.map((c) => [c.field, c.before, c.after])).toEqual(expect.arrayContaining([["status", "draft", "held_for_match"]]));

    const feed = await recentActivity(db, owner.actor, { preset: "today" }, at(200));
    expect(feed.rows.map((r) => [r.name, r.docNo])).toEqual([
      ["supplier_bill.matched", b.billNo], ["supplier_bill.updated", b.billNo], ["supplier_bill.drafted", b.billNo],
    ]);
    await expect(documentActivity(db, pharmacist.actor, b.billNo)).rejects.toMatchObject({ code: "permission_denied" });
    await expect(documentActivity(db, owner.actor, "NOPE-1")).rejects.toMatchObject({ code: "not_found" });
  });
});
