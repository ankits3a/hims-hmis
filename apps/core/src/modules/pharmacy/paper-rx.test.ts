import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { openSessionFor } from "../../../test/helpers/billing";
import { MON2, MON3, addAllergy, openVisitWithoutRx, seedPharmacyBase, stockIn } from "../../../test/helpers/pharmacy";
import { testCfg } from "../../../test/helpers/opd";
import { events, opdDoctors, opdEncounters, opdPrescriptions, opdQueueEntries, orders, patientDocuments, pharmacyRegH1, stockBalances } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { registerItem } from "../materials";
import { chargeOrphans } from "../billing";
import { listVisits } from "../opd";
import { registerPatient } from "../patients";
import { billDispense, previewDispenseBill } from "./bill";
import { findAtCounter, suggestAtCounter } from "./claim";
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

  /* Owner, staging 2026-10-01: a registered patient must show as the pharmacist types the name. */
  it("as the pharmacist types: a registered patient is suggested by part of the name; a token or a QR is never a name", async () => {
    const { patient } = await withTx(db, (tx) => registerPatient(tx, fx.pharmacist.actor, { name: "Abhishek Kumar", phone: "9811122233", ageYears: 54, sex: "male" }));
    const typed = "abhi";
    const hits = await suggestAtCounter(db, fx.pharmacist.actor, typed, MON2);
    expect(hits.find((h) => h.uhid === patient.uhid)).toMatchObject({ id: patient.id, name: "Abhishek Kumar", restricted: false, hint: expect.stringContaining("••2233") });
    expect(await suggestAtCounter(db, fx.pharmacist.actor, typed.slice(0, 1), MON2)).toEqual([]);
    expect(await suggestAtCounter(db, fx.pharmacist.actor, "T-14", MON2)).toEqual([]);
    expect(await suggestAtCounter(db, fx.pharmacist.actor, "rx1.abc", MON2)).toEqual([]);
  });

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

  it("a future date is refused", async () => {
    await expect(enterPaperPrescription(db, testCfg, store, fx.pharmacist.actor, {
      patientId: fx.patient.id, rxDate: "2026-08-18", lines: [{ itemId: fx.item.crocin, qtyBase: 10 }],
    }, MON2)).rejects.toThrow(expect.objectContaining({ code: "invalid_prescription" }));
  });

  /** Hand a claimed ticket over the ordinary road and return it. */
  async function throughTheCounter(dispenseId: string, qtyBase: number, identity?: { via: "phone_last4"; value: string }): Promise<void> {
    await verifyDispense(db, fx.pharmacist.actor, fx.decls, dispenseId, { lines: [{ lineIdx: 0, qtyBase }] }, MON2);
    await pickDispense(db, fx.pharmacist.actor, fx.decls, dispenseId, {}, MON2);
    await confirmSlip(db, fx.pharmacist.actor, dispenseId, MON2);
    const preview = await previewDispenseBill(db, fx.pharmacist.actor, dispenseId, MON2);
    await billDispense(db, fx.pharmacist.actor, dispenseId, { tenders: [{ mode: "cash", amountPaise: preview.totals.netPayablePaise }] }, MON2);
    await handOverDispense(db, fx.pharmacist.actor, fx.decls, dispenseId, identity === undefined ? {} : { identity }, MON3);
  }

  const OUTSIDE = { name: "Dr Suresh Rao", registrationNo: "KMC/55555", address: "12 MG Road, Bengaluru" };

  describe("paper prescription for anyone (2026-09-30, owner)", () => {
    it("nobody found → registered at the counter → paper → a NO-FEE pharmacy visit → ticket → bill → stock falls", async () => {
      expect(await findAtCounter(db, testCfg, fx.pharmacist.actor, "Ramesh Kulkarni", MON2)).toMatchObject({ kind: "none", reason: "not_found" });
      const { patient } = await withTx(db, (tx) => registerPatient(tx, fx.pharmacist.actor, { name: "Ramesh Kulkarni", phone: "9811122233", ageYears: 54, sex: "male" }));

      const d = await enterPaperPrescription(db, testCfg, store, fx.pharmacist.actor, {
        patientId: patient.id, rxDate: RX_DATE, doctorId: fx.doctor.doctorId,
        lines: [{ itemId: fx.item.crocin, qtyBase: 10, frequency: "TDS" }],
      }, MON2);
      expect(d.status).toBe("claimed");
      const [visit] = await db.select().from(opdEncounters).where(eq(opdEncounters.id, d.encounterId));
      // no consultation: no doctor, no department, no queue entry, no token; not an OPD visit
      expect(visit).toMatchObject({ type: "pharmacy", doctorId: null, departmentId: null, serviceDate: RX_DATE, patientId: patient.id });
      expect(await db.select().from(opdQueueEntries).where(eq(opdQueueEntries.encounterId, d.encounterId))).toHaveLength(0);
      // never an OPD consultation: not on the visit list, not an uncharged consult in the day's orphan scan
      expect((await listVisits(db, { serviceDate: RX_DATE })).map((v) => v.id)).not.toContain(d.encounterId);
      expect((await chargeOrphans(db, RX_DATE)).map((o) => o.encounterId)).not.toContain(d.encounterId);
      const [rx] = await db.select().from(opdPrescriptions).where(eq(opdPrescriptions.encounterId, d.encounterId));
      expect(rx).toMatchObject({ doctorId: fx.doctor.doctorId, transcribedBy: fx.pharmacist.id });

      await throughTheCounter(d.id, 10);
      const bal = await db.select().from(stockBalances).where(eq(stockBalances.itemId, fx.item.crocin));
      expect(bal.reduce((s, b) => s + b.qtyOnHand, 0)).toBe(90);
      // the desk finds the paper ticket again by name
      expect(await findAtCounter(db, testCfg, fx.pharmacist.actor, "Ramesh Kulkarni", MON3)).toMatchObject({ kind: "dispense", dispense: { id: d.id } });
    });

    it("a visit that already carries a prescription is left alone: the next paper gets its own pharmacy visit", async () => {
      const opd = await visitWithoutRx(); // the first paper lands on it, so it now carries an active prescription
      await enterPaperPrescription(db, testCfg, store, fx.pharmacist.actor, {
        patientId: fx.patient.id, rxDate: RX_DATE, lines: [{ itemId: fx.item.crocin, qtyBase: 10 }],
      }, MON2);
      const d2 = await enterPaperPrescription(db, testCfg, store, fx.pharmacist.actor, {
        patientId: fx.patient.id, rxDate: RX_DATE, doctorId: fx.doctor.doctorId, lines: [{ itemId: fx.item.crocin, qtyBase: 6 }],
      }, MON2);
      expect(d2.encounterId).not.toBe(opd);
      const [v] = await db.select().from(opdEncounters).where(eq(opdEncounters.id, d2.encounterId));
      expect(v?.type).toBe("pharmacy");
    });

    it("the audit trail: the registration, the pharmacy visit, the paper entry", async () => {
      const { patient } = await withTx(db, (tx) => registerPatient(tx, fx.pharmacist.actor, { name: "Sunita Devi", phone: "9822233344", ageYears: 40, sex: "female" }));
      const d = await enterPaperPrescription(db, testCfg, store, fx.pharmacist.actor, {
        patientId: patient.id, rxDate: RX_DATE, outside: OUTSIDE, lines: [{ itemId: fx.item.crocin, qtyBase: 10 }],
      }, MON2);
      const names = (await db.select().from(events)).filter((e) => e.patientId === patient.id).map((e) => e.name);
      expect(names).toEqual(expect.arrayContaining(["patient.registered", "paper_rx.visit_opened", "paper_rx.entered"]));
      const [opened] = await db.select().from(events).where(eq(events.name, "paper_rx.visit_opened"));
      expect(opened?.payload).toMatchObject({ encounterId: d.encounterId, patientId: patient.id, rxDate: RX_DATE, openedBy: fx.pharmacist.id });
      const [entered] = await db.select().from(events).where(eq(events.name, "paper_rx.entered"));
      expect(entered?.payload).toMatchObject({
        doctorId: null, outside: true, prescriberName: OUTSIDE.name, prescriberRegNo: OUTSIDE.registrationNo, prescriberAddress: OUTSIDE.address,
      });
    });

    it("an OUTSIDE doctor on H1: refused without the registration number (or address); with them, written to the H1 register", async () => {
      const h1 = { patientId: fx.patient.id, rxDate: RX_DATE, photo: JPEG, lines: [{ itemId: fx.item.azithro, qtyBase: 3 }] };
      await expect(enterPaperPrescription(db, testCfg, store, fx.pharmacist.actor, { ...h1, outside: { ...OUTSIDE, registrationNo: "" } }, MON2))
        .rejects.toThrow(expect.objectContaining({ code: "invalid_prescription" }));
      await expect(enterPaperPrescription(db, testCfg, store, fx.pharmacist.actor, { ...h1, outside: { ...OUTSIDE, address: " " } }, MON2))
        .rejects.toThrow(expect.objectContaining({ code: "invalid_prescription" }));
      await expect(enterPaperPrescription(db, testCfg, store, fx.pharmacist.actor, { ...h1, photo: undefined, outside: OUTSIDE }, MON2))
        .rejects.toThrow(expect.objectContaining({ code: "prescription_required" }));
      expect(await db.select().from(opdPrescriptions)).toHaveLength(0);
      expect(await db.select().from(opdEncounters).where(eq(opdEncounters.type, "pharmacy"))).toHaveLength(0);

      const d = await enterPaperPrescription(db, testCfg, store, fx.pharmacist.actor, { ...h1, outside: OUTSIDE }, MON2);
      const [rx] = await db.select().from(opdPrescriptions).where(eq(opdPrescriptions.encounterId, d.encounterId));
      expect(rx).toMatchObject({
        doctorId: null, outsidePrescriberName: OUTSIDE.name, outsidePrescriberRegNo: OUTSIDE.registrationNo,
        outsidePrescriberAddress: OUTSIDE.address, transcribedBy: fx.pharmacist.id,
      });
      await throughTheCounter(d.id, 3, { via: "phone_last4", value: "3210" });
      const reg = await db.select().from(pharmacyRegH1);
      expect(reg.map((r) => [r.prescriberName, r.prescriberRegNo, r.prescriberAddress, r.qtyBase])).toEqual([[OUTSIDE.name, OUTSIDE.registrationNo, OUTSIDE.address, 3]]);
      // the ordering clinician of record is the dispensing pharmacist
      const [order] = await db.select().from(orders).where(eq(orders.patientId, fx.patient.id));
      expect(order?.orderingClinicianId).toBe(fx.pharmacist.id);
    });

    it("an OUTSIDE doctor: Schedule X refused, a recorded allergy refused — nothing written", async () => {
      const { itemId } = await withTx(db, async (tx) => registerItem(tx, fx.pharmacist.actor, {
        code: "ALPX05", name: "Alprax 0.5 tablet", class: "drug", baseUom: "tablet", batchTracked: true, formularyMedicineId: fx.med.alprax, gstRateBps: 1200,
        uoms: [{ uom: "strip", toBaseMultiplier: 10, isPurchaseUom: true, isIssueUom: true }],
      }));
      await expect(enterPaperPrescription(db, testCfg, store, fx.pharmacist.actor, {
        patientId: fx.patient.id, rxDate: RX_DATE, photo: JPEG, outside: OUTSIDE, lines: [{ itemId, qtyBase: 10 }],
      }, MON2)).rejects.toThrow(expect.objectContaining({ code: "paper_rx_controlled" }));
      await addAllergy(db, fx.patient.id, "Paracetamol");
      await expect(enterPaperPrescription(db, testCfg, store, fx.pharmacist.actor, {
        patientId: fx.patient.id, rxDate: RX_DATE, outside: OUTSIDE, lines: [{ itemId: fx.item.crocin, qtyBase: 10 }],
      }, MON2)).rejects.toThrow(expect.objectContaining({ code: "allergy_block" }));
      expect(await db.select().from(opdPrescriptions)).toHaveLength(0);
      expect(await db.select().from(opdEncounters).where(eq(opdEncounters.type, "pharmacy"))).toHaveLength(0);
    });
  });

  it("an account without pharmacy.dispense.place is refused", async () => {
    await visitWithoutRx();
    await expect(enterPaperPrescription(db, testCfg, store, fx.clerk.actor, {
      patientId: fx.patient.id, rxDate: RX_DATE, lines: [{ itemId: fx.item.crocin, qtyBase: 10 }],
    }, MON2)).rejects.toThrow(expect.objectContaining({ code: "permission_denied" }));
  });
});
