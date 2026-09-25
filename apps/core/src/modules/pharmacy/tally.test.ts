import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { openSessionFor } from "../../../test/helpers/billing";
import { MON, MON2, MON3, issueRx, line, seedPharmacyBase, stockIn } from "../../../test/helpers/pharmacy";
import { ensureRole, mkUser, testCfg } from "../../../test/helpers/opd";
import { parseXml, voucherSums } from "../../../test/helpers/xml";
import { grantPermissionToRole } from "../../kernel/auth/permissions";
import { seedSodPairs } from "../../kernel/auth/sod";
import { withTx } from "../../kernel/db/client";
import { invoices, stockBatches } from "../../kernel/db/schema";
import {
  acceptSupplierBill, activateVendor, addVendorDocument, approveSupplierReturn, billDraftFromGrn, captureGrn, createPaymentRun, createStore,
  createSupplierBill, createSupplierReturn, decidePaymentRun, dispatchSupplierReturn, matchSupplierBill, postGrn, recordVendorCredit,
  recordVendorPayment, registerItem, registerMaterialsApprovalTypes, registerVendor, runGateQc, submitPaymentRun,
} from "../materials";
import { billDispense, previewDispenseBill } from "./bill";
import { claimDispense, findAtCounter } from "./claim";
import { pickDispense } from "./pick";
import { cancelBilledDispense } from "./refund";
import { saveTallyLedgers, tallyExport, tallyExportFile, tallyExports, tallyLedgersConfirmed, tallyPreview } from "./tally";
import { verifyDispense } from "./verify";
import type { PharmacyFixture } from "../../../test/helpers/pharmacy";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ PHARMACY PARITY P5 — THE TALLY EXPORT, FROM THE BOOKS ═══
 *
 * One day of the pharmacy's money, made through the real acts: two counter bills (cash, UPI) — one
 * cancelled with a credit note — a supplier bill booked, a return with our debit note, the vendor's
 * credit short of it, and the payment run the owner authorised that pays the rest. Then:
 *   - the export refuses until the accountant has confirmed the ledger names, and the counter reads
 *     none of it;
 *   - the vouchers file parses as XML and EVERY VOUCHER in it sums to zero; the Sales voucher carries
 *     the invoice's stored heads; the vendor's ledger in Tally nets to what the book owes (nothing);
 *   - the export is recorded; its file downloads again byte for byte (the checksum); a second export
 *     of the same days is seen before it is made.
 */
const DAY = "2026-08-17";
const range = { preset: "custom", from: DAY, to: DAY };

