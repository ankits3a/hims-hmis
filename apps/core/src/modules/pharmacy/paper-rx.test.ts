import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { openSessionFor } from "../../../test/helpers/billing";
import { MON2, MON3, addAllergy, openVisitWithoutRx, seedPharmacyBase, stockIn } from "../../../test/helpers/pharmacy";
import { testCfg } from "../../../test/helpers/opd";
import { events, opdDoctors, opdPrescriptions, patientDocuments, pharmacyRegH1, stockBalances } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { registerItem } from "../materials";
import { billDispense, previewDispenseBill } from "./bill";
import { findAtCounter } from "./claim";
import { handOverDispense } from "./handover";
import { enterPaperPrescription } from "./paper-rx";
import { pickDispense } from "./pick";
import { confirmSlip } from "./queue";
import { verifyDispense } from "./verify";
import type { PharmacyFixture } from "../../../test/helpers/pharmacy";
import type { Db } from "../../kernel/db/client";
import type { DocumentStore } from "../../kernel/documents/store";

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
const JPEG = { mimeType: "image/jpeg", bytes: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]) };
const RX_DATE = "2026-08-17"; // MON in IST

/**
 * 2026-09-30 — THE OWNER AT THE LIVE COUNTER: a registered patient with a hospital doctor's PAPER
 * prescription and no e-prescription. The desk finds the patient, the pharmacist enters the paper,
 * and the ticket runs the ordinary road: verify, FEFO pick, bill, hand over, stock falls.
 */
