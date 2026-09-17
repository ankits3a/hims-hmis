import { and, eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { openSessionFor } from "../../../test/helpers/billing";
import { MON, addAllergy, seedPharmacyBase, stockIn } from "../../../test/helpers/pharmacy";
import { ensureRole, mkPatient, mkUser } from "../../../test/helpers/opd";
import { grantPermissionToRole } from "../../kernel/auth/permissions";
import { withTx } from "../../kernel/db/client";
import {
  events, invoices, patientDocuments, patients, pharmacyRegH1, pharmacyRetailSaleLines, pharmacyRetailSales, stockLedger,
} from "../../kernel/db/schema";
import { balances, createStore, registerItem } from "../materials";
import { RETAIL_PHARMACY_STORE_CODE, RETAIL_REF_TYPE } from "./config";
import { h1Register } from "./registers";
import {
  getRetailSale, listRetailSales, previewRetailSale, recordRetailLicence, retailLicenceState, searchRetailShelf, sellRetail,
} from "./retail";
import { registerSaleItem } from "./sale-items";
import { DocumentStoreError } from "../../kernel/documents/store";
import { toHttp } from "./pharmacy-http";
import type { Actor } from "@hmis/contracts";
import type { PharmacyFixture } from "../../../test/helpers/pharmacy";
import type { Db } from "../../kernel/db/client";
import type { DocumentStore } from "../../kernel/documents/store";
import type { RetailSaleInput } from "./retail";

/**
 * ═══ PHARMACY P19 — WALK-IN RETAIL SALES ═══
 *
 * Phase doc `docs/superpowers/plans/2026-09-17-phase-pharmacy-p19-retail-sales.md`.
 */
class FakeStore implements DocumentStore {
  readonly files = new Map<string, Buffer>();
  async put(key: string, bytes: Buffer): Promise<void> { this.files.set(key, bytes); }
  async get(key: string): Promise<Buffer> {
    const b = this.files.get(key);
    if (b === undefined) throw new Error("not found");
    return b;
  }
  async remove(key: string): Promise<void> { this.files.delete(key); }
}

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const HEAD: Actor = { type: "user", id: "01HMATERIALSHEAD00000000001" };
const LICENCE = {
  form20No: "RLF20-MH-PUN-1001", form21No: "RLF21-MH-PUN-1001", validFrom: "2026-01-01", validTo: "2030-12-31",
  pharmacistInCharge: "A. Kulkarni",
};
const RX = {
  prescriberName: "Dr R. Joshi", prescriberRegNo: "MMC-2011-04417", prescriberAddress: "Joshi Clinic, FC Road, Pune",
  rxDate: "2026-08-16", photo: { mimeType: "image/jpeg", bytes: JPEG },
};

describe("walk-in retail sales (P19)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: PharmacyFixture;
  let docs: FakeStore;
  let retailId: string;
  let manager: { id: string; actor: Actor };

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    fx = await seedPharmacyBase(db);
    docs = new FakeStore();
    await openSessionFor(db, { id: fx.pharmacist.id }, 0);
    ({ resourceId: retailId } = await withTx(db, (tx) => createStore(tx, HEAD, { code: RETAIL_PHARMACY_STORE_CODE, name: "Walk-in retail pharmacy" })));
    await ensureRole(db, "pharmacy_incharge");
    await grantPermissionToRole(db, fx.registry, "pharmacy_incharge", "pharmacy.retail.manage");
    manager = await mkUser(db, "ph.licensee", ["pharmacy_incharge"]);
  });
  afterEach(() => { fx.unregister(); });

  const open = async (over: Partial<typeof LICENCE> = {}): Promise<void> => {
    await recordRetailLicence(db, manager.actor, { ...LICENCE, ...over }, MON);
  };
  const newCustomer = (over: { name?: string; phone?: string } = {}): RetailSaleInput["customer"] => ({
    register: { name: over.name ?? "Ramesh Patil", sex: "male", ageYears: 52, phone: over.phone ?? "9822001122" },
  });
  const pay = async (patientId: string | undefined, lines: RetailSaleInput["lines"]): Promise<RetailSaleInput["tenders"]> => {
    const p = await previewRetailSale(db, fx.pharmacist.actor, { ...(patientId === undefined ? {} : { patientId }), lines }, MON);
    return [{ mode: "cash", amountPaise: p.totals.netPayablePaise }];
  };
  const onHand = async (resourceId: string, batchId: string): Promise<number> =>
    (await balances(db, { resourceId, batchId })).reduce((s, b) => s + b.qtyOnHand, 0);

  it("stays shut until the licensee records a current Form 20/21 licence, and shuts again when it lapses", async () => {
    await stockIn(db, fx, { itemId: fx.item.crocin, batchNo: "R-1", qtyBase: 50, resourceId: retailId });
    const lines = [{ medicineId: fx.med.crocin, qtyBase: 10 }];
    expect((await retailLicenceState(db, MON)).state).toBe("missing");
    await expect(sellRetail(db, docs, fx.pharmacist.actor, { customer: newCustomer(), lines, tenders: await pay(undefined, lines) }, undefined, MON))
      .rejects.toMatchObject({ code: "retail_licence_missing" });

    // Only the licensee's roles record it, and the dates must make sense.
    await expect(recordRetailLicence(db, fx.pharmacist.actor, LICENCE, MON)).rejects.toMatchObject({ code: "permission_denied" });
    await expect(open({ validFrom: "2031-01-01" })).rejects.toMatchObject({ code: "invalid_retail_licence" });
    await expect(open({ form21No: "  " })).rejects.toMatchObject({ code: "invalid_retail_licence" });
    await open();
    expect(await retailLicenceState(db, MON)).toMatchObject({ state: "current", licence: { form20No: LICENCE.form20No } });

    // A later row is the licence: one that ended yesterday closes the counter.
    await open({ validFrom: "2025-01-01", validTo: "2026-08-16" });
    expect((await retailLicenceState(db, MON)).state).toBe("lapsed");
    await expect(sellRetail(db, docs, fx.pharmacist.actor, { customer: newCustomer(), lines, tenders: await pay(undefined, lines) }, undefined, MON))
      .rejects.toMatchObject({ code: "retail_licence_lapsed" });
    expect(await db.select().from(pharmacyRetailSales)).toEqual([]);
  });

  it("sells OTC to a new customer from the retail shelf only: registered, stock consumed, invoice paid, one event, no register row", async () => {
    await open();
    // The OPD counter's shelf holds an EARLIER batch; the walk-in must never take it (doc 16 I2).
    const opdBatch = await stockIn(db, fx, { itemId: fx.item.crocin, batchNo: "OPD-1", qtyBase: 50, expiryDate: "2026-12-31" });
    const retailBatch = await stockIn(db, fx, { itemId: fx.item.crocin, batchNo: "R-1", qtyBase: 50, expiryDate: "2027-06-30", resourceId: retailId });
    const lines = [{ medicineId: fx.med.crocin, qtyBase: 10 }];

    const shelf = await searchRetailShelf(db, fx.pharmacist.actor, "croc", MON);
    expect(shelf.map((e) => [e.itemCode, e.available])).toEqual([["CROC500", 50]]);
    const preview = await previewRetailSale(db, fx.pharmacist.actor, { lines }, MON);
    expect(preview).toMatchObject({ prescriptionRequired: false, checks: null, lines: [{ batchId: retailBatch, qtyBase: 10 }] });
    expect(preview.totals.netPayablePaise).toBe(12000); // MRP ₹120 a strip of 10, tax inside
    expect(await db.select().from(pharmacyRetailSales)).toEqual([]); // a preview writes nothing

    // The aide does not sell.
    await expect(sellRetail(db, docs, fx.aide.actor, { customer: newCustomer(), lines, tenders: await pay(undefined, lines) }, undefined, MON))
      .rejects.toMatchObject({ code: "permission_denied" });

    const sale = await sellRetail(db, docs, fx.pharmacist.actor, { customer: newCustomer(), lines, tenders: await pay(undefined, lines) }, "k-1", MON);
    expect(sale).toMatchObject({
      scheduled: false, prescription: null, netPaise: 12000, pharmacistRegNo: null,
      patient: { name: "Ramesh Patil", phone: "9822001122", registeredHere: true },
      lines: [{ batchId: retailBatch, qtyBase: 10, scheduleFlag: "OTC", unitPaise: 1200 }],
    });
    expect(await onHand(retailId, retailBatch)).toBe(40);
    expect(await onHand(fx.storeId, opdBatch)).toBe(50);
    const [ledger] = await db.select().from(stockLedger).where(eq(stockLedger.refType, RETAIL_REF_TYPE));
    expect(ledger).toMatchObject({ reason: "consume", qtyDelta: -10, resourceId: retailId, patientId: sale.patient.id });
    const [inv] = await db.select().from(invoices).where(eq(invoices.id, sale.invoiceId));
    expect(inv).toMatchObject({ patientId: sale.patient.id, encounterId: null });
    expect(await db.select().from(pharmacyRegH1)).toEqual([]);
    const sold = await db.select().from(events).where(eq(events.name, "retail.sold"));
    expect(sold).toHaveLength(1);
    expect(sold[0]!.payload).toMatchObject({ saleId: sale.id, registeredHere: true, scheduled: false, h1RegisterRows: 0, lines: [{ ledgerEntryId: ledger!.id }] });

    // A retried request is the same sale, even a moment later (the clock is the server's, not the request's).
    const again = await sellRetail(db, docs, fx.pharmacist.actor, { customer: newCustomer(), lines, tenders: [{ mode: "cash", amountPaise: 12000 }] }, "k-1", new Date(MON.getTime() + 5_000));
    expect(again.id).toBe(sale.id);
    expect(await db.select().from(pharmacyRetailSales)).toHaveLength(1);

    // The same name and mobile again: never attached automatically (doc 16 A4).
    const dup = sellRetail(db, docs, fx.pharmacist.actor, { customer: newCustomer(), lines, tenders: [{ mode: "cash", amountPaise: 12000 }] }, undefined, MON);
    await expect(dup).rejects.toMatchObject({ code: "duplicate_suspected" });
    const existing = await sellRetail(db, docs, fx.pharmacist.actor, { customer: { existingId: sale.patient.id }, lines, tenders: await pay(sale.patient.id, lines) }, undefined, MON);
    expect(existing.patient).toMatchObject({ id: sale.patient.id, registeredHere: false });
    expect(await db.select().from(patients).where(eq(patients.phone, "9822001122"))).toHaveLength(1);

    expect((await listRetailSales(db, fx.pharmacist.actor, "2026-08-17")).map((r) => [r.id, r.netPaise])).toEqual([
      [existing.id, 12000], [sale.id, 12000],
    ].sort((a, b) => (a[0]! < b[0]! ? 1 : -1)));
    expect((await getRetailSale(db, fx.pharmacist.actor, sale.id)).invoiceNo).not.toBe("");
  });

  it("registers a customer only under patients.register", async () => {
    await open();
    await stockIn(db, fx, { itemId: fx.item.crocin, batchNo: "R-1", qtyBase: 50, resourceId: retailId });
    await ensureRole(db, "retail_till");
    for (const p of ["pharmacy.retail.sell", "billing.invoice.issue", "billing.receipt.record", "billing.session.own", "patients.read"]) {
      await grantPermissionToRole(db, fx.registry, "retail_till", p);
    }
    const till = await mkUser(db, "till", ["retail_till"]);
    await openSessionFor(db, { id: till.id }, 0);
    const lines = [{ medicineId: fx.med.crocin, qtyBase: 10 }];
    await expect(sellRetail(db, docs, till.actor, { customer: newCustomer(), lines, tenders: await pay(undefined, lines) }, undefined, MON))
      .rejects.toMatchObject({ code: "registration_not_permitted" });
    const sold = await sellRetail(db, docs, till.actor, { customer: { existingId: fx.patient.id }, lines, tenders: await pay(fx.patient.id, lines) }, undefined, MON);
    expect(sold.patient.id).toBe(fx.patient.id);
  });

  it("sells Schedule H1 only on an outside prescription, by a registered pharmacist, and writes the register with the prescriber's address", async () => {
    await open();
    const batch = await stockIn(db, fx, { itemId: fx.item.azithro, batchNo: "AZ-9", qtyBase: 30, resourceId: retailId });
    const lines = [{ medicineId: fx.med.azithro, qtyBase: 3 }];
    const customer = { existingId: fx.patient.id };
    const tenders = await pay(fx.patient.id, lines);
    expect((await previewRetailSale(db, fx.pharmacist.actor, { patientId: fx.patient.id, lines }, MON)).prescriptionRequired).toBe(true);

    await expect(sellRetail(db, docs, fx.pharmacist.actor, { customer, lines, tenders }, undefined, MON))
      .rejects.toMatchObject({ code: "prescription_required" });
    await expect(sellRetail(db, docs, fx.pharmacist.actor, { customer, lines, tenders, prescription: { ...RX, rxDate: "2026-08-18" } }, undefined, MON))
      .rejects.toMatchObject({ code: "invalid_prescription" });
    await expect(sellRetail(db, docs, fx.pharmacist.actor, { customer, lines, tenders, prescription: { ...RX, prescriberAddress: " " } }, undefined, MON))
      .rejects.toMatchObject({ code: "invalid_prescription" });
    // A store that cannot take the photo refuses the sale whole, and says so as a 503, not a 500.
    const broken: DocumentStore = {
      put: async () => { throw new DocumentStoreError("unwritable", "EACCES"); },
      get: async () => Buffer.alloc(0), remove: async () => undefined,
    };
    const refusal = await sellRetail(db, broken, fx.pharmacist.actor, { customer, lines, tenders, prescription: RX }, undefined, MON).catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(DocumentStoreError);
    let status = 0;
    try { toHttp(refusal); } catch (e) { status = (e as { getStatus: () => number }).getStatus(); }
    expect(status).toBe(503);
    expect(await db.select().from(pharmacyRetailSales)).toEqual([]);
    expect(await db.select().from(patientDocuments)).toEqual([]);
    // Holds `pharmacy`, has no council registration on file.
    await expect(sellRetail(db, docs, fx.incharge.actor, { customer, lines, tenders, prescription: RX }, undefined, MON))
      .rejects.toMatchObject({ code: "pharmacist_not_registered" });
    expect(await db.select().from(patientDocuments)).toEqual([]);
    expect(await onHand(retailId, batch)).toBe(30);

    const sale = await sellRetail(db, docs, fx.pharmacist.actor, { customer, lines, tenders, prescription: RX }, undefined, MON);
    expect(sale).toMatchObject({
      scheduled: true, pharmacistRegNo: "MSPC-123456",
      prescription: { prescriberName: RX.prescriberName, prescriberRegNo: RX.prescriberRegNo, prescriberAddress: RX.prescriberAddress, rxDate: RX.rxDate },
    });
    const [doc] = await db.select().from(patientDocuments).where(eq(patientDocuments.patientId, fx.patient.id));
    expect(doc).toMatchObject({ id: sale.prescription!.documentId, kind: "outside_prescription" });
    expect(docs.files.size).toBe(1);
    const [line] = await db.select().from(pharmacyRetailSaleLines).where(eq(pharmacyRetailSaleLines.saleId, sale.id));
    const [reg] = await db.select().from(pharmacyRegH1).where(eq(pharmacyRegH1.retailLineId, line!.id));
    expect(reg).toMatchObject({
      dispenseLineId: null, patientId: fx.patient.id, patientName: "Asha Devi", prescriberName: RX.prescriberName,
      prescriberRegNo: RX.prescriberRegNo, prescriberAddress: RX.prescriberAddress, batchNo: "AZ-9", qtyBase: 3, unit: "tablet",
      pharmacistRegNo: "MSPC-123456", recordedBy: fx.pharmacist.id,
    });
    await grantPermissionToRole(db, fx.registry, "pharmacy", "pharmacy.register.read");
    const register = await h1Register(db, fx.pharmacist.actor, { from: "2026-08-17", to: "2026-08-17" });
    expect(register.rows).toEqual([expect.objectContaining({ source: "walk_in", prescriberAddress: RX.prescriberAddress, drugName: "Azee 500 500 mg tablet" })]);
  });

  it("never sells Schedule X, an expired batch, more than the batch holds, or to a customer recorded allergic", async () => {
    await open();
    const alprax = await withTx(db, async (tx) => {
      const { itemId } = await registerItem(tx, HEAD, {
        code: "ALPX05", name: "Alprax 0.5 tablet", class: "drug", baseUom: "tablet", batchTracked: true,
        formularyMedicineId: fx.med.alprax, gstRateBps: 1200, uoms: [],
      });
      await registerSaleItem(tx, fx.pharmacist.actor, itemId);
      return itemId;
    });
    await stockIn(db, fx, { itemId: alprax, batchNo: "X-1", qtyBase: 30, resourceId: retailId });
    expect(await searchRetailShelf(db, fx.pharmacist.actor, "alprax", MON)).toEqual([]);
    await expect(previewRetailSale(db, fx.pharmacist.actor, { lines: [{ medicineId: fx.med.alprax, qtyBase: 10 }] }, MON))
      .rejects.toMatchObject({ code: "schedule_x_not_dispensed_here" });

    const expired = await stockIn(db, fx, { itemId: fx.item.crocin, batchNo: "OLD", qtyBase: 50, expiryDate: "2026-08-16", resourceId: retailId });
    const good = await stockIn(db, fx, { itemId: fx.item.crocin, batchNo: "NEW", qtyBase: 20, expiryDate: "2027-01-31", resourceId: retailId });
    await expect(previewRetailSale(db, fx.pharmacist.actor, { lines: [{ medicineId: fx.med.crocin, qtyBase: 10, batchId: expired }] }, MON))
      .rejects.toMatchObject({ code: "batch_expired" });
    // FEFO skips the expired batch and offers the one in date.
    expect((await previewRetailSale(db, fx.pharmacist.actor, { lines: [{ medicineId: fx.med.crocin, qtyBase: 10 }] }, MON)).lines[0]?.batchId).toBe(good);
    await expect(previewRetailSale(db, fx.pharmacist.actor, { lines: [{ medicineId: fx.med.crocin, qtyBase: 30 }] }, MON))
      .rejects.toMatchObject({ code: "short_stock", detail: { available: 20 } });
    // Two lines of one batch that together exceed it: the ledger refuses the sale whole.
    const twice = [{ medicineId: fx.med.crocin, qtyBase: 15 }, { medicineId: fx.med.crocin, qtyBase: 15 }];
    await expect(sellRetail(db, docs, fx.pharmacist.actor, { customer: { existingId: fx.patient.id }, lines: twice, tenders: await pay(fx.patient.id, twice) }, undefined, MON))
      .rejects.toMatchObject({ code: "short_stock" });
    expect(await onHand(retailId, good)).toBe(20);
    expect(await db.select().from(invoices)).toEqual([]);

    // Allergic to paracetamol: the preview says so, and the sale is refused.
    const allergic = await mkPatient(db, fx.clerk.actor, { name: "Kiran Rao", phone: "9000011111" });
    await addAllergy(db, allergic.id, "Paracetamol");
    const lines = [{ medicineId: fx.med.crocin, qtyBase: 10 }];
    expect((await previewRetailSale(db, fx.pharmacist.actor, { patientId: allergic.id, lines }, MON)).checks?.allergies).toEqual([
      expect.objectContaining({ lineIdx: 0 }),
    ]);
    await expect(sellRetail(db, docs, fx.pharmacist.actor, { customer: { existingId: allergic.id }, lines, tenders: await pay(allergic.id, lines) }, undefined, MON))
      .rejects.toMatchObject({ code: "allergy_block" });
    expect(await db.select().from(stockLedger).where(and(eq(stockLedger.refType, RETAIL_REF_TYPE), eq(stockLedger.patientId, allergic.id)))).toEqual([]);
  });
});
