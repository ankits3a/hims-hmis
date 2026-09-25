import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { ensureRole, mkUser } from "../../../test/helpers/opd";
import { approveRequest } from "../../kernel/approvals/decisions";
import { grantPermissionToRole, syncPermissions } from "../../kernel/auth/permissions";
import { SodViolationError, seedSodPairs } from "../../kernel/auth/sod";
import { withTx } from "../../kernel/db/client";
import { approvals, events, vendors } from "../../kernel/db/schema";
import { ModuleRegistry } from "../../kernel/modules/loader";
import { ALL_MANIFESTS } from "../../kernel/modules/manifests";
import { PAYMENT_RUN_APPROVAL_TYPE, registerMaterialsApprovalTypes } from "./approval-types";
import { CASH_PAYMENT_DAILY_LIMIT_PAISE } from "./config";
import { captureGrn, postGrn, runGateQc } from "./grn";
import { registerItem } from "./items";
import {
  assertNotRunAuthoriser, cancelPaymentRun, createPaymentRun, decidePaymentRun, draftPaymentRun, getPaymentRun, planPaymentRun,
  recordVendorPayment, submitPaymentRun,
} from "./payments";
import { createPurchaseOrder, decidePurchaseOrder, submitPurchaseOrder } from "./purchase-orders";
import { createStore } from "./stores";
import {
  acceptBillDifference, acceptSupplierBill, ageBucketOf, billDraftFromGrn, cancelSupplierBill, createSupplierBill, dueDateFor,
  financialYearOf, getSupplierBill, matchSupplierBill, matchTolerancePaise, payables, supplierLedger, unbilledGrns, updateSupplierBill,
  withinMatch,
} from "./supplier-bills";
import { activateVendor, addVendorDocument, registerVendor } from "./vendors";
import type { BillDraft, BillLineInput } from "./supplier-bills";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ PHARMACY PARITY P3 — THE SUPPLIER'S BILL, THE MATCH, THE RUN AND THE PAYMENT, AGAINST THE DATABASE ═══
 *
 * Every refusal guards a DEFAULT recorded in the plan doc (the owner has not ruled) or a law:
 * a bill line within ±1% or ₹10 (the larger) of GRN × PO rate matches and one paisa more holds it;
 * one live bill per vendor, number and financial year; a held bill needs the head and a reason; an
 * MSME is due within 45 days of acceptance; a vendor in bank-change cooling-off is not paid; the
 * preparer never authorises and the authoriser never records; cash to one vendor in one day stops at
 * ₹10,000 (s.40A(3)); part payments leave the bill open; the ledger's balance is bills − payments.
 *
 * Fixtures: a strip is 10 tablets and every rate is per strip; the GRN records cost per tablet.
 */
const T0 = new Date("2026-09-24T04:30:00.000Z"); // 10:00 IST, 24 Sep 2026
const at = (minutes: number): Date => new Date(T0.getTime() + minutes * 60_000);
const DAY = 24 * 60;

