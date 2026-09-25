import { and, eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { ensureRole, mkUser } from "../../../test/helpers/opd";
import { approveRequest, rejectRequest } from "../../kernel/approvals/decisions";
import { grantPermissionToRole, syncPermissions } from "../../kernel/auth/permissions";
import { SodViolationError, seedSodPairs } from "../../kernel/auth/sod";
import { withTx } from "../../kernel/db/client";
import { events, stockBalances, stockBatches, stockLedger, supplierPaymentRunLines } from "../../kernel/db/schema";
import { ModuleRegistry } from "../../kernel/modules/loader";
import { ALL_MANIFESTS } from "../../kernel/modules/manifests";
import { registerMaterialsApprovalTypes } from "./approval-types";
import { EXPIRY_RETURN_WINDOW_DAYS } from "./config";
import { captureGrn, postGrn, runGateQc } from "./grn";
import { registerItem } from "./items";
import { postMovement, reserveStock } from "./ledger";
import {
  cancelPaymentRun, createPaymentRun, decidePaymentRun, draftPaymentRun, planPaymentRun, recordVendorPayment, submitPaymentRun,
} from "./payments";
import { closeRecall, getRecall, raiseRecall } from "./recalls";
import { createStore } from "./stores";
import { acceptSupplierBill, billDraftFromGrn, createSupplierBill, matchSupplierBill, payables, supplierLedger, vendorCredits } from "./supplier-bills";
import {
  approveSupplierReturn, cancelVendorCredit, createSupplierReturn, dispatchSupplierReturn, draftReturnFromRecall, draftSupplierReturns,
  expiryReport, planSupplierReturns, recordVendorCredit, returnVerdict,
} from "./supplier-returns";
import { activateVendor, addVendorDocument, registerVendor } from "./vendors";
import { getWriteOff, postWriteOff, raiseWriteOff } from "./write-offs";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ PHARMACY PARITY P4 — RETURNS TO THE SUPPLIER, THE DEBIT NOTE, THE CREDIT OFFSET, DESTRUCTION, RECALL ═══
 *
 * Every refusal guards a DEFAULT recorded in the plan doc (the owner has not ruled) or a rule of the
 * ledger: an expired batch goes back until 90 days after expiry and not a day later; a near-expiry one
 * any time; never more than on hand less reserved (and frozen unless recalled) less what other live
 * documents hold; the drafter never approves and the approver never dispatches; the debit note carries
 * its GST split; a credit short of it needs a reason and the head; an accepted credit is spent by the
 * next payment run and the ledger's balance is bills − payments − credits; a write-off destroys nothing
 * before the medical superintendent grants it; a recalled batch leaves only for its supplier or the
 * incinerator.
 *
 * Fixtures: a strip is 10 tablets; the GRN records ₹2.50 a tablet (₹25 a strip); batches expire
 * 2027-06-30, so 2027-04-01 … 2027-06-30 is near expiry and 2027-09-28 is the last returnable day.
 */
const T0 = new Date("2026-09-24T04:30:00.000Z"); // 10:00 IST, 24 Sep 2026
const at = (minutes: number): Date => new Date(T0.getTime() + minutes * 60_000);
/** Noon IST on an IST calendar date. */
const ist = (day: string): Date => new Date(`${day}T06:30:00.000Z`);
const EXPIRY = "2027-06-30";
const NEAR = ist("2027-05-15");
const EXPIRED = ist("2027-08-01");
const EDGE = ist("2027-09-28"); // expiry + 90
const PAST = ist("2027-09-29");

describe("returns to the supplier, credit notes, write-offs and recalls (parity P4)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let head: { id: string; actor: Actor };
  let pharmacist: { id: string; actor: Actor };
  let keeper: { id: string; actor: Actor };
  let owner: { id: string; actor: Actor };
  let ms: { id: string; actor: Actor };
  let incharge: { id: string; actor: Actor };
  let store: string;
  let main: string;
  let vendor: string;
  let outOfState: string;
  let opening: string;
  let taxed: string; // GST 12%

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
        "materials.po.raise", "materials.stock.read", "materials.grn.capture", "materials.grn.qc", "materials.items.manage", "materials.vendors.manage",
        "approvals.requests.decide", "approvals.requests.read", "materials.bills.manage", "materials.bills.accept_difference",
        "materials.payments.prepare", "materials.payments.record", "materials.returns.manage", "materials.returns.approve",
        "materials.writeoffs.manage", "materials.recall.manage",
      ],
      pharmacy: ["materials.stock.read", "materials.grn.qc", "materials.bills.manage", "materials.returns.manage"],
      storekeeper: ["materials.stock.read", "materials.grn.capture"],
      owner: ["approvals.requests.decide", "approvals.requests.read"],
      medical_superintendent: ["approvals.requests.decide", "approvals.requests.read"],
      pharmacy_incharge: ["materials.writeoffs.manage", "materials.recall.manage", "materials.stock.read"],
    };
    for (const [role, perms] of Object.entries(grants)) for (const p of perms) await grantPermissionToRole(db, registry, role, p);
    head = await mkUser(db, "mat.head", ["materials_head"]);
    pharmacist = await mkUser(db, "pharm.one", ["pharmacy"]);
    keeper = await mkUser(db, "store.keeper", ["storekeeper"]);
    owner = await mkUser(db, "the.owner", ["owner"]);
    ms = await mkUser(db, "the.ms", ["medical_superintendent"]);
    incharge = await mkUser(db, "pharm.incharge", ["pharmacy_incharge"]);
    ({ resourceId: store } = await withTx(db, (tx) => createStore(tx, head.actor, { code: "PHARM-OPD", name: "OPD pharmacy" })));
    ({ resourceId: main } = await withTx(db, (tx) => createStore(tx, head.actor, { code: "MAIN", name: "Main store" })));
    vendor = await aVendor("ACME", "10AAACA1234A1Z5");
    outOfState = await aVendor("DELHI", "07AAACD1234A1Z5");
    opening = await aVendor("OPENING-STOCK", null, "OPENING STOCK");
    taxed = await anItem("CROC", 1200);
  });

  async function aVendor(code: string, gstin: string | null, tradeName?: string): Promise<string> {
    const { vendorId } = await withTx(db, (tx) => registerVendor(tx, head.actor, { code, legalName: `${code} Pharma Pvt Ltd`, gstin, ...(tradeName === undefined ? {} : { tradeName }) }));
    await withTx(db, (tx) => addVendorDocument(tx, head.actor, vendorId, { type: "gst_certificate", number: "g" }));
    await withTx(db, (tx) => addVendorDocument(tx, head.actor, vendorId, { type: "pan", number: "p" }));
    await withTx(db, (tx) => activateVendor(tx, head.actor, vendorId, T0));
    return vendorId;
  }

  async function anItem(code: string, gstRateBps: number): Promise<string> {
    const { itemId } = await withTx(db, (tx) => registerItem(tx, head.actor, {
      code, name: `Item ${code}`, class: "consumable", baseUom: "tablet", batchTracked: true, gstRateBps, hsnCode: "30049099",
      uoms: [{ uom: "strip", toBaseMultiplier: 10, isPurchaseUom: true }],
    }));
    return itemId;
  }

  /** A posted GRN of `strips` strips at ₹25 a strip into `into`; returns the GRN and the batch. */
  async function received(v: string, strips: number, opts: { batchNo?: string; into?: string; expiry?: string } = {}): Promise<{ grnId: string; batchId: string }> {
    const batchNo = opts.batchNo ?? `B-${String(Math.random()).slice(2, 7)}`;
    const { grnId } = await withTx(db, (tx) => captureGrn(tx, keeper.actor, {
      vendorId: v, source: "challan", storeResourceId: opts.into ?? store, challanNo: `CH-${String(Math.random()).slice(2, 8)}`, challanDate: "2026-09-24",
      invoiceNo: `INV-${String(Math.random()).slice(2, 6)}`,
      lines: [{ itemId: taxed, uom: "strip", qtyInUom: strips, batchNo, expiryDate: opts.expiry ?? EXPIRY, unitCostPaise: 250 }],
      now: at(10),
    }));
    await withTx(db, (tx) => runGateQc(tx, pharmacist.actor, grnId));
    await withTx(db, (tx) => postGrn(tx, pharmacist.actor, grnId, at(20)));
    const [batch] = await db.select().from(stockBatches).where(and(eq(stockBatches.itemId, taxed), eq(stockBatches.batchNo, batchNo)));
    return { grnId, batchId: batch!.id };
  }

  const onHand = async (resourceId: string, batchId: string): Promise<{ onHand: number; frozen: number }> => {
    const [b] = await db.select().from(stockBalances).where(and(eq(stockBalances.resourceId, resourceId), eq(stockBalances.batchId, batchId)));
    return { onHand: b?.qtyOnHand ?? 0, frozen: b?.qtyFrozen ?? 0 };
  };

  /** A draft return of `qty` of the batch at the OPD store, by the pharmacist. */
  const draft = (batchId: string, qty: number, reason: "expired" | "near_expiry" | "damaged" | "recalled", now: Date, v = vendor, opts: { hospitalStateCode?: string } = {}) =>
    createSupplierReturn(db, pharmacist.actor, { vendorId: v, lines: [{ batchId, storeResourceId: store, qtyBase: qty, reason }] }, { now, ...opts });

  // ─────────────────────────────── the window, pure ───────────────────────────────

  it("the return window: near expiry any time; expired until expiry + 90 days, inclusive; recalled whatever the date", () => {
    const v = (today: string, recalled = false, windowDays = EXPIRY_RETURN_WINDOW_DAYS) => returnVerdict({ expiryDate: EXPIRY, windowDays, recalled, today });
    expect(v("2027-03-31")).toMatchObject({ reason: null, returnable: false }); // 91 days out: sold, not returned
    expect(v("2027-04-01")).toMatchObject({ reason: "near_expiry", returnable: true });
    expect(v("2027-06-30")).toMatchObject({ reason: "near_expiry", returnable: true }); // the expiry date is the last day of use
    expect(v("2027-07-01")).toMatchObject({ reason: "expired", returnable: true, until: "2027-09-28" });
    expect(v("2027-09-28")).toMatchObject({ reason: "expired", returnable: true, pastWindow: false });
    expect(v("2027-09-29")).toMatchObject({ reason: "expired", returnable: false, pastWindow: true });
    expect(v("2029-01-01", true)).toMatchObject({ reason: "recalled", returnable: true });
    // A vendor's own window overrides the default.
    expect(v("2027-07-30", false, 30)).toMatchObject({ returnable: true, until: "2027-07-30" });
    expect(v("2027-07-31", false, 30)).toMatchObject({ returnable: false, pastWindow: true });
  });

  // ─────────────────────────────── the expiry report ───────────────────────────────

  it("the expiry report: presets, the supplier-wise sums, OPENING STOCK as such, the return window and the 'return raised' flag", async () => {
    const { batchId } = await received(vendor, 10);
    await received(opening, 5, { batchNo: "OPEN-1" });
    await received(vendor, 3, { batchNo: "LATER-1", expiry: "2028-12-31" });
    const r90 = await expiryReport(db, pharmacist.actor, { preset: "90" }, NEAR);
    expect(r90.rows.map((r) => [r.batchNo === "OPEN-1" ? "OPEN-1" : "ACME", r.qtyBase, r.packs, r.loose, r.costValuePaise, r.supplierKind]).sort()).toEqual([
      ["ACME", 100, 10, 0, 25_000, "supplier"], ["OPEN-1", 50, 5, 0, 12_500, "opening"],
    ]);
    expect(r90.rows).toHaveLength(2); // the 2028 batch is outside 90 days
    const acme = r90.rows.find((r) => r.batchId === batchId)!;
    expect([acme.returnable, acme.returnableUntil, acme.daysToExpiry, acme.returnRaised]).toEqual([true, "2027-09-28", 46, null]);
    const own = r90.rows.find((r) => r.batchNo === "OPEN-1")!;
    expect([own.returnable, own.returnableUntil, own.supplierName]).toEqual([false, null, "OPENING STOCK"]);
    // Supplier-wise: the supplier first, the hospital's own stock after it.
    expect(r90.suppliers.map((s) => [s.supplierKind, s.rows, s.costValuePaise, s.returnableValuePaise])).toEqual([
      ["supplier", 1, 25_000, 25_000], ["opening", 1, 12_500, 0],
    ]);
    expect((await expiryReport(db, pharmacist.actor, { preset: "expired" }, NEAR)).rows).toHaveLength(0);
    expect((await expiryReport(db, pharmacist.actor, { preset: "expired" }, EXPIRED)).rows).toHaveLength(2);
    expect((await expiryReport(db, pharmacist.actor, { preset: "custom", from: "2028-01-01", to: "2028-12-31" }, NEAR)).rows.map((r) => r.batchNo)).toEqual(["LATER-1"]);
    await expect(expiryReport(db, pharmacist.actor, { preset: "custom", from: "2028-12-31", to: "2028-01-01" }, NEAR)).rejects.toMatchObject({ code: "return_invalid" });
    // The flag Healthray calls "Credit Note Created".
    const ret = await draft(batchId, 40, "near_expiry", NEAR);
    const after = (await expiryReport(db, pharmacist.actor, { preset: "90" }, NEAR)).rows.find((r) => r.batchId === batchId)!;
    expect(after.returnRaised).toEqual({ returnId: ret.id, returnNo: ret.returnNo, status: "draft" });
  });

  // ─────────────────────────────── the agent's drafts ───────────────────────────────

  it("the agent drafts one return per vendor — expired within the window and near expiry — and lists the rest to destroy", async () => {
    await received(vendor, 10, { batchNo: "ACME-EXP" });
    await received(outOfState, 4, { batchNo: "DEL-EXP" });
    await received(opening, 5, { batchNo: "OPEN-1" });
    const plan = await planSupplierReturns(db, EXPIRED);
    expect(plan.groups.map((g) => [g.vendorCode, g.lines.map((l) => [l.batchNo, l.reason, l.qtyBase, l.ratePaise, l.gstRateBps, l.returnableUntil])])).toEqual([
      ["ACME", [["ACME-EXP", "expired", 100, 250, 1200, "2027-09-28"]]],
      ["DELHI", [["DEL-EXP", "expired", 40, 250, 1200, "2027-09-28"]]],
    ]);
    expect(plan.toDestroy.map((d) => [d.batchNo, d.why])).toEqual([["OPEN-1", "no_supplier"]]);
    // Past the window, the vendor's stock moves to the destroy list too.
    expect((await planSupplierReturns(db, PAST)).toDestroy.map((d) => d.why).sort()).toEqual(["no_supplier", "past_window", "past_window"]);
    const made = await draftSupplierReturns(db, pharmacist.actor, EXPIRED, { hospitalStateCode: "10" });
    expect(made.map((r) => [r.vendorCode, r.status, r.source, r.interState, r.returnNo.slice(0, 3)])).toEqual([
      ["ACME", "draft", "agent", false, "MRT"], ["DELHI", "draft", "agent", true, "MRT"],
    ]);
    // ₹2.50 × 100 = ₹250.00 taxable; 12% = ₹30.00 → CGST ₹15 + SGST ₹15 (intra-state); the Delhi vendor's ₹12 is IGST.
    expect([made[0]!.taxablePaise, made[0]!.cgstPaise, made[0]!.sgstPaise, made[0]!.igstPaise, made[0]!.totalPaise]).toEqual([25_000, 1_500, 1_500, 0, 28_000]);
    expect([made[1]!.taxablePaise, made[1]!.cgstPaise, made[1]!.sgstPaise, made[1]!.igstPaise, made[1]!.totalPaise]).toEqual([10_000, 0, 0, 1_200, 11_200]);
    // Nothing is drafted twice: the plan now holds nothing.
    const again = await planSupplierReturns(db, EXPIRED);
    expect([again.groups.length, again.alreadyHeld]).toEqual([0, 2]);
    await expect(draftSupplierReturns(db, pharmacist.actor, EXPIRED)).rejects.toMatchObject({ code: "return_invalid" });
    expect((await db.select().from(events).where(eq(events.name, "supplier_return.drafted"))).length).toBe(2);
  });

  // ─────────────────────────────── the edges ───────────────────────────────

  it("an expired batch goes back on the window's last day and is refused the day after; near expiry is refused before 90 days", async () => {
    const { batchId } = await received(vendor, 10);
    const edge = await draft(batchId, 10, "expired", EDGE);
    expect(edge.status).toBe("draft");
    await expect(draft(batchId, 10, "expired", PAST)).rejects.toMatchObject({ code: "return_window_passed", detail: { returnableUntil: "2027-09-28" } });
    await expect(draft(batchId, 10, "expired", NEAR)).rejects.toMatchObject({ code: "return_invalid" }); // not expired yet
    await expect(draft(batchId, 10, "near_expiry", ist("2027-03-31"))).rejects.toMatchObject({ code: "return_invalid" });
    // Approving a day late re-asks the window.
    await expect(approveSupplierReturn(db, head.actor, edge.id, PAST)).rejects.toMatchObject({ code: "return_window_passed" });
    // The hospital's own opening stock has nobody to go back to.
    const own = await received(opening, 1, { batchNo: "OPEN-2" });
    await expect(draft(own.batchId, 5, "expired", EXPIRED, opening)).rejects.toMatchObject({ code: "not_returnable" });
    // Another vendor's batch is refused on this vendor's return.
    await expect(draft(batchId, 5, "expired", EXPIRED, outOfState)).rejects.toMatchObject({ code: "return_invalid" });
  });

  it("never more than on hand, less what is reserved, less what another live return holds", async () => {
    const { batchId } = await received(vendor, 10);
    await expect(draft(batchId, 101, "expired", EXPIRED)).rejects.toMatchObject({ code: "insufficient_stock", detail: { available: 100 } });
    await withTx(db, (tx) => reserveStock(tx, pharmacist.actor, { resourceId: store, batchId, qty: 30, refType: "test_pick", refId: "pick-1" }));
    await expect(draft(batchId, 71, "expired", EXPIRED)).rejects.toMatchObject({ code: "insufficient_stock", detail: { reserved: 30, available: 70 } });
    await draft(batchId, 50, "expired", EXPIRED);
    await expect(draft(batchId, 21, "expired", EXPIRED)).rejects.toMatchObject({ code: "insufficient_stock", detail: { onOtherDocuments: 50, available: 20 } });
    expect((await draft(batchId, 20, "damaged", EXPIRED)).lines[0]!.qtyBase).toBe(20);
  });

  // ─────────────────────────────── approve, dispatch, the debit note ───────────────────────────────

  it("the drafter never approves, the approver never dispatches; dispatch moves the stock out and issues the debit note", async () => {
    const { batchId } = await received(vendor, 10);
    const r = await draft(batchId, 40, "expired", EXPIRED);
    await expect(approveSupplierReturn(db, pharmacist.actor, r.id, EXPIRED)).rejects.toMatchObject({ code: "permission_denied" });
    const byHead = await createSupplierReturn(db, head.actor, { vendorId: vendor, lines: [{ batchId, storeResourceId: store, qtyBase: 10, reason: "expired" }] }, { now: EXPIRED });
    await expect(approveSupplierReturn(db, head.actor, byHead.id, EXPIRED)).rejects.toBeInstanceOf(SodViolationError);
    const approved = await approveSupplierReturn(db, head.actor, r.id, EXPIRED);
    expect([approved.status, approved.approvedBy]).toEqual(["approved", head.id]);
    await expect(dispatchSupplierReturn(db, head.actor, r.id, EXPIRED)).rejects.toBeInstanceOf(SodViolationError);
    const blocked = await db.select().from(events).where(eq(events.name, "sod.violation_blocked"));
    expect(blocked.map((e) => (e.payload as { pairKey: string }).pairKey).sort()).toEqual(["requester_approver", "return_approver_dispatcher"]);
    expect((await onHand(store, batchId)).onHand).toBe(100); // nothing moved on a refusal
    const sent = await dispatchSupplierReturn(db, pharmacist.actor, r.id, EXPIRED);
    expect([sent.status, sent.debitNoteNo?.slice(0, 9), sent.debitNoteDate, sent.vendorGstin]).toEqual(["dispatched", "MDN270801", "2027-08-01", "10AAACA1234A1Z5"]);
    // 40 × ₹2.50 = ₹100.00; 12% = ₹12.00, CGST ₹6 + SGST ₹6: the input-GST reversal.
    expect([sent.taxablePaise, sent.cgstPaise, sent.sgstPaise, sent.igstPaise, sent.totalPaise]).toEqual([10_000, 600, 600, 0, 11_200]);
    expect(sent.lines.map((l) => [l.qtyBase, l.ratePaise, l.gstRateBps, l.hsnCode, l.ledgerEntryId !== null])).toEqual([[40, 250, 1200, "30049099", true]]);
    expect((await onHand(store, batchId)).onHand).toBe(60);
    const rows = await db.select().from(stockLedger).where(and(eq(stockLedger.refType, "supplier_return"), eq(stockLedger.batchId, batchId)));
    expect(rows.map((x) => [x.reason, x.qtyDelta])).toEqual([["return", -40]]);
    await expect(dispatchSupplierReturn(db, pharmacist.actor, r.id, EXPIRED)).rejects.toMatchObject({ code: "return_wrong_status" });
  });

  // ─────────────────────────────── the vendor's credit ───────────────────────────────

  async function dispatched(qty: number, now = EXPIRED): Promise<{ returnId: string; batchId: string; total: number }> {
    const { batchId } = await received(vendor, 10);
    const r = await draft(batchId, qty, "expired", now);
    await approveSupplierReturn(db, head.actor, r.id, now);
    const sent = await dispatchSupplierReturn(db, pharmacist.actor, r.id, now);
    return { returnId: r.id, batchId, total: sent.totalPaise };
  }

  it("a credit may not pass the debit note; a short one needs its reason and the head", async () => {
    const { returnId, total } = await dispatched(40);
    const base = { vendorCreditNoteNo: "CN/27/118", creditNoteDate: "2027-08-01" };
    await expect(recordVendorCredit(db, pharmacist.actor, returnId, { ...base, amountPaise: total + 1 }, EXPIRED)).rejects.toMatchObject({ code: "credit_invalid" });
    await expect(recordVendorCredit(db, pharmacist.actor, returnId, { ...base, amountPaise: total - 1_000 }, EXPIRED)).rejects.toMatchObject({ code: "credit_invalid" });
    await expect(recordVendorCredit(db, pharmacist.actor, returnId, { ...base, amountPaise: total - 1_000, differenceReason: "10% handling" }, EXPIRED))
      .rejects.toMatchObject({ code: "permission_denied" });
    await expect(recordVendorCredit(db, pharmacist.actor, returnId, { ...base, creditNoteDate: "2027-08-02", amountPaise: total }, EXPIRED)).rejects.toMatchObject({ code: "credit_invalid" });
    const short = await recordVendorCredit(db, head.actor, returnId, { ...base, amountPaise: total - 1_000, differenceReason: "10% handling" }, EXPIRED);
    expect([short.status, short.creditedPaise, short.credit?.differencePaise, short.credit?.differenceReason, short.credit?.creditNo.slice(0, 3)])
      .toEqual(["credited", total - 1_000, 1_000, "10% handling", "MCN"]);
    // The full credit, by the pharmacist, needs no reason.
    const full = await dispatched(20);
    expect((await recordVendorCredit(db, pharmacist.actor, full.returnId, { ...base, vendorCreditNoteNo: "CN/27/119", amountPaise: full.total }, EXPIRED)).credit?.differencePaise).toBe(0);
    expect((await vendorCredits(db, [vendor])).get(vendor)).toEqual({ acceptedPaise: total - 1_000 + full.total, appliedPaise: 0, reservedPaise: 0, availablePaise: total - 1_000 + full.total });
  });

  it("the accepted credit offsets the next payment run (Payable = Total − Credit), and the ledger's balance is bills − payments − credits", async () => {
    // A payable of ₹280: the GRN billed at ₹25 a strip + 12%, due 30 days after 24 Sep 2026.
    const { grnId, batchId } = await received(vendor, 10);
    const d = await billDraftFromGrn(db, pharmacist.actor, grnId);
    const bill = await createSupplierBill(db, pharmacist.actor, {
      vendorId: vendor, vendorBillNo: "INV-900", billDate: "2026-09-24", interState: d.interState,
      lines: d.lines.map((l) => ({ grnId: l.grnId, itemId: l.itemId, uom: l.uom, qtyPacks: l.qtyPacks, ratePaise: l.ratePaise, gstRateBps: l.gstRateBps })),
    }, { source: "agent", now: at(60) });
    await matchSupplierBill(db, pharmacist.actor, bill.id, at(61));
    await acceptSupplierBill(db, pharmacist.actor, bill.id, at(62));
    // 40 tablets of that batch go back; the vendor credits ₹112 in full.
    const r = await draft(batchId, 40, "expired", EXPIRED);
    await approveSupplierReturn(db, head.actor, r.id, EXPIRED);
    const sent = await dispatchSupplierReturn(db, pharmacist.actor, r.id, EXPIRED);
    await recordVendorCredit(db, pharmacist.actor, r.id, { vendorCreditNoteNo: "CN-1", creditNoteDate: "2027-08-01", amountPaise: sent.totalPaise }, EXPIRED);
    const credit = sent.totalPaise; // 11,200

    // Before any payment: the ledger nets the credit; the Supplier Summary says the same.
    const before = await supplierLedger(db, head.actor, vendor);
    expect(before.entries.map((e) => [e.kind, e.creditPaise, e.debitPaise, e.memoPaise])).toEqual([
      ["bill", 28_000, 0, 0], ["debit_note", 0, 0, credit], ["credit_note", 0, credit, 0],
    ]);
    expect(before.closingPaise).toBe(28_000 - credit);
    const sum0 = (await payables(db, head.actor, EXPIRED)).suppliers.find((s) => s.vendorId === vendor)!;
    expect([sum0.remainingPaise, sum0.creditPaise, sum0.netPaise]).toEqual([28_000, credit, before.closingPaise]);

    // The agent's run sets the credit against the bill: pay ₹168, credit ₹112.
    const plan = await planPaymentRun(db, EXPIRED);
    expect(plan.groups.map((g) => [g.vendorCode, g.totalPaise, g.creditPaise, g.bills.map((b) => [b.owedPaise, b.creditPaise, b.payablePaise])])).toEqual([
      ["ACME", 28_000 - credit, credit, [[28_000, credit, 28_000 - credit]]],
    ]);
    const run = await draftPaymentRun(db, head.actor, EXPIRED);
    expect(run.vendors.map((v) => [v.payPaise, v.creditPaise, v.lines.map((l) => [l.payPaise, l.creditPaise, l.remainingPaise])])).toEqual([
      [28_000 - credit, credit, [[28_000 - credit, credit, 0]]],
    ]);
    expect(run.totalPaise).toBe(28_000 - credit); // the money that leaves
    expect((await vendorCredits(db, [vendor])).get(vendor)).toMatchObject({ reservedPaise: credit, availablePaise: 0 });
    // A second run cannot spend the same credit.
    await expect(createPaymentRun(db, head.actor, { lines: [{ billId: bill.id, payPaise: 1, creditPaise: 1 }] }, { now: EXPIRED })).rejects.toMatchObject({ code: "run_invalid" });
    // …and the credit note cannot be cancelled while a run holds it.
    await expect(cancelVendorCredit(db, pharmacist.actor, r.id, "typed wrong", EXPIRED)).rejects.toMatchObject({ code: "credit_spent" });

    await submitPaymentRun(db, head.actor, run.id, EXPIRED);
    await decidePaymentRun(db, owner.actor, run.id, "approve", "pay", EXPIRED);
    const paid = await recordVendorPayment(db, head.actor, run.id, vendor, { mode: "neft", reference: "UTR1", paidOn: "2027-08-01" }, EXPIRED);
    expect(paid.status).toBe("completed");
    const line = (await db.select().from(supplierPaymentRunLines).where(eq(supplierPaymentRunLines.runId, run.id)))[0]!;
    expect([line.payPaise, line.creditPaise, line.paymentId !== null]).toEqual([28_000 - credit, credit, true]);

    const after = await supplierLedger(db, head.actor, vendor);
    expect([after.billedPaise, after.paidPaise, after.creditedPaise, after.closingPaise]).toEqual([28_000, 28_000 - credit, credit, 0]);
    expect(after.closingPaise).toBe(after.billedPaise - after.paidPaise - after.creditedPaise);
    const book = await payables(db, head.actor, EXPIRED);
    expect(book.bills.filter((b) => b.vendorId === vendor)).toEqual([]); // paid in full: pay + credit
    const sum1 = book.suppliers.find((s) => s.vendorId === vendor)!;
    expect([sum1.remainingPaise, sum1.creditPaise, sum1.netPaise]).toEqual([0, 0, 0]);
    expect((await vendorCredits(db, [vendor])).get(vendor)).toMatchObject({ appliedPaise: credit, availablePaise: 0 });
  });

  it("a vendor whose credit covers all it is owed is left off the run; a cancelled run releases the credit", async () => {
    // A ₹280 bill and a ₹280 credit: nothing to pay.
    const { grnId } = await received(vendor, 1);
    const d = await billDraftFromGrn(db, pharmacist.actor, grnId);
    const bill = await createSupplierBill(db, pharmacist.actor, {
      vendorId: vendor, vendorBillNo: "INV-901", billDate: "2026-09-24", interState: false,
      lines: d.lines.map((l) => ({ grnId: l.grnId, itemId: l.itemId, uom: l.uom, qtyPacks: l.qtyPacks, ratePaise: l.ratePaise, gstRateBps: l.gstRateBps })),
    }, { now: at(60) });
    await matchSupplierBill(db, pharmacist.actor, bill.id, at(61));
    await acceptSupplierBill(db, pharmacist.actor, bill.id, at(62));
    const more = await received(vendor, 10);
    const r = await draft(more.batchId, 100, "expired", EXPIRED);
    await approveSupplierReturn(db, head.actor, r.id, EXPIRED);
    const sent = await dispatchSupplierReturn(db, pharmacist.actor, r.id, EXPIRED);
    await recordVendorCredit(db, pharmacist.actor, r.id, { vendorCreditNoteNo: "CN-2", creditNoteDate: "2027-08-01", amountPaise: sent.totalPaise }, EXPIRED);
    const plan = await planPaymentRun(db, EXPIRED);
    expect(plan.groups).toEqual([]);
    expect(plan.coveredByCredit.map((g) => [g.vendorCode, g.totalPaise, g.creditPaise])).toEqual([["ACME", 0, 2_800]]);
    await expect(createPaymentRun(db, head.actor, { lines: [{ billId: bill.id, payPaise: 0, creditPaise: 2_800 }] }, { now: EXPIRED })).rejects.toMatchObject({ code: "run_invalid" });
    // Part of the credit on a paid run: reserved, then released by the cancel.
    const run = await createPaymentRun(db, head.actor, { lines: [{ billId: bill.id, payPaise: 1_000, creditPaise: 1_800 }] }, { now: EXPIRED });
    expect((await vendorCredits(db, [vendor])).get(vendor)?.availablePaise).toBe(sent.totalPaise - 1_800);
    await cancelPaymentRun(db, head.actor, run.id, "wrong split", EXPIRED);
    expect((await vendorCredits(db, [vendor])).get(vendor)?.availablePaise).toBe(sent.totalPaise);
    // Now nothing holds it: the credit note can be cancelled, and the return is back to dispatched.
    const back = await cancelVendorCredit(db, pharmacist.actor, r.id, "typed the wrong amount", EXPIRED);
    expect([back.status, back.creditedPaise, back.credit]).toEqual(["dispatched", 0, null]);
  });

  // ─────────────────────────────── destruction ───────────────────────────────

  it("a write-off destroys nothing before the medical superintendent grants it, and posts an adjust out with its BMW manifest", async () => {
    const { batchId } = await received(vendor, 10);
    await expect(raiseWriteOff(db, incharge.actor, { storeResourceId: store, reason: "expiry", lines: [{ batchId, qtyBase: 10 }] }, NEAR))
      .rejects.toMatchObject({ code: "writeoff_invalid" }); // not expired yet
    await expect(raiseWriteOff(db, pharmacist.actor, { storeResourceId: store, reason: "expiry", lines: [{ batchId, qtyBase: 10 }] }, PAST))
      .rejects.toMatchObject({ code: "permission_denied" });
    await expect(raiseWriteOff(db, incharge.actor, { storeResourceId: store, reason: "expiry", lines: [{ batchId, qtyBase: 101 }] }, PAST))
      .rejects.toMatchObject({ code: "insufficient_stock" });
    const w = await raiseWriteOff(db, incharge.actor, { storeResourceId: store, reason: "expiry", lines: [{ batchId, qtyBase: 60 }] }, PAST);
    expect([w.status, w.writeOffNo.slice(0, 3), w.totalValuePaise, w.approvalStatus, w.approval?.approverRole]).toEqual(["requested", "MWO", 15_000, "pending", "medical_superintendent"]);
    // A write-off holds its stock against a return, as a return holds it against a write-off.
    await expect(draft(batchId, 41, "damaged", PAST)).rejects.toMatchObject({ code: "insufficient_stock", detail: { onOtherDocuments: 60 } });
    await expect(postWriteOff(db, incharge.actor, w.id, { disposalAgency: "BioCare CBWTF", manifestNo: "M-77", disposalDate: "2027-09-29" }, PAST))
      .rejects.toMatchObject({ code: "writeoff_unapproved" });
    expect((await onHand(store, batchId)).onHand).toBe(100);
    await approveRequest(db, ms.actor, { approvalId: w.approvalId, note: "condemned" });
    await expect(postWriteOff(db, incharge.actor, w.id, {}, PAST)).rejects.toMatchObject({ code: "disposal_required" });
    const posted = await postWriteOff(db, incharge.actor, w.id, { disposalAgency: "BioCare CBWTF", manifestNo: "M-77", disposalDate: "2027-09-29" }, PAST);
    expect([posted.status, posted.disposalAgency, posted.manifestNo, posted.disposalDate, posted.lines[0]!.ledgerEntryId !== null]).toEqual(["posted", "BioCare CBWTF", "M-77", "2027-09-29", true]);
    expect((await onHand(store, batchId)).onHand).toBe(40);
    const rows = await db.select().from(stockLedger).where(eq(stockLedger.refType, "stock_write_off"));
    expect(rows.map((x) => [x.reason, x.qtyDelta])).toEqual([["adjust", -60]]);
    // A refused one moves nothing and says so.
    const w2 = await raiseWriteOff(db, incharge.actor, { storeResourceId: store, reason: "expiry", lines: [{ batchId, qtyBase: 40 }] }, PAST);
    await rejectRequest(db, ms.actor, { approvalId: w2.approvalId, note: "return it instead" });
    expect((await getWriteOff(db, incharge.actor, w2.id, PAST)).status).toBe("refused");
    expect((await onHand(store, batchId)).onHand).toBe(40);
    expect((await db.select().from(events).where(eq(events.name, "stock_write_off.refused"))).length).toBe(1);
  });

  // ─────────────────────────────── recall ───────────────────────────────

  it("a recall freezes the batch everywhere; one tap drafts its return; only the return (or destruction) takes the frozen stock out", async () => {
    const { batchId } = await received(vendor, 10, { batchNo: "RC-1" });
    await received(vendor, 5, { batchNo: "RC-1", into: main });
    // Five tablets were dispensed to a patient before the alert.
    await withTx(db, (tx) => postMovement(tx, pharmacist.actor, {
      resourceId: store, batchId, qtyDelta: -5, reason: "consume", patientId: "patient-1", encounterId: "V2610010001", occurredAt: at(100),
    }));
    const { recall, locations } = await raiseRecall(db, incharge.actor, { batchId, source: "cdsco", reference: "CDSCO/NSQ/2027/08", reason: "not of standard quality" }, EXPIRED);
    expect([recall.recallNo.slice(0, 3), recall.source, recall.status, recall.onHand]).toEqual(["MRC", "cdsco", "open", 145]);
    expect(locations.map((l) => l.qtyFrozen).sort((a, b) => a - b)).toEqual([50, 95]);
    expect(recall.dispensed.map((d) => [d.patientId, d.encounterId, d.qtyBase])).toEqual([["patient-1", "V2610010001", 5]]);
    await expect(raiseRecall(db, incharge.actor, { batchId, reason: "again" }, EXPIRED)).rejects.toMatchObject({ code: "recall_open" });
    // The guard is not weakened: an issue, or a flagged exit that is not a return or destruction, still refuses.
    await expect(withTx(db, (tx) => postMovement(tx, pharmacist.actor, { resourceId: store, batchId, qtyDelta: -1, reason: "consume", occurredAt: EXPIRED, recallExit: true })))
      .rejects.toMatchObject({ code: "batch_frozen" });
    const r = await draftReturnFromRecall(db, pharmacist.actor, recall.id, EXPIRED);
    expect([r.source, r.recallId, r.recallNo, r.lines.map((l) => [l.storeCode, l.reason, l.qtyBase]).sort()]).toEqual([
      "recall", recall.id, recall.recallNo, [["MAIN", "recalled", 50], ["PHARM-OPD", "recalled", 95]],
    ]);
    await expect(closeRecall(db, incharge.actor, recall.id, "done", EXPIRED)).rejects.toMatchObject({ code: "recall_stock_remaining" });
    await approveSupplierReturn(db, head.actor, r.id, EXPIRED);
    await dispatchSupplierReturn(db, pharmacist.actor, r.id, EXPIRED);
    expect(await onHand(store, batchId)).toEqual({ onHand: 0, frozen: 0 });
    expect(await onHand(main, batchId)).toEqual({ onHand: 0, frozen: 0 });
    const closed = await closeRecall(db, incharge.actor, recall.id, "all 145 back to ACME", EXPIRED);
    expect([closed.status, closed.returns.map((x) => [x.returnNo, x.status, x.qtyBase])]).toEqual(["closed", [[r.returnNo, "dispatched", 145]]]);
    expect((await getRecall(db, pharmacist.actor, recall.id)).closeNote).toBe("all 145 back to ACME");
  });
});