describe("dispense from a paper prescription at the desk (2026-09-30)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: PharmacyFixture;
  let store: FakeStore;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    fx = await seedPharmacyBase(db);
    store = new FakeStore();
    await openSessionFor(db, { id: fx.pharmacist.id }, 0);
    await stockIn(db, fx, { itemId: fx.item.crocin, batchNo: "CR-1", expiryDate: "2027-12-31", qtyBase: 100, mrpPaise: 12000 });
    await stockIn(db, fx, { itemId: fx.item.azithro, batchNo: "AZ-1", expiryDate: "2027-06-30", qtyBase: 30, mrpPaise: 15000 });
  });
  afterEach(() => { fx.unregister(); });

  /** The patient came through the front desk and saw the doctor, who wrote on paper: a visit, no e-Rx. */
  async function visitWithoutRx(): Promise<string> {
    return (await openVisitWithoutRx(db, fx)).id;
  }

  it("found patient with no e-Rx → the paper door → an ordinary ticket → verify → pick → bill → hand over → stock falls", async () => {
    const encounterId = await visitWithoutRx();
    const found = await findAtCounter(db, testCfg, fx.pharmacist.actor, fx.patient.uhid, MON2);
    expect(found).toMatchObject({ kind: "none", reason: "no_prescription_today", patient: { id: fx.patient.id, uhid: fx.patient.uhid } });

    const d = await enterPaperPrescription(db, testCfg, store, fx.pharmacist.actor, {
      patientId: fx.patient.id, rxDate: RX_DATE,
      lines: [{ itemId: fx.item.crocin, qtyBase: 15, dose: "1 tab", frequency: "TDS", durationDays: 5 }],
    }, MON2);
    expect(d.status).toBe("claimed");
    expect(d.claimedBy).toBe(fx.pharmacist.id);
    expect(d.encounterId).toBe(encounterId);
    expect(d.lines[0]).toMatchObject({ item: { id: fx.item.crocin }, qtyBase: 15 });
    const [rx] = await db.select().from(opdPrescriptions).where(eq(opdPrescriptions.encounterId, encounterId));
    expect(rx).toMatchObject({ doctorId: fx.doctor.doctorId, transcribedBy: fx.pharmacist.id, status: "active" });

    await verifyDispense(db, fx.pharmacist.actor, fx.decls, d.id, { lines: [{ lineIdx: 0, qtyBase: 15 }] }, MON2);
    await pickDispense(db, fx.pharmacist.actor, fx.decls, d.id, {}, MON2);
    // FD-31 holds for the pharmacist's own transcription: the slip is cross-confirmed before the bill.
    const preview = await previewDispenseBill(db, fx.pharmacist.actor, d.id, MON2);
    await expect(billDispense(db, fx.pharmacist.actor, d.id, { tenders: [{ mode: "cash", amountPaise: preview.totals.netPayablePaise }] }, MON2))
      .rejects.toThrow(expect.objectContaining({ code: "slip_not_confirmed" }));
    await confirmSlip(db, fx.pharmacist.actor, d.id, MON2);
    await billDispense(db, fx.pharmacist.actor, d.id, { tenders: [{ mode: "cash", amountPaise: preview.totals.netPayablePaise }] }, MON2);
    const h = await handOverDispense(db, fx.pharmacist.actor, fx.decls, d.id, {}, MON3);
    expect(h.status).toBe("handed_over");
    const bal = await db.select().from(stockBalances).where(eq(stockBalances.itemId, fx.item.crocin));
    expect(bal.reduce((s, b) => s + b.qtyOnHand, 0)).toBe(85);
  });

  it("the audit event names the door, who typed it, the prescriber, the date and the photo", async () => {
    await visitWithoutRx();
    const d = await enterPaperPrescription(db, testCfg, store, fx.pharmacist.actor, {
      patientId: fx.patient.id, rxDate: RX_DATE, photo: JPEG,
      lines: [{ itemId: fx.item.azithro, qtyBase: 3, frequency: "OD", durationDays: 3 }],
    }, MON2);
    const [ev] = await db.select().from(events).where(eq(events.name, "paper_rx.entered"));
    expect(ev?.payload).toMatchObject({
      dispenseId: d.id, source: "paper", enteredBy: fx.pharmacist.id, doctorId: fx.doctor.doctorId, prescriberRegNo: "BMC/12345",
      rxDate: RX_DATE, lines: [{ lineIdx: 0, itemId: fx.item.azithro, qtyBase: 3, scheduleFlag: "H1" }],
    });
    expect((ev?.payload as { documentId: string | null }).documentId).not.toBeNull();
    expect(await db.select().from(patientDocuments).where(eq(patientDocuments.patientId, fx.patient.id))).toHaveLength(1);
    const [queued] = await db.select().from(events).where(eq(events.name, "dispense.queued"));
    expect(queued?.payload).toMatchObject({ source: "paper" });
  });

  it("H1 is refused without the photo, and without the prescriber's registration number; the H1 register is written as usual", async () => {
    await visitWithoutRx();
    const h1 = { patientId: fx.patient.id, rxDate: RX_DATE, lines: [{ itemId: fx.item.azithro, qtyBase: 3 }] };
    await expect(enterPaperPrescription(db, testCfg, store, fx.pharmacist.actor, h1, MON2))
      .rejects.toThrow(expect.objectContaining({ code: "prescription_required" }));
    await db.update(opdDoctors).set({ registrationNo: null }).where(eq(opdDoctors.id, fx.doctor.doctorId));
    await expect(enterPaperPrescription(db, testCfg, store, fx.pharmacist.actor, { ...h1, photo: JPEG }, MON2))
      .rejects.toThrow(expect.objectContaining({ code: "invalid_prescription" }));
    expect(await db.select().from(opdPrescriptions)).toHaveLength(0);

    await db.update(opdDoctors).set({ registrationNo: "BMC/12345" }).where(eq(opdDoctors.id, fx.doctor.doctorId));
    const d = await enterPaperPrescription(db, testCfg, store, fx.pharmacist.actor, { ...h1, photo: JPEG }, MON2);
    await verifyDispense(db, fx.pharmacist.actor, fx.decls, d.id, { lines: [{ lineIdx: 0, qtyBase: 3 }] }, MON2);
    await pickDispense(db, fx.pharmacist.actor, fx.decls, d.id, {}, MON2);
    await confirmSlip(db, fx.pharmacist.actor, d.id, MON2);
    const preview = await previewDispenseBill(db, fx.pharmacist.actor, d.id, MON2);
    await billDispense(db, fx.pharmacist.actor, d.id, { tenders: [{ mode: "cash", amountPaise: preview.totals.netPayablePaise }] }, MON2);
    await handOverDispense(db, fx.pharmacist.actor, fx.decls, d.id, { identity: { via: "phone_last4", value: "3210" } }, MON3);
    const reg = await db.select().from(pharmacyRegH1);
    expect(reg.map((r) => [r.prescriberRegNo, r.qtyBase, r.batchNo])).toEqual([["BMC/12345", 3, "AZ-1"]]);
  });

  it("Schedule X is refused at this door — the doctor's e-prescription is needed", async () => {
    await visitWithoutRx();
    const { itemId } = await withTx(db, async (tx) => registerItem(tx, fx.pharmacist.actor, {
      code: "ALPX05", name: "Alprax 0.5 tablet", class: "drug", baseUom: "tablet", batchTracked: true, formularyMedicineId: fx.med.alprax, gstRateBps: 1200,
      uoms: [{ uom: "strip", toBaseMultiplier: 10, isPurchaseUom: true, isIssueUom: true }],
    }));
    await expect(enterPaperPrescription(db, testCfg, store, fx.pharmacist.actor, {
      patientId: fx.patient.id, rxDate: RX_DATE, photo: JPEG, lines: [{ itemId, qtyBase: 10 }],
    }, MON2)).rejects.toThrow(expect.objectContaining({ code: "paper_rx_controlled" }));
    expect(await db.select().from(opdPrescriptions)).toHaveLength(0);
  });

  it("a recorded allergy refuses the paper — no prescriber is here to override it", async () => {
    await visitWithoutRx();
    await addAllergy(db, fx.patient.id, "Paracetamol");
    await expect(enterPaperPrescription(db, testCfg, store, fx.pharmacist.actor, {
      patientId: fx.patient.id, rxDate: RX_DATE, lines: [{ itemId: fx.item.crocin, qtyBase: 10 }],
    }, MON2)).rejects.toThrow(expect.objectContaining({ code: "allergy_block" }));
    expect(await db.select().from(opdPrescriptions)).toHaveLength(0);
  });

  it("no visit on the paper's date is refused by name; a future date is refused", async () => {
    await expect(enterPaperPrescription(db, testCfg, store, fx.pharmacist.actor, {
      patientId: fx.patient.id, rxDate: RX_DATE, lines: [{ itemId: fx.item.crocin, qtyBase: 10 }],
    }, MON2)).rejects.toThrow(expect.objectContaining({ code: "paper_rx_no_visit" }));
    await expect(enterPaperPrescription(db, testCfg, store, fx.pharmacist.actor, {
      patientId: fx.patient.id, rxDate: "2026-08-18", lines: [{ itemId: fx.item.crocin, qtyBase: 10 }],
    }, MON2)).rejects.toThrow(expect.objectContaining({ code: "invalid_prescription" }));
  });

  it("an account without pharmacy.dispense.place is refused", async () => {
    await visitWithoutRx();
    await expect(enterPaperPrescription(db, testCfg, store, fx.clerk.actor, {
      patientId: fx.patient.id, rxDate: RX_DATE, lines: [{ itemId: fx.item.crocin, qtyBase: 10 }],
    }, MON2)).rejects.toThrow(expect.objectContaining({ code: "permission_denied" }));
  });
});