describe("supplier bills, payables and payment runs (parity P3)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let head: { id: string; actor: Actor };
  let head2: { id: string; actor: Actor };
  let pharmacist: { id: string; actor: Actor };
  let keeper: { id: string; actor: Actor };
  let owner: { id: string; actor: Actor };
  let store: string;
  let vendor: string;
  let msmeVendor: string;
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
    head2 = await mkUser(db, "mat.head2", ["materials_head"]);
    pharmacist = await mkUser(db, "pharm.one", ["pharmacy"]);
    keeper = await mkUser(db, "store.keeper", ["storekeeper"]);
    owner = await mkUser(db, "the.owner", ["owner"]);
    ({ resourceId: store } = await withTx(db, (tx) => createStore(tx, head.actor, { code: "PHARM-OPD", name: "OPD pharmacy" })));
    vendor = await aVendor("ACME", { paymentTermsDays: null });
    msmeVendor = await aVendor("SMALL", { msmeClass: "micro", paymentTermsDays: 60 });
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

  /** A posted GRN of `strips` strips at `ratePerStrip`, against an approved PO at the same rate when `withPo`. */
  async function received(v: string, itemId: string, strips: number, ratePerStrip: number, opts: { withPo?: boolean; postAt?: Date } = {}): Promise<string> {
    let poId: string | null = null;
    if (opts.withPo === true) {
      const po = await createPurchaseOrder(db, pharmacist.actor, { vendorId: v, storeResourceId: store, lines: [{ itemId, qtyPacks: strips, ratePaise: ratePerStrip }] }, { now: T0 });
      await submitPurchaseOrder(db, pharmacist.actor, po.id, at(1));
      await decidePurchaseOrder(db, head.actor, po.id, "approve", "ok", at(2));
      poId = po.id;
    }
    const { grnId } = await withTx(db, (tx) => captureGrn(tx, keeper.actor, {
      vendorId: v, source: "challan", storeResourceId: store, challanNo: `CH-${String(Math.random()).slice(2, 8)}`, challanDate: "2026-09-24",
      invoiceNo: "INV/26-27/0042", purchaseOrderId: poId,
      lines: [{ itemId, uom: "strip", qtyInUom: strips, batchNo: `B-${String(Math.random()).slice(2, 6)}`, expiryDate: "2028-06-30", unitCostPaise: ratePerStrip / 10 }],
      now: at(10),
    }));
    await withTx(db, (tx) => runGateQc(tx, pharmacist.actor, grnId));
    await withTx(db, (tx) => postGrn(tx, pharmacist.actor, grnId, opts.postAt ?? at(20)));
    return grnId;
  }

  const fromDraft = (d: BillDraft, vendorBillNo: string, over: Partial<BillLineInput> = {}) => ({
    vendorId: d.vendorId, vendorBillNo, billDate: "2026-09-24", interState: d.interState,
    lines: d.lines.map((l) => ({ grnId: l.grnId, itemId: l.itemId, uom: l.uom, qtyPacks: l.qtyPacks, ratePaise: l.ratePaise, gstRateBps: l.gstRateBps, ...over })),
  });

  /** A bill entered from the agent's prefill by the pharmacist, with the line overridden as given, then matched. */
  async function billed(grnId: string, vendorBillNo: string, over: Partial<BillLineInput> = {}, by = pharmacist) {
    const d = await billDraftFromGrn(db, by.actor, grnId);
    const b = await createSupplierBill(db, by.actor, fromDraft(d, vendorBillNo, over), { source: "agent", now: at(60) });
    return matchSupplierBill(db, by.actor, b.id, at(61));
  }

  /** An accepted payable of `strips` × `ratePerStrip`, GST nil. */
  async function payable(v: string, strips: number, ratePerStrip: number, no: string): Promise<string> {
    const grn = await received(v, zero, strips, ratePerStrip);
    const b = await billed(grn, no);
    return (await acceptSupplierBill(db, pharmacist.actor, b.id, at(62))).id;
  }

  /** Head prepares and submits; the owner authorises. */
  async function authorisedRun(lines: { billId: string; payPaise: number }[]): Promise<string> {
    const run = await createPaymentRun(db, head.actor, { lines }, { now: at(100) });
    await submitPaymentRun(db, head.actor, run.id, at(101));
    await decidePaymentRun(db, owner.actor, run.id, "approve", "pay them", at(102));
    return run.id;
  }

  // ─────────────────────────────── the tolerance, pure ───────────────────────────────

  it("the tolerance is 1% of what was expected or ₹10, whichever is larger", () => {
    expect(matchTolerancePaise(250_000)).toBe(2_500); // ₹2,500 → 1% = ₹25
    expect(matchTolerancePaise(100_000)).toBe(1_000); // ₹1,000 → both ₹10
    expect(matchTolerancePaise(50_000)).toBe(1_000); // ₹500 → 1% = ₹5, the ₹10 floor wins
    expect([withinMatch(252_500, 250_000), withinMatch(252_501, 250_000), withinMatch(247_500, 250_000), withinMatch(247_499, 250_000)])
      .toEqual([true, false, true, false]);
    expect([withinMatch(51_000, 50_000), withinMatch(51_001, 50_000), withinMatch(49_000, 50_000), withinMatch(48_999, 50_000)])
      .toEqual([true, false, true, false]);
    expect([financialYearOf("2026-03-31"), financialYearOf("2026-04-01"), financialYearOf("2027-01-15")]).toEqual(["2025-26", "2026-27", "2026-27"]);
    expect([ageBucketOf(30), ageBucketOf(31), ageBucketOf(60), ageBucketOf(61), ageBucketOf(90), ageBucketOf(91)])
      .toEqual(["0_30", "31_60", "31_60", "61_90", "61_90", "90_plus"]);
  });

  // ─────────────────────────────── the three-way match ───────────────────────────────

  it("the agent's prefill is what the gate accepted at the PO's rate and GST; an unchanged bill matches", async () => {
    const grn = await received(vendor, taxed, 10, 25_000, { withPo: true });
    const d = await billDraftFromGrn(db, pharmacist.actor, grn);
    expect(d.lines.map((l) => [l.uom, l.qtyPacks, l.ratePaise, l.gstRateBps, l.expectedBase])).toEqual([["strip", 10, 25_000, 1200, 100]]);
    expect([d.vendorBillNo, d.billDate, d.poNo]).toEqual(["INV/26-27/0042", "2026-09-24", expect.stringMatching(/^MPO/)]);
    expect(d.expectedTotalPaise).toBe(250_000 + 30_000);
    const b = await billed(grn, "INV/26-27/0042");
    expect(b.status).toBe("matched");
    expect(b.billNo).toMatch(/^MSB260924\d{4}$/);
    expect([b.taxablePaise, b.cgstPaise, b.sgstPaise, b.igstPaise, b.totalPaise]).toEqual([250_000, 15_000, 15_000, 0, 280_000]);
    expect(b.lines[0]!.mismatch).toEqual([]);
    expect(await unbilledGrns(db, pharmacist.actor)).toEqual([]);
  });

  it("a line exactly 1% over or under matches; one paisa past 1% holds the bill, with the reason", async () => {
    // 10 strips at ₹250, GST nil: expected ₹2,500, tolerance ₹25 = 2,500 paise = ₹2.50 a strip.
    const up = await billed(await received(vendor, zero, 10, 25_000, { withPo: true }), "UP-1", { ratePaise: 25_250 });
    const down = await billed(await received(vendor, zero, 10, 25_000, { withPo: true }), "DN-1", { ratePaise: 24_750 });
    expect([up.status, down.status]).toEqual(["matched", "matched"]);
    expect(up.lines[0]!.mismatch).toEqual(["rate"]); // informs, does not hold
    const over = await billed(await received(vendor, zero, 10, 25_000, { withPo: true }), "UP-2", { ratePaise: 25_251 });
    expect(over.status).toBe("held_for_match");
    expect(over.lines[0]!.mismatch).toEqual(["rate", "value"]);
    expect(over.lines[0]!.differencePaise).toBe(2_510);
    expect(over.heldReason).toContain("1 line(s) outside the match");
    const matched = await db.select().from(events).where(eq(events.name, "supplier_bill.matched"));
    expect(matched.map((e) => (e.payload as { outcome: string }).outcome)).toEqual(["matched", "matched", "held_for_match"]);
  });

  it("below ₹1,000 the ₹10 floor rules: ₹10 over matches, ₹10.02 over holds", async () => {
    // 2 strips at ₹250: expected ₹500, 1% is ₹5, so ₹10 is the tolerance.
    const ok = await billed(await received(vendor, zero, 2, 25_000, { withPo: true }), "F-1", { ratePaise: 25_500 });
    const held = await billed(await received(vendor, zero, 2, 25_000, { withPo: true }), "F-2", { ratePaise: 25_501 });
    expect([ok.status, ok.lines[0]!.differencePaise]).toEqual(["matched", 1_000]);
    expect([held.status, held.lines[0]!.differencePaise]).toEqual(["held_for_match", 1_002]);
  });

  it("more billed than received, or a GST rate other than the order's, holds whatever the value", async () => {
    const qty = await billed(await received(vendor, taxed, 10, 25_000, { withPo: true }), "Q-1", { qtyPacks: 11, ratePaise: 22_727 });
    expect(qty.status).toBe("held_for_match");
    expect(qty.lines[0]!.mismatch).toContain("qty_over");
    const gst = await billed(await received(vendor, taxed, 10, 25_000, { withPo: true }), "G-1", { gstRateBps: 1800 });
    expect(gst.status).toBe("held_for_match");
    expect(gst.lines[0]!.mismatch).toEqual(["gst_rate"]);
  });

  it("a held bill is accepted only by the head, with a reason, and never by whoever entered it", async () => {
    const grn = await received(vendor, zero, 10, 25_000, { withPo: true });
    // Entered by the head this time, so the head is the maker.
    const held = await billed(grn, "H-1", { ratePaise: 26_000 }, head);
    expect(held.status).toBe("held_for_match");
    await expect(acceptSupplierBill(db, head.actor, held.id, at(70))).rejects.toMatchObject({ code: "bill_wrong_status" });
    await expect(acceptBillDifference(db, pharmacist.actor, held.id, "rate revised", at(70))).rejects.toMatchObject({ code: "permission_denied" });
    await expect(acceptBillDifference(db, head2.actor, held.id, "   ", at(70))).rejects.toMatchObject({ code: "reason_required" });
    await expect(acceptBillDifference(db, head.actor, held.id, "rate revised", at(70))).rejects.toMatchObject({ code: "bill_self_accept" });
    const ok = await acceptBillDifference(db, head2.actor, held.id, "rate revised by the vendor's circular of 20 Sep", at(70));
    expect([ok.status, ok.differenceReason, ok.differenceAcceptedBy]).toEqual(["accepted", "rate revised by the vendor's circular of 20 Sep", head2.id]);
    const accepted = await db.select().from(events).where(eq(events.name, "supplier_bill.accepted"));
    expect((accepted[0]!.payload as { differencePaise: number }).differencePaise).toBe(10_000);
  });

  it("refuses the vendor's bill number twice in one financial year — case, spaces and dashes ignored — but not across years, nor after a cancel", async () => {
    const first = await billed(await received(vendor, zero, 1, 25_000), "INV-0042");
    const g2 = await received(vendor, zero, 1, 25_000);
    const d2 = await billDraftFromGrn(db, pharmacist.actor, g2);
    await expect(createSupplierBill(db, pharmacist.actor, fromDraft(d2, "inv 0042"), { now: at(60) })).rejects.toMatchObject({ code: "duplicate_bill" });
    // Another vendor may use the same number.
    const other = await aVendor("BETA");
    const g3 = await received(other, zero, 1, 25_000);
    await expect(createSupplierBill(db, pharmacist.actor, fromDraft(await billDraftFromGrn(db, pharmacist.actor, g3), "INV-0042"), { now: at(60) })).resolves.toBeDefined();
    // Last financial year's INV-0042 is another bill.
    await expect(createSupplierBill(db, pharmacist.actor, { ...fromDraft(d2, "INV-0042"), billDate: "2026-03-20" }, { now: at(60) })).resolves.toBeDefined();
    // And once cancelled, the number is free again (the same GRN is free too).
    await cancelSupplierBill(db, pharmacist.actor, first.id, "entered against the wrong challan", at(63));
    const g4 = await received(vendor, zero, 1, 25_000);
    await expect(createSupplierBill(db, pharmacist.actor, fromDraft(await billDraftFromGrn(db, pharmacist.actor, g4), "INV-0042"), { now: at(60) })).resolves.toBeDefined();
  });

  it("a GRN is on one live bill only; an edited held bill goes back to draft and re-matches", async () => {
    const grn = await received(vendor, zero, 10, 25_000, { withPo: true });
    const d = await billDraftFromGrn(db, pharmacist.actor, grn);
    const held = await matchSupplierBill(db, pharmacist.actor, (await createSupplierBill(db, pharmacist.actor, fromDraft(d, "E-1", { ratePaise: 30_000 }), { now: at(60) })).id, at(61));
    expect(held.status).toBe("held_for_match");
    await expect(billDraftFromGrn(db, pharmacist.actor, grn)).rejects.toMatchObject({ code: "grn_already_billed" });
    await expect(createSupplierBill(db, pharmacist.actor, fromDraft(d, "E-2"), { now: at(62) })).rejects.toMatchObject({ code: "grn_already_billed" });
    const lines = held.lines.map((l) => ({ grnId: l.grnId, itemId: l.itemId, uom: l.uom, qtyPacks: l.expectedPacks, ratePaise: l.expectedRatePaise, gstRateBps: l.expectedGstRateBps }));
    const fixed = await updateSupplierBill(db, pharmacist.actor, held.id, { lines }, at(64));
    expect([fixed.status, fixed.heldReason]).toEqual(["draft", null]);
    expect((await matchSupplierBill(db, pharmacist.actor, held.id, at(65))).status).toBe("matched");
  });

  // ─────────────────────────────── due dates ───────────────────────────────

  it("an MSME is due min(terms, 45) days after acceptance — the GRN's posting day; anyone else terms after the bill date", async () => {
    expect(dueDateFor({ msme: true, termsDays: 60, billDate: "2026-09-20", acceptanceDate: "2026-09-24" })).toBe("2026-11-08");
    expect(dueDateFor({ msme: true, termsDays: 30, billDate: "2026-09-20", acceptanceDate: "2026-09-24" })).toBe("2026-10-24");
    expect(dueDateFor({ msme: true, termsDays: null, billDate: "2026-09-20", acceptanceDate: "2026-09-24" })).toBe("2026-11-08");
    expect(dueDateFor({ msme: false, termsDays: 90, billDate: "2026-09-20", acceptanceDate: "2026-09-24" })).toBe("2026-12-19");
    expect(dueDateFor({ msme: false, termsDays: null, billDate: "2026-09-20", acceptanceDate: "2026-09-24" })).toBe("2026-10-20");

    // Posted on 23 Sep at 22:00 IST: the acceptance day is 23 Sep, whatever the bill date says.
    const grn = await received(msmeVendor, zero, 10, 25_000, { postAt: new Date("2026-09-23T16:30:00.000Z") });
    const b = await billed(grn, "S-1");
    const ok = await acceptSupplierBill(db, pharmacist.actor, b.id, at(70));
    expect([ok.msme, ok.acceptanceDate, ok.dueDate]).toEqual([true, "2026-09-23", "2026-11-07"]);
    const plain = await payable(vendor, 1, 25_000, "P-1");
    expect((await getSupplierBill(db, head.actor, plain)).dueDate).toBe("2026-10-24"); // 24 Sep + 30 (the default)
  });

  // ─────────────────────────────── the payment run ───────────────────────────────

  it("the agent drafts MSME first, then the oldest due, and leaves out a vendor in cooling-off", async () => {
    const plainBill = await payable(vendor, 10, 25_000, "A-1");
    const msmeBill = await payable(msmeVendor, 10, 25_000, "M-1");
    const coolVendor = await aVendor("COOL");
    await payable(coolVendor, 10, 25_000, "C-1");
    await db.update(vendors).set({ firstPaymentAllowedAt: new Date(T0.getTime() + 60 * DAY * 60_000) }).where(eq(vendors.id, coolVendor));
    // Nothing is due within a week yet (30 and 45 days out).
    expect((await planPaymentRun(db, at(100))).groups).toEqual([]);
    const later = at(46 * DAY);
    const plan = await planPaymentRun(db, later);
    expect(plan.groups.map((g) => [g.vendorCode, g.msme, g.bills.map((b) => b.billId)])).toEqual([
      ["SMALL", true, [msmeBill]], ["ACME", false, [plainBill]],
    ]);
    expect(plan.blocked.map((g) => g.vendorCode)).toEqual(["COOL"]);
    const run = await draftPaymentRun(db, head.actor, later);
    expect([run.status, run.source, run.totalPaise, run.vendors.map((v) => v.vendorCode)]).toEqual(["draft", "agent", 500_000, ["SMALL", "ACME"]]);
    // What a draft holds is not proposed twice.
    expect((await planPaymentRun(db, later)).groups).toEqual([]);
  });

  it("the preparer never authorises — refused by the SoD engine on the sheet and by the kernel in the inbox; only the preparer submits", async () => {
    const bill = await payable(vendor, 10, 25_000, "R-1");
    const run = await createPaymentRun(db, owner.actor, { lines: [{ billId: bill, payPaise: 250_000 }] }, { now: at(100) });
    await expect(submitPaymentRun(db, head.actor, run.id, at(101))).rejects.toMatchObject({ code: "run_not_preparer" });
    const sub = await submitPaymentRun(db, owner.actor, run.id, at(101));
    const [ap] = await db.select().from(approvals).where(eq(approvals.id, sub.approvalId!));
    expect([ap?.typeKey, ap?.approverRole, ap?.amountPaise]).toEqual([PAYMENT_RUN_APPROVAL_TYPE, "owner", 250_000]);
    await expect(decidePaymentRun(db, owner.actor, run.id, "approve", "mine", at(102))).rejects.toBeInstanceOf(SodViolationError);
    await expect(approveRequest(db, owner.actor, { approvalId: sub.approvalId!, note: "mine" })).rejects.toBeDefined();
    const blocked = await db.select().from(events).where(eq(events.name, "sod.violation_blocked"));
    expect(blocked.map((e) => (e.payload as { pairKey: string }).pairKey)).toContain("payout_preparer_payout_approver");
    expect((await getPaymentRun(db, head.actor, run.id, at(103))).status).toBe("pending_authorisation");
    // The head is not the approver role either.
    await expect(decidePaymentRun(db, head.actor, run.id, "approve", "ok", at(103))).rejects.toBeDefined();
  });

  it("an owner's refusal sends the run back to draft; authorising it in the inbox is settled on the next read", async () => {
    const bill = await payable(vendor, 10, 25_000, "R-2");
    const run = await createPaymentRun(db, head.actor, { lines: [{ billId: bill, payPaise: 250_000 }] }, { now: at(100) });
    await submitPaymentRun(db, head.actor, run.id, at(101));
    const back = await decidePaymentRun(db, owner.actor, run.id, "reject", "hold till month end", at(102));
    expect([back.status, back.rejectionNote]).toEqual(["draft", "hold till month end"]);
    const again = await submitPaymentRun(db, head.actor, run.id, at(103));
    await approveRequest(db, owner.actor, { approvalId: again.approvalId!, note: "ok now" });
    const read = await getPaymentRun(db, head.actor, run.id, at(104));
    expect([read.status, read.authorisedBy]).toEqual(["authorised", owner.id]);
  });

  it("the authoriser never records the payment — SoD engine event and in-act guard", async () => {
    const bill = await payable(vendor, 10, 25_000, "R-3");
    const runId = await authorisedRun([{ billId: bill, payPaise: 250_000 }]);
    await expect(assertNotRunAuthoriser(db, owner.actor, runId)).rejects.toBeInstanceOf(SodViolationError);
    await expect(recordVendorPayment(db, owner.actor, runId, vendor, { mode: "neft", reference: "UTR1" }, at(110))).rejects.toMatchObject({ code: "authoriser_recording" });
    const blocked = await db.select().from(events).where(eq(events.name, "sod.violation_blocked"));
    expect(blocked.map((e) => (e.payload as { pairKey: string }).pairKey)).toEqual(["payment_authoriser_recorder"]);
    const paid = await recordVendorPayment(db, head.actor, runId, vendor, { mode: "neft", reference: "UTR1" }, at(110));
    expect(paid.status).toBe("completed");
    expect(paid.vendors[0]!.payment).toMatchObject({ mode: "neft", reference: "UTR1", amountPaise: 250_000, paymentNo: expect.stringMatching(/^MPV/) });
  });

  it("refuses paying a vendor in bank-change cooling-off, and a bank mode without its reference", async () => {
    const bill = await payable(vendor, 10, 25_000, "R-4");
    const runId = await authorisedRun([{ billId: bill, payPaise: 250_000 }]);
    const until = new Date(at(110).getTime() + DAY * 60_000);
    await db.update(vendors).set({ firstPaymentAllowedAt: until }).where(eq(vendors.id, vendor));
    await expect(recordVendorPayment(db, head.actor, runId, vendor, { mode: "neft", reference: null }, at(110))).rejects.toMatchObject({ code: "payment_reference_required" });
    await expect(recordVendorPayment(db, head.actor, runId, vendor, { mode: "neft", reference: "UTR9" }, at(110)))
      .rejects.toMatchObject({ code: "vendor_cooling_off", detail: { firstPaymentAllowedAt: until.toISOString() } });
    // The day after the cooling-off ends, it is paid.
    const next = new Date(until.getTime() + 60_000);
    expect((await recordVendorPayment(db, head.actor, runId, vendor, { mode: "neft", reference: "UTR9" }, next)).status).toBe("completed");
  });

  it("cash to one vendor in one day stops at ₹10,000 (s.40A(3)), summed across payments; another day is another limit", async () => {
    expect(CASH_PAYMENT_DAILY_LIMIT_PAISE).toBe(1_000_000);
    const a = await payable(vendor, 10, 60_000, "K-1"); // ₹6,000
    const b = await payable(vendor, 10, 40_000, "K-2"); // ₹4,000
    const c = await payable(vendor, 1, 1_000, "K-3"); // ₹10 — too many once the first two have used the day
    const big = await payable(vendor, 10, 100_010, "K-4"); // ₹10,001 in one go
    const r1 = await authorisedRun([{ billId: a, payPaise: 600_000 }]);
    const r2 = await authorisedRun([{ billId: b, payPaise: 400_000 }]);
    const r3 = await authorisedRun([{ billId: c, payPaise: 1_000 }]);
    const r4 = await authorisedRun([{ billId: big, payPaise: 1_000_100 }]);
    await expect(recordVendorPayment(db, head.actor, r4, vendor, { mode: "cash" }, at(110))).rejects.toMatchObject({ code: "cash_limit_exceeded" });
    await recordVendorPayment(db, head.actor, r1, vendor, { mode: "cash" }, at(110));
    await recordVendorPayment(db, head.actor, r2, vendor, { mode: "cash" }, at(110)); // exactly ₹10,000 — allowed
    await expect(recordVendorPayment(db, head.actor, r3, vendor, { mode: "cash" }, at(110)))
      .rejects.toMatchObject({ code: "cash_limit_exceeded", detail: { alreadyPaise: 1_000_000, amountPaise: 1_000 } });
    // By bank it goes; tomorrow's cash is a fresh day.
    expect((await recordVendorPayment(db, head.actor, r3, vendor, { mode: "cash" }, at(110 + DAY))).status).toBe("completed");
    expect((await recordVendorPayment(db, head.actor, r4, vendor, { mode: "rtgs", reference: "UTR-BIG" }, at(111))).status).toBe("completed");
  });

  it("part payments leave the bill part_paid; what open runs hold cannot be put on another; the rest pays it off", async () => {
    const bill = await payable(vendor, 10, 25_000, "PP-1"); // ₹2,500
    const r1 = await authorisedRun([{ billId: bill, payPaise: 100_000 }]);
    // An open run holds ₹1,000: at most ₹1,500 more may be put on another run.
    await expect(createPaymentRun(db, head.actor, { lines: [{ billId: bill, payPaise: 150_001 }] }, { now: at(105) }))
      .rejects.toMatchObject({ code: "run_invalid", detail: { availablePaise: 150_000 } });
    await recordVendorPayment(db, head.actor, r1, vendor, { mode: "cheque", reference: "000123" }, at(110));
    let b = await getSupplierBill(db, head.actor, bill);
    expect([b.status, b.paidPaise, b.outstandingPaise]).toEqual(["part_paid", 100_000, 150_000]);
    const r2 = await authorisedRun([{ billId: bill, payPaise: 150_000 }]);
    const view = await getPaymentRun(db, head.actor, r2, at(111));
    expect(view.vendors[0]!.lines.map((l) => [l.totalPaise, l.prevPaidPaise, l.creditPaise, l.payPaise, l.remainingPaise])).toEqual([[250_000, 100_000, 0, 150_000, 0]]);
    await recordVendorPayment(db, head.actor, r2, vendor, { mode: "upi", reference: "UPI-77" }, at(112));
    b = await getSupplierBill(db, head.actor, bill);
    expect([b.status, b.paidPaise, b.outstandingPaise, b.payments.length]).toEqual(["paid", 250_000, 0, 2]);
    // A paid bill is not cancelled.
    await expect(cancelSupplierBill(db, head.actor, bill, "no", at(113))).rejects.toMatchObject({ code: "bill_wrong_status" });
  });

  it("a run with nothing paid is cancelled with a reason, and frees its bills", async () => {
    const bill = await payable(vendor, 10, 25_000, "X-1");
    const run = await createPaymentRun(db, head.actor, { lines: [{ billId: bill, payPaise: 250_000 }] }, { now: at(100) });
    await expect(cancelSupplierBill(db, head.actor, bill, "wrong", at(101))).rejects.toMatchObject({ code: "bill_wrong_status" });
    expect((await cancelPaymentRun(db, head.actor, run.id, "made twice", at(101))).status).toBe("cancelled");
    await expect(createPaymentRun(db, head.actor, { lines: [{ billId: bill, payPaise: 250_000 }] }, { now: at(102) })).resolves.toBeDefined();
  });

  // ─────────────────────────────── payables and the ledger ───────────────────────────────

  it("payables age by bill date; the Supplier Summary and the ledger agree: balance = bills − payments", async () => {
    const b1 = await payable(vendor, 10, 25_000, "L-1"); // ₹2,500
    const b2 = await payable(vendor, 4, 25_000, "L-2"); // ₹1,000
    const runId = await authorisedRun([{ billId: b1, payPaise: 200_000 }]);
    await recordVendorPayment(db, head.actor, runId, vendor, { mode: "neft", reference: "UTR-L" }, at(110));

    const p = await payables(db, head.actor, at(40 * DAY));
    expect(p.bills.map((b) => [b.billNo.slice(0, 3), b.outstandingPaise, b.bucket, b.overdueDays])).toEqual([
      ["MSB", 50_000, "31_60", 10], ["MSB", 100_000, "31_60", 10],
    ]);
    expect(p.suppliers).toEqual([expect.objectContaining({ vendorCode: "ACME", totalPaise: 350_000, paidPaise: 200_000, remainingPaise: 150_000, overduePaise: 150_000 })]);
    expect(p.buckets).toEqual({ "0_30": 0, "31_60": 150_000, "61_90": 0, "90_plus": 0 });

    const l = await supplierLedger(db, head.actor, vendor);
    expect(l.entries.map((e) => [e.kind, e.creditPaise, e.debitPaise, e.balancePaise])).toEqual([
      ["bill", 250_000, 0, 250_000], ["bill", 100_000, 0, 350_000], ["payment", 0, 200_000, 150_000],
    ]);
    expect(l.closingPaise).toBe(l.billedPaise - l.paidPaise);
    expect(l.closingPaise).toBe(p.suppliers[0]!.remainingPaise);
    // A range folds the earlier entries into the opening balance.
    const tomorrow = await supplierLedger(db, head.actor, vendor, { from: "2026-09-25" });
    expect([tomorrow.openingPaise, tomorrow.entries.length, tomorrow.closingPaise]).toEqual([150_000, 0, 150_000]);
    void b2;
  });

  it("an owner who holds ONLY the approvals grants reads the run they are asked to authorise, and nothing else of the book", async () => {
    await ensureRole(db, "approver_only");
    const registry = new ModuleRegistry();
    for (const m of ALL_MANIFESTS) registry.install(m);
    for (const p of ["approvals.requests.decide", "approvals.requests.read"]) await grantPermissionToRole(db, registry, "approver_only", p);
    const bare = await mkUser(db, "bare.owner", ["approver_only"]);
    const bill = await payable(vendor, 10, 25_000, "OW-1");
    const run = await createPaymentRun(db, head.actor, { lines: [{ billId: bill, payPaise: 250_000 }] }, { now: at(100) });
    await submitPaymentRun(db, head.actor, run.id, at(101));
    const read = await getPaymentRun(db, bare.actor, run.id, at(102));
    expect([read.runNo, read.status, read.totalPaise, read.vendors[0]!.lines[0]!.payPaise]).toEqual([run.runNo, "pending_authorisation", 250_000, 250_000]);
    // Reading is not preparing or paying.
    await expect(createPaymentRun(db, bare.actor, { lines: [{ billId: bill, payPaise: 1 }] })).rejects.toMatchObject({ code: "permission_denied" });
    await expect(recordVendorPayment(db, bare.actor, run.id, vendor, { mode: "neft", reference: "U" }, at(103))).rejects.toMatchObject({ code: "permission_denied" });
  });

  it("only the grants read and act: a storekeeper reads no payables and enters no bill", async () => {
    await expect(payables(db, keeper.actor)).rejects.toMatchObject({ code: "permission_denied" });
    const grn = await received(vendor, zero, 1, 25_000);
    await expect(billDraftFromGrn(db, keeper.actor, grn)).rejects.toMatchObject({ code: "permission_denied" });
    await expect(createPaymentRun(db, pharmacist.actor, { lines: [] })).rejects.toMatchObject({ code: "permission_denied" });
  });
});
