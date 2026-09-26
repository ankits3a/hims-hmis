import { and, eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { openSessionFor } from "../../../test/helpers/billing";
import { MON, MON2, MON3, issueRx, line, seedPharmacyBase } from "../../../test/helpers/pharmacy";
import { ensureRole, mkUser, testCfg } from "../../../test/helpers/opd";
import { setPin } from "../../kernel/auth/identity";
import { grantPermissionToRole } from "../../kernel/auth/permissions";
import { seedSodPairs } from "../../kernel/auth/sod";
import { withTx } from "../../kernel/db/client";
import {
  controlledStockRegister, events, invoices, opdDoctors, patients, pharmacyRegH1, rolePermissions, stockBalances, stockBatches, stockLedger,
} from "../../kernel/db/schema";
import { addMedicine, addSalt } from "../formulary";
import { createStore, postMovement, registerItem } from "../materials";
import { billDispense, previewDispenseBill } from "./bill";
import { claimDispense, findAtCounter } from "./claim";
import { recordControlledLicence, recordEndPrescriber } from "./controlled";
import { captureRetainedPrescription } from "./controlled-dispense";
import { handOverDispense } from "./handover";
import { pickDispense } from "./pick";
import { getDispense } from "./queue";
import { registerSaleItem } from "./sale-items";
import { verifyDispense } from "./verify";
import type { PharmacyFixture } from "../../../test/helpers/pharmacy";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { DocumentStore } from "../../kernel/documents/store";
import type { RecordControlledLicenceInput } from "./controlled";

/**
 * ═══ PHARMACY P6 — A CONTROLLED LINE AT THE DESK (brief 2026-09-26) ═══
 *
 * Schedule X was refused at the OPD counter "until double custody". The custody now exists, so the refusal
 * stands exactly where the licence is missing or lapsed (Form 20F; RMI recognition for a narcotic drug),
 * and a controlled line that IS dispensed is picked from the cabinet and handed over only when the
 * prescription carries what the law asks, the pharmacy keeps its copy, who took it is written down, and a
 * second person witnesses it with their own PIN. Each issue writes a register row with both keys.
 */
class FakeStore implements DocumentStore {
  readonly files = new Map<string, Buffer>();
  async put(key: string, bytes: Buffer): Promise<void> { this.files.set(key, bytes); }
  async get(key: string): Promise<Buffer> { const b = this.files.get(key); if (b === undefined) throw new Error("not found"); return b; }
  async remove(key: string): Promise<void> { this.files.delete(key); }
}
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const HEAD: Actor = { type: "user", id: "01HMATERIALSHEAD00000000001" };
const PIN = "2468";

const FORM_20F: RecordControlledLicenceInput = {
  kind: "schedule_x", licenceNo: "20F-MH-PUN-0042", form: "Form 20F", issuingAuthority: "Licensing Authority, FDA Maharashtra",
  holderName: "Sunrise Hospital Pharmacy", responsiblePerson: "A. Kulkarni (pharmacist)", validFrom: "2026-01-01", validUntil: "2030-12-31",
};
const FORM_3G: RecordControlledLicenceInput = {
  kind: "ndps_rmi", licenceNo: "RMI/MH/2026/117", form: "Form 3G", issuingAuthority: "Controller of Drugs, Maharashtra",
  holderName: "Sunrise Hospital", responsiblePerson: "Dr S. Rao (designated RMP)", validFrom: "2026-01-01", validUntil: "2028-12-31",
};

describe("narcotic, psychotropic and Schedule X lines at the desk (pharmacy P6)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: PharmacyFixture;
  let docs: FakeStore;
  let keeper: { id: string; actor: Actor };
  let cabinet: string;
  let morphine: string;
  let alpraxItem: string;
  let morphineItem: string;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    fx = await seedPharmacyBase(db);
    await seedSodPairs(db);
    docs = new FakeStore();
    await openSessionFor(db, { id: fx.pharmacist.id }, 0);
    for (const p of ["pharmacy.ndps.custody", "pharmacy.ndps.witness"]) await grantPermissionToRole(db, fx.registry, "pharmacy", p);
    await ensureRole(db, "pharmacy_incharge");
    for (const p of ["pharmacy.licences.manage", "pharmacy.ndps.custody", "pharmacy.ndps.witness", "pharmacy.register.read"]) await grantPermissionToRole(db, fx.registry, "pharmacy_incharge", p);
    keeper = await mkUser(db, "ph.keeper", ["pharmacy_incharge"]);
    await setPin(db, fx.incharge.id, PIN);
    await setPin(db, fx.pharmacist.id, PIN);
    await setPin(db, fx.aide.id, PIN);
    await db.update(patients).set({ addressLine: "12 MG Road, Pune 411001" }).where(eq(patients.id, fx.patient.id));
    ({ resourceId: cabinet } = await withTx(db, (tx) => createStore(tx, HEAD, { code: "PHARM-NDPS", name: "Controlled-drug cabinet", attributes: { controlled: true } })));
    morphine = await withTx(db, async (tx) => {
      const salt = await addSalt(tx, fx.pharmacist.actor, { name: "Morphine", drugClass: "opioid", ndpsClass: "narcotic" });
      return (await addMedicine(tx, fx.pharmacist.actor, { brandName: "Morcontin 10", form: "tablet", routeClass: "systemic", strengthLabel: "10 mg", scheduleFlag: "H", salts: [{ saltId: salt.saltId, strength: "10 mg" }] })).medicineId;
    });
    const cabinetItem = async (code: string, medicineId: string): Promise<string> => withTx(db, async (tx) => {
      const { itemId } = await registerItem(tx, HEAD, {
        code, name: `${code} tablet`, class: "drug", baseUom: "tablet", batchTracked: true, formularyMedicineId: medicineId, gstRateBps: 1200, storageClass: "narcotic",
        uoms: [{ uom: "strip", toBaseMultiplier: 10, isPurchaseUom: true, isIssueUom: true }],
      });
      await registerSaleItem(tx, fx.pharmacist.actor, itemId);
      return itemId;
    });
    alpraxItem = await cabinetItem("ALPRAX05", fx.med.alprax);
    morphineItem = await cabinetItem("MORC10", morphine);
    for (const [itemId, batchNo] of [[alpraxItem, "AX-1"], [morphineItem, "MO-1"]] as const) {
      const batchId = newId();
      await db.insert(stockBatches).values({ id: batchId, itemId, batchNo, expiryDate: "2027-12-31", mrpPaise: 5000, mrpUom: "strip", landedCostPaise: 300, ownership: "owned", createdBy: HEAD.id });
      // Received into the cabinet under two keys: the pharmacist holds, the in-charge witnesses.
      await withTx(db, (tx) => postMovement(tx, fx.pharmacist.actor, {
        resourceId: cabinet, batchId, qtyDelta: 60, reason: "grn", refType: "test", refId: batchId, occurredAt: MON,
        custody: { witnessId: fx.incharge.id, counterparty: "ACME Pharma", documentRef: "INV-77" },
      }));
    }
  });
  afterEach(() => { fx.unregister(); });

  const alprax = (over: Partial<Parameters<typeof line>[0]> = {}) => line({ drug: "Alprax 0.5", medicineId: fx.med.alprax, frequency: "OD", durationDays: 10, ...over });
  const morcontin = () => line({ drug: "Morcontin 10", medicineId: morphine, frequency: "BD", durationDays: 5 });

  async function claimed(lines: Parameters<typeof issueRx>[2]): Promise<{ id: string; tokenNo: number | null }> {
    const { issued, tokenNo } = await issueRx(db, fx, lines);
    const r = await findAtCounter(db, testCfg, fx.pharmacist.actor, issued.qrPayload, MON2);
    if (r.kind !== "dispense") throw new Error("no dispense");
    await claimDispense(db, fx.pharmacist.actor, { dispenseId: r.dispense.id, door: "rx_qr" }, MON2);
    return { id: r.dispense.id, tokenNo };
  }

  async function billed(lines: Parameters<typeof issueRx>[2], qty: number[]): Promise<{ id: string; tokenNo: number | null }> {
    const c = await claimed(lines);
    await verifyDispense(db, fx.pharmacist.actor, fx.decls, c.id, { lines: qty.map((q, i) => ({ lineIdx: i, qtyBase: q })) }, MON2);
    await pickDispense(db, fx.pharmacist.actor, fx.decls, c.id, {}, MON2);
    const preview = await previewDispenseBill(db, fx.pharmacist.actor, c.id, MON2);
    await billDispense(db, fx.pharmacist.actor, c.id, { tenders: [{ mode: "cash", amountPaise: preview.totals.netPayablePaise }] }, MON2);
    return c;
  }

  async function retained(dispenseId: string): Promise<string> {
    return (await captureRetainedPrescription(db, docs, fx.pharmacist.actor, dispenseId, { mimeType: "image/jpeg", bytes: JPEG }, MON3)).documentId;
  }

  const controlledInput = (documentId: string, over: Record<string, unknown> = {}) => ({
    witness: { username: "ph.incharge", pin: PIN },
    collectedBy: { name: "Ramesh Devi", relation: "son", idProof: "Aadhaar ending 4321" },
    retainedDocumentId: documentId, endorsed: true, ...over,
  });

  it("Schedule X with no Form 20F on file is refused at the claim — the existing refusal, now naming the licence", async () => {
    await expect(claimed([alprax()])).rejects.toMatchObject({ code: "schedule_x_not_dispensed_here", message: expect.stringContaining("Form 20F") });
  });

  it("Schedule X under a LAPSED Form 20F is refused the same way, with the day it lapsed", async () => {
    await recordControlledLicence(db, keeper.actor, { ...FORM_20F, validFrom: "2025-01-01", validUntil: "2026-06-30" }, MON);
    await expect(claimed([alprax()])).rejects.toMatchObject({ code: "schedule_x_not_dispensed_here", message: expect.stringContaining("lapsed on 2026-06-30") });
  });

  it("with a current Form 20F and every condition met, a Schedule X line is picked from the CABINET and handed over under two keys; the register row carries both", async () => {
    await recordControlledLicence(db, keeper.actor, FORM_20F, MON);
    const { id, tokenNo } = await billed([alprax()], [10]);
    const picked = await getDispense(db, fx.pharmacist.actor, id, MON3);
    expect(picked.lines[0]).toMatchObject({ scheduleFlag: "X", controlled: true });
    // The agent's card: what the law asks, before the witness is called.
    expect(picked.controlled?.blocking).toEqual([]);
    expect(picked.controlled?.checks.filter((c) => c.atHandover).map((c) => c.key)).toEqual(["retained_prescription", "endorsement", "collected_by", "witness"]);
    const [cabinetBalance] = await db.select().from(stockBalances).where(and(eq(stockBalances.resourceId, cabinet)));
    expect(cabinetBalance?.qtyReserved).toBeGreaterThan(0); // the reservation is at the cabinet, not the counter

    const doc = await retained(id);
    const done = await handOverDispense(db, fx.pharmacist.actor, fx.decls, id, { identity: { via: "token", value: String(tokenNo) }, controlled: controlledInput(doc) }, MON3);
    expect(done.status).toBe("handed_over");
    const reg = await db.select().from(controlledStockRegister).where(eq(controlledStockRegister.movement, "consume"));
    const [invoice] = await db.select().from(invoices).where(eq(invoices.id, done.invoiceId!));
    expect(reg).toHaveLength(1);
    expect(reg[0]).toMatchObject({
      scheduleFlag: "X", direction: "out", qtyBase: 10, balanceAfter: 50, holderId: fx.pharmacist.id, witnessId: fx.incharge.id,
      holderRegNo: "MSPC-123456", counterparty: expect.any(String), counterpartyAddress: "12 MG Road, Pune 411001", patientId: fx.patient.id,
      prescriberRegNo: "BMC/12345", retainedDocumentId: doc, collectedBy: "Ramesh Devi (son)", collectedIdProof: "Aadhaar ending 4321",
      documentRef: invoice!.invoiceNo,
    });
    const [consume] = await db.select().from(stockLedger).where(eq(stockLedger.id, reg[0]!.ledgerEntryId));
    expect(consume).toMatchObject({ resourceId: cabinet, reason: "consume", actorId: fx.pharmacist.id, witnessId: fx.incharge.id });
    const [ev] = await db.select().from(events).where(eq(events.name, "dispense.handed_over"));
    expect(ev?.payload).toMatchObject({ controlledRegisterRows: 1, witnessId: fx.incharge.id });
    // Schedule X is not H1: the H1 register is not where it goes.
    expect(await db.select().from(pharmacyRegH1)).toEqual([]);
  });

  it("a narcotic line (NDPS) needs the RMI recognition — refused without it, naming Form 3G", async () => {
    await expect(claimed([morcontin()])).rejects.toMatchObject({ code: "ndps_not_dispensed_here", message: expect.stringContaining("Form 3G") });
  });

  it("a narcotic line from a doctor not trained under r.2(ib) is refused at the hand-over; recorded, it goes", async () => {
    await recordControlledLicence(db, keeper.actor, FORM_3G, MON);
    const { id, tokenNo } = await billed([morcontin()], [10]);
    const doc = await retained(id);
    const input = { identity: { via: "token" as const, value: String(tokenNo) }, controlled: controlledInput(doc, { endorsed: undefined }) };
    await expect(handOverDispense(db, fx.pharmacist.actor, fx.decls, id, input, MON3)).rejects.toMatchObject({ code: "end_prescriber_not_trained" });
    await recordEndPrescriber(db, keeper.actor, { doctorId: fx.doctor.doctorId, training: "IAPC foundation course in palliative care, 2024" }, MON);
    expect((await handOverDispense(db, fx.pharmacist.actor, fx.decls, id, input, MON3)).status).toBe("handed_over");
    const [row] = await db.select().from(controlledStockRegister).where(eq(controlledStockRegister.movement, "consume"));
    expect(row).toMatchObject({ ndpsClass: "narcotic", qtyBase: 10, balanceAfter: 50 });
  });

  it("the prescription must carry the prescriber's registration number and the patient's address", async () => {
    await recordControlledLicence(db, keeper.actor, FORM_20F, MON);
    const { id, tokenNo } = await billed([alprax()], [10]);
    const doc = await retained(id);
    const input = { identity: { via: "token" as const, value: String(tokenNo) }, controlled: controlledInput(doc) };
    await db.update(opdDoctors).set({ registrationNo: null }).where(eq(opdDoctors.id, fx.doctor.doctorId));
    await expect(handOverDispense(db, fx.pharmacist.actor, fx.decls, id, input, MON3)).rejects.toMatchObject({ code: "controlled_prescription_incomplete", message: expect.stringContaining("registration number") });
    await db.update(opdDoctors).set({ registrationNo: "BMC/12345" }).where(eq(opdDoctors.id, fx.doctor.doctorId));
    await db.update(patients).set({ addressLine: null }).where(eq(patients.id, fx.patient.id));
    await expect(handOverDispense(db, fx.pharmacist.actor, fx.decls, id, input, MON3)).rejects.toMatchObject({ code: "controlled_prescription_incomplete", message: expect.stringContaining("address") });
  });

  it("no retained prescription, no hand-over; nor one that is not this patient's", async () => {
    await recordControlledLicence(db, keeper.actor, FORM_20F, MON);
    const { id, tokenNo } = await billed([alprax()], [10]);
    const identity = { via: "token" as const, value: String(tokenNo) };
    await expect(handOverDispense(db, fx.pharmacist.actor, fx.decls, id, { identity }, MON3)).rejects.toMatchObject({ code: "retained_prescription_required" });
    await expect(handOverDispense(db, fx.pharmacist.actor, fx.decls, id, { identity, controlled: controlledInput(newId()) }, MON3)).rejects.toMatchObject({ code: "retained_prescription_required" });
  });

  it("more than the prescription states is refused (dose × frequency × days)", async () => {
    await recordControlledLicence(db, keeper.actor, FORM_20F, MON);
    const { id, tokenNo } = await billed([alprax({ durationDays: 5 })], [8]); // OD × 5 days = 5
    const doc = await retained(id);
    await expect(handOverDispense(db, fx.pharmacist.actor, fx.decls, id, { identity: { via: "token", value: String(tokenNo) }, controlled: controlledInput(doc) }, MON3))
      .rejects.toMatchObject({ code: "controlled_qty_exceeds_prescribed", message: expect.stringContaining("8 of 5") });
  });

  it("the holder cannot be the witness (the SoD engine records the attempt); a wrong PIN and a witness without the grant are refused", async () => {
    await recordControlledLicence(db, keeper.actor, FORM_20F, MON);
    const { id, tokenNo } = await billed([alprax()], [10]);
    const doc = await retained(id);
    const identity = { via: "token" as const, value: String(tokenNo) };
    await expect(handOverDispense(db, fx.pharmacist.actor, fx.decls, id, { identity, controlled: controlledInput(doc, { witness: { username: "ph.mehta", pin: PIN } }) }, MON3))
      .rejects.toMatchObject({ code: "custody_same_person" });
    expect(await db.select().from(events).where(eq(events.name, "sod.violation_blocked"))).toHaveLength(1);
    await expect(handOverDispense(db, fx.pharmacist.actor, fx.decls, id, { identity, controlled: controlledInput(doc, { witness: { username: "ph.incharge", pin: "0000" } }) }, MON3))
      .rejects.toMatchObject({ code: "witness_not_confirmed" });
    await expect(handOverDispense(db, fx.pharmacist.actor, fx.decls, id, { identity, controlled: controlledInput(doc, { witness: { username: "aide.ravi", pin: PIN } }) }, MON3))
      .rejects.toMatchObject({ code: "witness_not_permitted" });
    expect(await db.select().from(controlledStockRegister).where(eq(controlledStockRegister.movement, "consume"))).toEqual([]);
  });

  it("Schedule X: the prescription is endorsed with the seller's name, address and date (r.65(11)(c)); who took it is written down", async () => {
    await recordControlledLicence(db, keeper.actor, FORM_20F, MON);
    const { id, tokenNo } = await billed([alprax()], [10]);
    const doc = await retained(id);
    const identity = { via: "token" as const, value: String(tokenNo) };
    await expect(handOverDispense(db, fx.pharmacist.actor, fx.decls, id, { identity, controlled: controlledInput(doc, { endorsed: false }) }, MON3))
      .rejects.toMatchObject({ code: "endorsement_required" });
    await expect(handOverDispense(db, fx.pharmacist.actor, fx.decls, id, { identity, controlled: controlledInput(doc, { collectedBy: { name: "", relation: "self", idProof: "" } }) }, MON3))
      .rejects.toMatchObject({ code: "collected_by_required" });
  });

  it("the person handing it over holds a key of the cabinet (`pharmacy.ndps.custody`) — a pharmacist without one is refused before any witness is asked", async () => {
    await recordControlledLicence(db, keeper.actor, FORM_20F, MON);
    const { id, tokenNo } = await billed([alprax()], [10]);
    const doc = await retained(id);
    await db.delete(rolePermissions).where(and(eq(rolePermissions.roleKey, "pharmacy"), eq(rolePermissions.permission, "pharmacy.ndps.custody")));
    await expect(handOverDispense(db, fx.pharmacist.actor, fx.decls, id, { identity: { via: "token", value: String(tokenNo) }, controlled: controlledInput(doc) }, MON3))
      .rejects.toMatchObject({ code: "custody_not_permitted" });
  });
});
