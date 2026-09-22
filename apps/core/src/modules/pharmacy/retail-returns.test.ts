import { and, eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { openSessionFor } from "../../../test/helpers/billing";
import { MON, seedPharmacyBase, stockIn } from "../../../test/helpers/pharmacy";
import { ensureRole, mkUser } from "../../../test/helpers/opd";
import { grantPermissionToRole } from "../../kernel/auth/permissions";
import { withTx } from "../../kernel/db/client";
import { approvals, creditNoteLines, events, pharmacyRetailSaleLines, stockLedger } from "../../kernel/db/schema";
import { getInvoice, issueCreditNote, listCreditNotes } from "../billing";
import { balances, createStore, postMovement, registerItem, updateItem } from "../materials";
import { addMedicine, addSalt } from "../formulary";
import { inclusiveTaxHead } from "../tariff";
import { registerSaleItem } from "./sale-items";
import { RETAIL_PHARMACY_STORE_CODE, RETAIL_REF_TYPE, RETAIL_RETURN_REF_TYPE } from "./config";
import { pharmacyLeakage } from "./leakage";
import { getRetailSale, previewRetailSale, recordRetailLicence, sellRetail } from "./retail";
import { acceptRetailReturn, findRetailSaleByInvoiceNo } from "./retail-returns";
import type { Actor } from "@hmis/contracts";
import type { PharmacyFixture } from "../../../test/helpers/pharmacy";
import type { Db } from "../../kernel/db/client";
import type { DocumentStore } from "../../kernel/documents/store";
import type { RetailSaleView } from "./retail";
import type { RetailReturnInput } from "./retail-returns";

/**
 * ═══ PHARMACY P19b — A SEALED PACK COMES BACK TO THE WALK-IN COUNTER ═══
 *
 * Phase doc `docs/superpowers/plans/2026-09-17-phase-pharmacy-p19b-retail-returns.md`. The counter's
 * P6 policy (doc 16 O-7), applied to a walk-in sale: within 7 days, sealed and intact, whole packs,
 * never cold-chain or a narcotic, against the bill. And the leakage triangle, read at the walk-in store.
 */
class FakeStore implements DocumentStore {
  async put(): Promise<void> { /* no document is filed by an OTC sale */ }
  async get(): Promise<Buffer> { return Buffer.alloc(0); }
  async remove(): Promise<void> { /* nothing to remove */ }
}

const DAY = 24 * 60 * 60 * 1000;
const later = (days: number): Date => new Date(MON.getTime() + days * DAY);
const HEAD: Actor = { type: "user", id: "01HMATERIALSHEAD00000000001" };
const LICENCE = {
  form20No: "RLF20-MH-PUN-1001", form21No: "RLF21-MH-PUN-1001", validFrom: "2026-01-01", validTo: "2030-12-31",
  pharmacistInCharge: "A. Kulkarni",
};

describe("returns at the walk-in counter (P19b)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: PharmacyFixture;
  let retailId: string;
  let manager: { id: string; actor: Actor };

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    fx = await seedPharmacyBase(db);
    await openSessionFor(db, { id: fx.pharmacist.id }, 0);
    ({ resourceId: retailId } = await withTx(db, (tx) => createStore(tx, HEAD, { code: RETAIL_PHARMACY_STORE_CODE, name: "Walk-in retail pharmacy" })));
    await ensureRole(db, "pharmacy_incharge");
    await grantPermissionToRole(db, fx.registry, "pharmacy_incharge", "pharmacy.retail.manage");
    manager = await mkUser(db, "ph.licensee", ["pharmacy_incharge"]);
    await recordRetailLicence(db, manager.actor, LICENCE, MON);
  });
  afterEach(() => { fx.unregister(); });

  /** `qty` Crocin tablets sold at MON to the fixture's patient, paid in cash (₹120 a strip of 10). */
  const sell = async (qty: number, at: Date = MON): Promise<RetailSaleView> => sellRetail(db, new FakeStore(), fx.pharmacist.actor, {
    customer: { existingId: fx.patient.id }, lines: [{ medicineId: fx.med.crocin, qtyBase: qty }],
    tenders: [{ mode: "cash", amountPaise: qty * 1200 }],
  }, undefined, at);
  const ret = (saleId: string, qtyBase: number, at: Date, over: Partial<RetailReturnInput> = {}, key?: string, who = fx.pharmacist.actor) =>
    acceptRetailReturn(db, who, saleId, {
      lines: [{ lineIdx: 0, qtyBase }], sealedIntact: true, reason: "the doctor changed the medicine", reasonClass: "genuine", ...over,
    }, key, at);
  const onHand = async (resourceId: string, batchId: string): Promise<number> =>
    (await balances(db, { resourceId, batchId })).reduce((s, b) => s + b.qtyOnHand, 0);
  const returnRows = () => db.select().from(stockLedger).where(eq(stockLedger.refType, RETAIL_RETURN_REF_TYPE));

  it("takes a sealed strip back into the retail store, credits it, requests its refund, and never more than was sold", async () => {
    const batch = await stockIn(db, fx, { itemId: fx.item.crocin, batchNo: "R-1", qtyBase: 50, expiryDate: "2027-12-31", resourceId: retailId });
    const opdBatch = await stockIn(db, fx, { itemId: fx.item.crocin, batchNo: "OPD-1", qtyBase: 50, expiryDate: "2027-12-31" });
    const sale = await sell(20);
    expect(await onHand(retailId, batch)).toBe(30);

    // The customer comes back two days later with the bill: the counter finds the sale by its number.
    expect((await findRetailSaleByInvoiceNo(db, fx.pharmacist.actor, ` ${sale.invoiceNo} `)).id).toBe(sale.id);
    await expect(findRetailSaleByInvoiceNo(db, fx.pharmacist.actor, "INV-NOPE")).rejects.toMatchObject({ code: "unknown_retail_sale" });
    await expect(findRetailSaleByInvoiceNo(db, fx.clerk.actor, sale.invoiceNo)).rejects.toMatchObject({ code: "permission_denied" });
    // Refused before the lookup: the answer must not tell an outsider which bill numbers exist.
    await expect(findRetailSaleByInvoiceNo(db, fx.clerk.actor, "INV-NOPE")).rejects.toMatchObject({ code: "permission_denied" });

    const first = await ret(sale.id, 10, later(2), {}, "ret-1");

    expect(await onHand(retailId, batch)).toBe(40);
    expect(await onHand(fx.storeId, opdBatch)).toBe(50);
    const [saleLine] = await db.select().from(pharmacyRetailSaleLines).where(eq(pharmacyRetailSaleLines.saleId, sale.id));
    const [row] = await returnRows();
    expect(row).toMatchObject({ reason: "return", qtyDelta: 10, resourceId: retailId, batchId: batch, refId: saleLine!.id, patientId: fx.patient.id });
    const notes = await listCreditNotes(db);
    expect(notes.map((n) => [n.id, n.kind, n.netPaise])).toEqual([[first.creditNoteId, "refund", 12000]]);
    const [approval] = await db.select().from(approvals).where(eq(approvals.id, first.refundApprovalId));
    expect(approval).toMatchObject({ typeKey: "billing_refund", amountPaise: 12000 });
    const returned = await db.select().from(events).where(eq(events.name, "retail.line_returned"));
    expect(returned).toHaveLength(1);
    expect(returned[0]!.payload).toEqual({
      saleId: sale.id, patientId: fx.patient.id, storeResourceId: retailId, channel: "walk_in",
      lines: [{ lineIdx: 0, qtyBase: 10, batchId: batch, ledgerEntryId: row!.id }],
      sealedIntact: true, reason: "the doctor changed the medicine", reasonClass: "genuine",
      creditNoteId: first.creditNoteId, refundApprovalId: first.refundApprovalId,
    });
    expect(first.sale.lines.map((l) => [l.qtyBase, l.returnedQtyBase])).toEqual([[20, 10]]);

    // A retried click is the same return, even a moment later.
    const again = await ret(sale.id, 10, new Date(later(2).getTime() + 5_000), {}, "ret-1");
    expect(again.creditNoteId).toBe(first.creditNoteId);
    expect(await listCreditNotes(db)).toHaveLength(1);

    // The licence lapses. A customer's refund does not wait on the shop's licence.
    await recordRetailLicence(db, manager.actor, { ...LICENCE, validFrom: "2025-01-01", validTo: "2026-08-18" }, later(1));
    await ret(sale.id, 10, later(3));
    await expect(ret(sale.id, 10, later(3))).rejects.toMatchObject({ code: "return_exceeds_dispensed", detail: { left: 0 } });
    expect(await onHand(retailId, batch)).toBe(50);
    expect((await getRetailSale(db, fx.pharmacist.actor, sale.id)).lines[0]?.returnedQtyBase).toBe(20);
  });

  /**
   * THE LOOSE-MRP RULING (owner, money, 2026-09-22), end to end at the walk-in counter. ₹35.50 on a
   * strip of 15 (236.67 paise a tablet) was UNSALEABLE (`price_unknown`). A full strip now bills at
   * exactly its MRP and a loose tablet at 236: 20 tablets = 3550 + 5 × 236 = 4730, carried as the
   * main line (20 × 236) and the strip's residue (1 × 10). GST 5% is carved out of each line, and the
   * three heads add back to the amount. A strip returned leaves 5 loose tablets billed at 5 × 236.
   */
  it("loose-MRP: 20 tablets from ₹35.50 strips of 15 bill 4730, tax carved out; a strip back refunds 3550", async () => {
    const dolo = await withTx(db, async (tx) => {
      const salt = await addSalt(tx, fx.pharmacist.actor, { name: "Paracetamol DT", drugClass: "analgesic" });
      const med = await addMedicine(tx, fx.pharmacist.actor, {
        brandName: "Dolo 650", form: "tablet", routeClass: "systemic", strengthLabel: "650 mg", scheduleFlag: "OTC",
        salts: [{ saltId: salt.saltId, strength: "650 mg" }],
      });
      const { itemId } = await registerItem(tx, HEAD, {
        code: "DOLO650", name: "Dolo 650 tablet", class: "drug", baseUom: "tablet", batchTracked: true,
        formularyMedicineId: med.medicineId, gstRateBps: 500,
        uoms: [{ uom: "strip", toBaseMultiplier: 15, isPurchaseUom: true, isIssueUom: true }],
      });
      await registerSaleItem(tx, fx.pharmacist.actor, itemId);
      return { itemId, medicineId: med.medicineId };
    });
    await stockIn(db, fx, { itemId: dolo.itemId, batchNo: "DOLO-1", mrpPaise: 3550, qtyBase: 60, expiryDate: "2027-12-31", resourceId: retailId });
    const priceOf = async (qtyBase: number) =>
      (await previewRetailSale(db, fx.pharmacist.actor, { lines: [{ medicineId: dolo.medicineId, qtyBase }] }, MON)).totals.grossPaise;
    expect(await priceOf(15)).toBe(3550);
    expect(await priceOf(1)).toBe(236);
    expect(await priceOf(20)).toBe(4730);

    const preview = await previewRetailSale(db, fx.pharmacist.actor, { lines: [{ medicineId: dolo.medicineId, qtyBase: 20 }] }, MON);
    const sale = await sellRetail(db, new FakeStore(), fx.pharmacist.actor, {
      customer: { existingId: fx.patient.id }, lines: [{ medicineId: dolo.medicineId, qtyBase: 20 }],
      tenders: [{ mode: "cash", amountPaise: preview.totals.netPayablePaise }],
    }, undefined, MON);
    const invoice = (await getInvoice(db, sale.invoiceId))!;
    const lines = [...invoice.lines].sort((a, b) => a.lineNo - b.lineNo);
    expect(lines.map((l) => [l.qty, l.unitPaise, l.grossPaise])).toEqual([[20, 236, 4720], [1, 10, 10]]);
    // Every line's tax is carved OUT of its own amount at 5%, and the heads add back to it exactly.
    for (const l of lines) {
      expect(l.cgstPaise).toBe(inclusiveTaxHead(l.grossPaise, 500));
      expect(l.sgstPaise).toBe(l.cgstPaise);
      expect(l.taxableBasePaise + l.cgstPaise + l.sgstPaise).toBe(l.grossPaise);
    }
    const sum = (f: (l: (typeof lines)[number]) => number) => lines.reduce((n, l) => n + f(l), 0);
    expect(sum((l) => l.taxableBasePaise) + sum((l) => l.cgstPaise) + sum((l) => l.sgstPaise)).toBe(4730);
    // Carving per line vs on the whole 4730 differs only by the per-line rounding of each head.
    expect(Math.abs(sum((l) => l.cgstPaise) - inclusiveTaxHead(4730, 500))).toBeLessThanOrEqual(lines.length - 1);
    // The sale line keys on the MAIN invoice line, in base units, as every reader of it expects.
    expect(sale.lines.map((l) => [l.qtyBase, l.unitPaise])).toEqual([[20, 236]]);

    // A whole strip comes back: 15 × 236 off the main line AND the strip's 10-paise residue.
    const back = await ret(sale.id, 15, later(2));
    const [note] = await listCreditNotes(db);
    expect(note?.id).toBe(back.creditNoteId);
    const credited = await db.select().from(creditNoteLines).where(eq(creditNoteLines.creditNoteId, back.creditNoteId));
    expect(credited.map((c) => [c.invoiceLineId, c.qty, c.grossPaise]).sort((a, b) => Number(b[2]) - Number(a[2])))
      .toEqual([[lines[0]!.id, 15, 3540], [lines[1]!.id, 1, 10]]);
    expect(credited.reduce((n, c) => n + c.grossPaise, 0)).toBe(3550);
    expect(note).toMatchObject({ kind: "refund" });
  });

  it("refuses what O-7 refuses, and writes nothing when it does", async () => {
    await stockIn(db, fx, { itemId: fx.item.crocin, batchNo: "R-1", qtyBase: 50, expiryDate: "2027-12-31", resourceId: retailId });
    const sale = await sell(20);
    await expect(ret(sale.id, 10, later(2), { sealedIntact: false })).rejects.toMatchObject({ code: "return_not_sealed" });
    await expect(ret(sale.id, 10, later(8))).rejects.toMatchObject({ code: "return_window_closed" });
    await expect(ret(sale.id, 5, later(2))).rejects.toMatchObject({ code: "return_cut_strip" });
    await expect(ret(sale.id, 10, later(2), { reason: " " })).rejects.toMatchObject({ code: "reason_required" });
    await expect(ret(sale.id, 10, later(2), { lines: [{ lineIdx: 3, qtyBase: 10 }] })).rejects.toMatchObject({ code: "unknown_line" });
    await expect(ret(sale.id, 10, later(2), { lines: [] })).rejects.toMatchObject({ code: "nothing_to_dispense" });
    await expect(ret("01HNOSUCHSALE0000000000000", 10, later(2))).rejects.toMatchObject({ code: "unknown_retail_sale" });
    // Holds `pharmacy`, has no council registration on file.
    await expect(ret(sale.id, 10, later(2), {}, undefined, fx.incharge.actor)).rejects.toMatchObject({ code: "pharmacist_not_registered" });
    await withTx(db, (tx) => updateItem(tx, HEAD, fx.item.crocin, { storageClass: "cold_2_8" }));
    await expect(ret(sale.id, 10, later(2))).rejects.toMatchObject({ code: "return_not_accepted" });

    expect(await listCreditNotes(db)).toEqual([]);
    expect(await returnRows()).toEqual([]);
    expect(await db.select().from(events).where(eq(events.name, "retail.line_returned"))).toEqual([]);
  });

  it("does not restock a batch that is about to expire or is recalled", async () => {
    // Expires 24 days after the sale: too short to go back on the shelf.
    const short = await stockIn(db, fx, { itemId: fx.item.crocin, batchNo: "R-SHORT", qtyBase: 20, expiryDate: "2026-09-10", resourceId: retailId });
    const sale = await sell(10);
    await expect(ret(sale.id, 10, later(1))).rejects.toMatchObject({ code: "return_short_expiry" });
    expect(await onHand(retailId, short)).toBe(10);
    expect(await returnRows()).toEqual([]);
  });

  it("reads the leakage triangle at the walk-in store: a refund with nothing back, a return that balances, and stock out with no sale", async () => {
    const batch = await stockIn(db, fx, { itemId: fx.item.crocin, batchNo: "R-1", qtyBase: 100, expiryDate: "2027-12-31", resourceId: retailId });
    await stockIn(db, fx, { itemId: fx.item.crocin, batchNo: "OPD-1", qtyBase: 100, expiryDate: "2027-12-31" });
    // Returned properly: restocked AND credited, so it balances.
    const clean = await sell(20);
    await ret(clean.id, 10, later(0.1));
    // Three tablets refunded at the billing desk; nothing came back.
    const leaky = await sell(10);
    const [leakyLine] = await db.select().from(pharmacyRetailSaleLines).where(eq(pharmacyRetailSaleLines.saleId, leaky.id));
    await issueCreditNote(db, fx.pharmacist.actor, {
      kind: "refund", invoiceId: leaky.invoiceId, reason: "customer complained", lines: [{ invoiceLineId: leakyLine!.invoiceLineId, qty: 3 }],
    }, later(0.2));
    // Four tablets out of the retail store with no sale behind them.
    await withTx(db, (tx) => postMovement(tx, fx.pharmacist.actor, {
      resourceId: retailId, batchId: batch, qtyDelta: -4, reason: "consume", refType: "staff_sample", refId: "slip-9", occurredAt: later(0.3),
    }));

    const report = await pharmacyLeakage(db, "2026-08-17", RETAIL_PHARMACY_STORE_CODE);

    expect(report.store.code).toBe(RETAIL_PHARMACY_STORE_CODE);
    expect(report.dispensed).toEqual({ lines: 2, units: 30 });
    expect(report.mismatches).toEqual([{
      source: "walk_in", dispenseId: null, dispenseNo: null, saleId: leaky.id, invoiceNo: leaky.invoiceNo,
      itemCode: "CROC500", batchNo: "R-1", issued: 10, returned: 0, billed: 10, credited: 3, unbilledUnits: 3, unbilledPaise: 3600,
    }]);
    // The walk-in sales' own consumption is not "outside a sale".
    expect(report.otherConsumption.map((c) => [c.refType, c.units])).toEqual([["staff_sample", 4]]);
    expect(report.summary).toMatchObject({ unbilledUnits: 3, unbilledPaise: 3600, otherUnits: 4 });

    // The OPD counter's report does not see the walk-in store's day.
    const opd = await pharmacyLeakage(db, "2026-08-17");
    expect(opd.summary).toEqual({ unbilledUnits: 0, unbilledPaise: 0, otherUnits: 0, countVarianceUnits: 0, countVariancePaise: 0 });
    expect(opd.dispensed).toEqual({ lines: 0, units: 0 });
    await expect(pharmacyLeakage(db, "2026-08-17", "MAIN-STORE")).rejects.toMatchObject({ code: "store_missing" });
    // A retail consume row is referenced to its sale line, never mistaken for anything else.
    expect(await db.select().from(stockLedger).where(and(eq(stockLedger.refType, RETAIL_REF_TYPE), eq(stockLedger.resourceId, retailId)))).toHaveLength(2);
  });
});