describe("the Tally export (parity P5)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: PharmacyFixture;
  let accounts: { id: string; actor: Actor };
  let owner: { id: string; actor: Actor };
  let head: { id: string; actor: Actor };
  let keeper: { id: string; actor: Actor };

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    fx = await seedPharmacyBase(db);
    await seedSodPairs(db);
    await registerMaterialsApprovalTypes(db, { type: "user", id: "seed-materials" });
    await openSessionFor(db, { id: fx.pharmacist.id }, 0);
    const grants: Record<string, string[]> = {
      billing_manager: ["pharmacy.reports.read", "pharmacy.tally.export"],
      owner: ["pharmacy.reports.read", "pharmacy.tally.export", "approvals.requests.decide", "approvals.requests.read"],
      materials_head: [
        "materials.stock.read", "materials.grn.capture", "materials.grn.qc", "materials.items.manage", "materials.bills.manage",
        "materials.bills.accept_difference", "materials.returns.manage", "materials.returns.approve", "materials.payments.prepare", "materials.payments.record",
      ],
      storekeeper: ["materials.stock.read", "materials.grn.capture"],
    };
    for (const [role, perms] of Object.entries(grants)) {
      await ensureRole(db, role);
      for (const p of perms) await grantPermissionToRole(db, fx.registry, role, p);
    }
    for (const p of ["materials.bills.manage", "materials.returns.manage", "materials.grn.qc"]) await grantPermissionToRole(db, fx.registry, "pharmacy", p);
    accounts = await mkUser(db, "accounts", ["billing_manager"]);
    owner = await mkUser(db, "the.owner", ["owner"]);
    head = await mkUser(db, "mat.head", ["materials_head"]);
    keeper = await mkUser(db, "store.keeper", ["storekeeper"]);
    await stockIn(db, fx, { itemId: fx.item.azithro, batchNo: "AZ-1", qtyBase: 30, mrpPaise: 15_000 });
    await stockIn(db, fx, { itemId: fx.item.crocin, batchNo: "CR-1", qtyBase: 50, mrpPaise: 12_000 });
  });
  afterEach(() => { fx.unregister(); });

  async function billed(medicineId: string, drug: string, qty: number, tender: { mode: "cash" | "upi"; refText?: string }): Promise<{ id: string; invoiceId: string }> {
    const { issued } = await issueRx(db, fx, [line({ drug, medicineId, frequency: "OD", durationDays: qty })]);
    const r = await findAtCounter(db, testCfg, fx.pharmacist.actor, issued.qrPayload, MON2);
    if (r.kind !== "dispense") throw new Error("no dispense");
    await claimDispense(db, fx.pharmacist.actor, { dispenseId: r.dispense.id, door: "rx_qr" }, MON2);
    await verifyDispense(db, fx.pharmacist.actor, fx.decls, r.dispense.id, { lines: [{ lineIdx: 0, qtyBase: qty }] }, MON2);
    await pickDispense(db, fx.pharmacist.actor, fx.decls, r.dispense.id, {}, MON2);
    const p = await previewDispenseBill(db, fx.pharmacist.actor, r.dispense.id, MON2);
    const b = await billDispense(db, fx.pharmacist.actor, r.dispense.id, { tenders: [{ ...tender, amountPaise: p.totals.netPayablePaise }] }, MON2);
    return { id: r.dispense.id, invoiceId: b.invoiceId! };
  }

  /** The supplier's side of the day: a bill of ₹280, ₹56 back on our debit note, credited ₹50, the ₹230 balance paid by NEFT. */
  async function suppliers(): Promise<{ billNo: string; vendorName: string }> {
    const { vendorId } = await withTx(db, (tx) => registerVendor(tx, head.actor, { code: "ACME", legalName: "ACME Pharma Pvt Ltd", gstin: "27AAACA1234A1Z5" }));
    await withTx(db, (tx) => addVendorDocument(tx, head.actor, vendorId, { type: "gst_certificate", number: "g" }));
    await withTx(db, (tx) => addVendorDocument(tx, head.actor, vendorId, { type: "pan", number: "p" }));
    await withTx(db, (tx) => activateVendor(tx, head.actor, vendorId, MON));
    const { itemId } = await withTx(db, (tx) => registerItem(tx, head.actor, {
      code: "GAUZE", name: "Gauze roll", class: "consumable", baseUom: "piece", batchTracked: true, gstRateBps: 1200, hsnCode: "30059040",
      uoms: [{ uom: "box", toBaseMultiplier: 10, isPurchaseUom: true }],
    }));
    const { resourceId: store } = await withTx(db, (tx) => createStore(tx, head.actor, { code: "MAIN", name: "Main store" }));
    const { grnId } = await withTx(db, (tx) => captureGrn(tx, keeper.actor, {
      vendorId, source: "challan", storeResourceId: store, challanNo: "CH-1", challanDate: DAY, invoiceNo: "ACME/0042",
      lines: [{ itemId, uom: "box", qtyInUom: 10, batchNo: "G-1", expiryDate: "2029-06-30", unitCostPaise: 250 }], now: MON,
    }));
    await withTx(db, (tx) => runGateQc(tx, fx.pharmacist.actor, grnId));
    await withTx(db, (tx) => postGrn(tx, fx.pharmacist.actor, grnId, MON));
    const d = await billDraftFromGrn(db, fx.pharmacist.actor, grnId);
    const bill = await createSupplierBill(db, fx.pharmacist.actor, {
      vendorId, vendorBillNo: "ACME/0042", billDate: DAY,
      lines: d.lines.map((l) => ({ grnId: l.grnId, itemId: l.itemId, uom: l.uom, qtyPacks: l.qtyPacks, ratePaise: l.ratePaise, gstRateBps: l.gstRateBps })),
    }, { now: MON });
    await matchSupplierBill(db, fx.pharmacist.actor, bill.id, MON);
    await acceptSupplierBill(db, fx.pharmacist.actor, bill.id, MON);
    const [batch] = await db.select().from(stockBatches).where(and(eq(stockBatches.itemId, itemId), eq(stockBatches.batchNo, "G-1")));
    const ret = await createSupplierReturn(db, fx.pharmacist.actor, { vendorId, lines: [{ batchId: batch!.id, storeResourceId: store, qtyBase: 20, reason: "damaged" }] }, { now: MON2 });
    await approveSupplierReturn(db, head.actor, ret.id, MON2);
    const sent = await dispatchSupplierReturn(db, fx.pharmacist.actor, ret.id, MON2);
    expect(sent.totalPaise).toBe(5_600);
    await recordVendorCredit(db, head.actor, ret.id, { vendorCreditNoteNo: "ACME-CN-7", creditNoteDate: DAY, amountPaise: 5_000, differenceReason: "the vendor allows the taxable value only" }, MON2);
    const run = await createPaymentRun(db, head.actor, { lines: [{ billId: bill.id, payPaise: 23_000, creditPaise: 5_000 }] }, { now: MON3 });
    await submitPaymentRun(db, head.actor, run.id, MON3);
    await decidePaymentRun(db, owner.actor, run.id, "approve", "pay", MON3);
    await recordVendorPayment(db, head.actor, run.id, vendorId, { mode: "neft", reference: "UTR-99", paidOn: DAY }, MON3);
    return { billNo: bill.billNo, vendorName: "ACME Pharma Pvt Ltd" };
  }

  it("refuses until the ledgers are confirmed, and the counter reads none of it", async () => {
    expect(await tallyLedgersConfirmed(db)).toBe(false);
    await expect(tallyExport(db, accounts.actor, range, MON3)).rejects.toMatchObject({ code: "tally_ledgers_unconfirmed" });
    await expect(tallyPreview(db, fx.pharmacist.actor, range, MON3)).rejects.toMatchObject({ code: "permission_denied" });
    await expect(saveTallyLedgers(db, fx.pharmacist.actor, {}, MON3)).rejects.toMatchObject({ code: "permission_denied" });
    await expect(saveTallyLedgers(db, accounts.actor, { cash: " " }, MON3)).rejects.toMatchObject({ code: "invalid_tally_ledgers" });
    const saved = await saveTallyLedgers(db, accounts.actor, { bank: "HDFC Current A/c" }, MON3);
    expect([saved.confirmed, saved.ledgers.bank, saved.ledgers.cash, saved.updatedBy]).toEqual([true, "HDFC Current A/c", "Cash", "accounts"]);
    expect(await tallyLedgersConfirmed(db)).toBe(true);
  });

  it("exports the day: every voucher balances in the file, the sale carries the stored heads, the vendor nets to nothing; recorded, and re-downloadable byte for byte", async () => {
    const cash = await billed(fx.med.azithro, "Azee 500", 3, { mode: "cash" });
    const back = await billed(fx.med.crocin, "Crocin 500", 10, { mode: "upi", refText: "UPI-1" });
    await cancelBilledDispense(db, fx.pharmacist.actor, fx.decls, back.id, { reason: "patient bought it outside", reasonClass: "genuine" }, MON3);
    const acme = await suppliers();
    await saveTallyLedgers(db, accounts.actor, {}, MON3);

    const preview = await tallyPreview(db, accounts.actor, range, MON3);
    expect(preview.counts).toEqual({
      sale: 2, receipt: 2, sales_return: 1, refund: 0, purchase: 1, purchase_return: 1, credit_shortfall: 1, return_closed: 0, supplier_payment: 1,
    });
    expect(preview.earlier).toEqual([]);

    const made = await tallyExport(db, accounts.actor, range, MON3);
    expect([made.voucherCount, made.exportedBy, made.from, made.to]).toEqual([9, "accounts", DAY, DAY]);
    const file = await tallyExportFile(db, accounts.actor, made.id, "vouchers");
    expect(createHash("sha256").update(file.xml, "utf8").digest("hex")).toBe(made.checksum);
    expect(file.fileName).toBe(`tally-pharmacy-${DAY}-to-${DAY}-vouchers.xml`);

    const sums = voucherSums(parseXml(file.xml));
    expect(sums).toHaveLength(9);
    expect(sums.filter((v) => v.sum !== 0)).toEqual([]);
    expect(sums.map((v) => v.type).sort()).toEqual(["Credit Note", "Debit Note", "Journal", "Payment", "Purchase", "Receipt", "Receipt", "Sales", "Sales"]);
    // The cash bill, as Tally will book it: Dr the patient the net payable, Cr sales and GST as billing stored them.
    const [stored] = await db.select().from(invoices).where(eq(invoices.id, cash.invoiceId));
    const sale = sums.find((v) => v.number === stored!.invoiceNo)!;
    expect(sale.entries[0]![1]).toBe(-stored!.netPayablePaise);
    expect(sale.entries.find(([l]) => l === "Pharmacy Sales")![1]).toBe(stored!.taxableBasePaise);
    expect(sale.entries.find(([l]) => l === "Output CGST")![1]).toBe(stored!.cgstPaise);
    // ACME in Tally: Cr 280 on the bill, Dr 56 on the debit note, Cr 6 shortfall, Dr 230 paid — nothing owed, as in the book.
    const acmeBalance = sums.flatMap((v) => v.entries).filter(([l]) => l === acme.vendorName).reduce((s, [, a]) => s + a, 0);
    expect(acmeBalance).toBe(0);
    expect(sums.find((v) => v.number === acme.billNo)!.entries).toEqual([["Purchase — Medicines", -25_000], ["Input CGST", -1_500], ["Input SGST", -1_500], [acme.vendorName, 28_000]]);

    const masters = parseXml((await tallyExportFile(db, accounts.actor, made.id, "masters")).xml);
    expect(masters.name).toBe("ENVELOPE");

    // A second look at the same day shows the export already made.
    const again = await tallyPreview(db, accounts.actor, range, MON3);
    expect(again.earlier.map((e) => [e.id, e.checksum, e.exportedBy])).toEqual([[made.id, made.checksum, "accounts"]]);
    expect((await tallyExports(db, owner.actor)).map((e) => e.id)).toEqual([made.id]);
    await expect(tallyExportFile(db, fx.pharmacist.actor, made.id, "vouchers")).rejects.toMatchObject({ code: "permission_denied" });
  });
});
