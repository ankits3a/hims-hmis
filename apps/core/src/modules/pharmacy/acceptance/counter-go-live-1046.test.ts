import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { openSessionFor } from "../../../../test/helpers/billing";
import { MON, MON2, MON3, issueRx, line, seedPharmacyBase, stockIn } from "../../../../test/helpers/pharmacy";
import { ensureRole, mkPatient, mkUser, testCfg } from "../../../../test/helpers/opd";
import { grantPermissionToRole } from "../../../kernel/auth/permissions";
import { withTx } from "../../../kernel/db/client";
import { events, items, patients } from "../../../kernel/db/schema";
import { addMedicine, addSalt, medicinesByIds } from "../../formulary";
import { balances, createStore, registerItem } from "../../materials";
import { decideAuthorisation, requestAuthorisation } from "../authorisations";
import { billDispense, previewDispenseBill } from "../bill";
import { claimDispense, findAtCounter, openBalanceDispense } from "../claim";
import { RETAIL_PHARMACY_STORE_CODE } from "../config";
import { handOverDispense } from "../handover";
import { enterPaperPrescription } from "../paper-rx";
import { pickDispense } from "../pick";
import { dispensePaper, sendDispensePaper } from "../print";
import { confirmSlip, getDispense } from "../queue";
import { previewRetailSale, recordRetailLicence, sellRetail } from "../retail";
import { registerSaleItem } from "../sale-items";
import { updatePharmacySettings } from "../settings";
import { declineLine, verifyDispense } from "../verify";
import type { Actor } from "@hmis/contracts";
import type { PharmacyFixture } from "../../../../test/helpers/pharmacy";
import type { Db } from "../../../kernel/db/client";
import type { DocumentStore } from "../../../kernel/documents/store";
import type { RxLine } from "../../opd";

/**
 * ACCEPTANCE — issue #1046, spec docs/specs/1046-pharmacy-counter-go-live.md (owner APPROVED 2026-11-13, ruling 0093).
 * The OPD desk keeps its pipeline; seven exceptions that stop a busy counter get a way through.
 */
const DAY = 24 * 60 * 60_000;
const HEAD: Actor = { type: "user", id: "01HMATERIALSHEAD00000000001" };
const docs: DocumentStore = { put: async () => {}, get: async () => Buffer.alloc(0), remove: async () => {} };

describe("the pharmacy counter goes live (spec #1046)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: PharmacyFixture;
  let A: Actor;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    fx = await seedPharmacyBase(db);
    A = fx.pharmacist.actor;
    await openSessionFor(db, { id: fx.pharmacist.id }, 0);
    await stockIn(db, fx, { itemId: fx.item.crocin, batchNo: "CR-1", qtyBase: 100, expiryDate: "2027-12-31", mrpPaise: 12000 });
    await stockIn(db, fx, { itemId: fx.item.calpol, batchNo: "CP-1", qtyBase: 100, expiryDate: "2027-12-31", mrpPaise: 9000 });
  });
  afterEach(() => { fx.unregister(); });

  /** Another stocked brand: its own drug item, bridged to a sale item, on the counter's shelf. */
  async function stockedBrand(code: string, name: string, medicineId: string, batchNo: string, qtyBase: number): Promise<string> {
    const itemId = await withTx(db, async (tx) => {
      const { itemId: id } = await registerItem(tx, HEAD, {
        code, name, class: "drug", baseUom: "tablet", batchTracked: true, formularyMedicineId: medicineId, gstRateBps: 1200,
        uoms: [{ uom: "strip", toBaseMultiplier: 10, isPurchaseUom: true, isIssueUom: true }],
      });
      await registerSaleItem(tx, A, id);
      return id;
    });
    await stockIn(db, fx, { itemId, batchNo, qtyBase, expiryDate: "2027-12-31", mrpPaise: 12000 });
    return itemId;
  }

  /** An over-the-counter medicine of another moiety than paracetamol, stocked at the counter: Cetzine 10. */
  async function cetzine(): Promise<{ medicineId: string; itemId: string }> {
    const medicineId = await withTx(db, async (tx) => {
      const salt = await addSalt(tx, A, { name: "Cetirizine", drugClass: "antihistamine" });
      return (await addMedicine(tx, A, {
        brandName: "Cetzine 10", form: "tablet", routeClass: "systemic", strengthLabel: "10 mg", scheduleFlag: "OTC", salts: [{ saltId: salt.saltId, strength: "10 mg" }],
      })).medicineId;
    });
    return { medicineId, itemId: await stockedBrand("CETZ10", "Cetzine 10 tablet", medicineId, "CZ-1", 100) };
  }

  /** The doctor's e-prescription, found at the counter by its QR and claimed. */
  async function ticket(lines: RxLine[]): Promise<{ id: string; qr: string }> {
    const { issued } = await issueRx(db, fx, lines, { at: MON });
    const found = await findAtCounter(db, testCfg, A, issued.qrPayload, MON2);
    if (found.kind !== "dispense") throw new Error("no dispense");
    await claimDispense(db, A, { dispenseId: found.dispense.id, door: "rx_qr" }, MON2);
    return { id: found.dispense.id, qr: issued.qrPayload };
  }

  /** Paid in cash, to the rupee (0019). */
  async function pay(id: string, at: Date): Promise<void> {
    const p = await previewDispenseBill(db, A, id, at, { tender: "cash" });
    await billDispense(db, A, id, { tenders: [{ mode: "cash", amountPaise: p.byTender.cash.netPayablePaise }] }, at);
  }

  const crocin = (): RxLine => line({ drug: "Crocin 500", medicineId: fx.med.crocin });

  it("spec #1046 D1: a Schedule H ticket for a patient with no token and no phone is handed over to an attendant, and the dispense shows who collected", async () => {
    const brufen = await stockedBrand("BRUF400", "Brufen 400 tablet", fx.med.ibuprofen, "BR-1", 50);
    const kamla = await mkPatient(db, fx.clerk.actor, { name: "Kamla Bai", ageYears: 71 });
    await db.update(patients).set({ phone: null }).where(eq(patients.id, kamla.id));
    // A paper prescription at the desk: a no-fee pharmacy visit, so no token either.
    const paper = await enterPaperPrescription(db, testCfg, docs, A, {
      patientId: kamla.id, doctorId: fx.doctor.doctorId, rxDate: "2026-08-17",
      photo: { mimeType: "image/jpeg", bytes: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]) }, lines: [{ itemId: brufen, qtyBase: 10 }],
    }, MON2);
    expect(paper.scheduled).toBe(true);
    await verifyDispense(db, A, fx.decls, paper.id, { lines: [{ lineIdx: 0, qtyBase: 10 }] }, MON2);
    await pickDispense(db, A, fx.decls, paper.id, {}, MON2);
    await confirmSlip(db, A, paper.id, MON2);
    await pay(paper.id, MON2);

    await expect(handOverDispense(db, A, fx.decls, paper.id, {}, MON3)).rejects.toMatchObject({ code: "identity_confirmation_required" });
    const collectedBy = { who: "attendant", name: "Ramesh Kumar", relation: "son" };
    const done = await handOverDispense(db, A, fx.decls, paper.id, { identity: { via: "collected_by", ...collectedBy } }, MON3);
    expect(done.status).toBe("handed_over");
    expect(done.identityConfirmedVia).toBe("collected_by");
    expect(done.collectedBy).toEqual(collectedBy);
    expect((await getDispense(db, A, paper.id, MON3)).collectedBy).toEqual(collectedBy);
    const [handed] = await db.select().from(events).where(eq(events.name, "dispense.handed_over"));
    expect(handed!.payload).toMatchObject({ dispenseId: paper.id, collectedBy });
  });

  it("spec #1046 D2: in picked, one line is declined with a reason; its stock reservation is released and the bill total drops by that line", async () => {
    const cz = await cetzine();
    const { id } = await ticket([crocin(), line({ drug: "Cetzine 10", medicineId: cz.medicineId })]);
    await verifyDispense(db, A, fx.decls, id, { lines: [{ lineIdx: 0, qtyBase: 10 }, { lineIdx: 1, qtyBase: 10 }] }, MON2);
    await pickDispense(db, A, fx.decls, id, {}, MON2);
    const reservedCetzine = async (): Promise<number> =>
      (await balances(db, { resourceId: fx.storeId, itemId: cz.itemId })).reduce((n, b) => n + b.qtyReserved, 0);
    expect(await reservedCetzine()).toBe(10);
    const before = await previewDispenseBill(db, A, id, MON2);
    const cetzineRow = before.lines.find((l) => l.serviceName.includes("Cetzine"));
    expect(cetzineRow).toBeDefined();

    const after = await declineLine(db, A, fx.decls, id, 1, "the patient has it at home", MON2);
    expect(after.status).toBe("picked");
    expect(after.lines.find((l) => l.lineIdx === 1)).toMatchObject({ status: "declined", declinedReason: "the patient has it at home" });
    expect(await reservedCetzine()).toBe(0);
    const repriced = await previewDispenseBill(db, A, id, MON2);
    expect(repriced.lines.some((l) => l.serviceName.includes("Cetzine"))).toBe(false);
    expect(repriced.totals.grossPaise).toBe(before.totals.grossPaise - cetzineRow!.grossPaise);

    await pay(id, MON2);
    expect((await getDispense(db, A, id, MON2)).status).toBe("billed");
    await expect(declineLine(db, A, fx.decls, id, 0, "too late", MON3)).rejects.toMatchObject({ code: "dispense_not_in_state" });
  });

  it("spec #1046 D3: taking the payment prints the bill without waiting for hand-over", async () => {
    const { id } = await ticket([crocin()]);
    await verifyDispense(db, A, fx.decls, id, { lines: [{ lineIdx: 0, qtyBase: 10 }] }, MON2);
    await pickDispense(db, A, fx.decls, id, {}, MON2);
    await pay(id, MON2);
    expect((await getDispense(db, A, id, MON2)).status).toBe("billed");

    expect(await sendDispensePaper(db, A, id, { documents: ["pharmacy_bill"] }, MON2)).toEqual({ via: "browser", documents: ["pharmacy_bill"] });
    const bill = await dispensePaper(db, A, id, MON2, ["pharmacy_bill"]);
    expect(bill.title.startsWith("Pharmacy bill")).toBe(true);
    expect(bill.title).not.toContain("Labels");
  });

  it("spec #1046 D5: a printed pharmacy bill shows batch, MM/YY expiry and manufacturer per line, and the drug licence numbers and the pharmacist's registration number in its header", async () => {
    await db.update(items).set({ manufacturer: "GSK Consumer Healthcare" }).where(eq(items.id, fx.item.crocin));
    const { resourceId: retailId } = await withTx(db, (tx) => createStore(tx, HEAD, { code: RETAIL_PHARMACY_STORE_CODE, name: "Walk-in retail pharmacy" }));
    await ensureRole(db, "pharmacy_incharge");
    await grantPermissionToRole(db, fx.registry, "pharmacy_incharge", "pharmacy.retail.manage");
    const manager = await mkUser(db, "ph.licensee", ["pharmacy_incharge"]);
    await recordRetailLicence(db, manager.actor, {
      form20No: "RLF20-MH-PUN-1001", form21No: "RLF21-MH-PUN-1001", validFrom: "2026-01-01", validTo: "2030-12-31", pharmacistInCharge: "A. Kulkarni",
    }, MON);

    // The desk's bill, as the server prints it (relay and browser alike).
    const { id } = await ticket([crocin()]);
    await verifyDispense(db, A, fx.decls, id, { lines: [{ lineIdx: 0, qtyBase: 10 }] }, MON2);
    await pickDispense(db, A, fx.decls, id, {}, MON2);
    await pay(id, MON2);
    const { html } = await dispensePaper(db, A, id, MON2, ["pharmacy_bill"]);
    const table = html.indexOf("<table");
    for (const s of ["CR-1", "12/27", "GSK Consumer Healthcare"]) expect(html).toContain(s);
    for (const s of ["RLF20-MH-PUN-1001", "RLF21-MH-PUN-1001", "ph.mehta", "MSPC-123456"]) {
      expect(html).toContain(s);
      expect(html.indexOf(s)).toBeLessThan(table);
    }

    // The walk-in sale carries the same particulars for its bill.
    await stockIn(db, fx, { itemId: fx.item.crocin, batchNo: "R-7", qtyBase: 50, resourceId: retailId, expiryDate: "2028-03-31" });
    const lines = [{ medicineId: fx.med.crocin, qtyBase: 10 }];
    const preview = await previewRetailSale(db, A, { lines }, MON);
    const sale = await sellRetail(db, docs, A, {
      customer: { register: { name: "Ramesh Patil", sex: "male", ageYears: 52, phone: "9822001122" } }, lines,
      tenders: [{ mode: "cash", amountPaise: preview.byTender!.cash.netPayablePaise }],
    }, undefined, MON);
    expect(sale.lines[0]).toMatchObject({ batchNo: "R-7", expiryDate: "2028-03-31", manufacturer: "GSK Consumer Healthcare" });
    expect(sale.licence).toEqual({ form20No: "RLF20-MH-PUN-1001", form21No: "RLF21-MH-PUN-1001" });
    expect(sale.pharmacist).toEqual({ name: "ph.mehta", registrationNo: "MSPC-123456" });
  });

  it("spec #1046 D6: a line picked short leaves a balance; the next day the same prescription opens a balance ticket for only the owed quantity, and its bill is not refused as a duplicate", async () => {
    const cz = await cetzine();
    const { id, qr } = await ticket([crocin(), line({ drug: "Cetzine 10", medicineId: cz.medicineId })]);
    await verifyDispense(db, A, fx.decls, id, { lines: [{ lineIdx: 0, qtyBase: 20 }, { lineIdx: 1, qtyBase: 10 }] }, MON2);
    await pickDispense(db, A, fx.decls, id, { lines: [{ lineIdx: 0, qtyBase: 10, pickNote: "one strip on the shelf, rest tomorrow" }] }, MON2);
    await pay(id, MON2);
    const first = await handOverDispense(db, A, fx.decls, id, {}, MON3);
    expect(first.balanceOwed?.lines).toEqual([expect.objectContaining({ lineIdx: 0, qtyBase: 10 })]);

    const NEXT = new Date(MON3.getTime() + DAY);
    const found = await findAtCounter(db, testCfg, A, qr, NEXT);
    if (found.kind !== "dispense") throw new Error(`found ${found.kind}`);
    expect(found.dispense.id).toBe(id);
    expect(found.dispense.balanceOwed?.lines).toEqual([expect.objectContaining({ lineIdx: 0, qtyBase: 10 })]);

    const balance = await openBalanceDispense(db, A, id, NEXT);
    expect(balance.id).not.toBe(id);
    expect(balance.status).toBe("queued");
    const claimed = await claimDispense(db, A, { dispenseId: balance.id, door: "rx_qr" }, NEXT);
    expect(claimed.lines.map((l) => ({ lineIdx: l.lineIdx, drug: l.rxLine.drug, qtyBase: l.qtyBase }))).toEqual([{ lineIdx: 0, drug: "Crocin 500", qtyBase: 10 }]);
    await verifyDispense(db, A, fx.decls, balance.id, { lines: [{ lineIdx: 0, qtyBase: 10 }] }, NEXT);
    await pickDispense(db, A, fx.decls, balance.id, {}, NEXT);
    await pay(balance.id, NEXT);
    const billed = await getDispense(db, A, balance.id, NEXT);
    expect(billed.status).toBe("billed");
    expect(billed.invoiceId).not.toBeNull();
    expect(billed.invoiceId).not.toBe(first.invoiceId);
    const done = await handOverDispense(db, A, fx.decls, balance.id, {}, NEXT);
    expect(done.status).toBe("handed_over");
    expect(done.balanceOwed).toBeNull();
    expect((await getDispense(db, A, id, NEXT)).balanceOwed).toBeNull();
  });

  it("spec #1046 D7: a brand swap on a Schedule H line waits for the prescriber's agreement; a swap on an OTC line does not", async () => {
    const [azee] = [...(await medicinesByIds(db, [fx.med.azithro])).values()];
    const azithral = await withTx(db, (tx) => addMedicine(tx, A, {
      brandName: "Azithral 500", form: "tablet", routeClass: "systemic", strengthLabel: "500 mg", scheduleFlag: "H1",
      salts: [{ saltId: azee!.salts[0]!.saltId, strength: "500 mg" }],
    }));
    await stockedBrand("AZTL500", "Azithral 500 tablet", azithral.medicineId, "AZL-1", 30);
    await stockIn(db, fx, { itemId: fx.item.azithro, batchNo: "AZ-1", qtyBase: 30 });
    // Quick desk mode (0022) is on in production (0093) and does not stand this check down.
    await grantPermissionToRole(db, fx.registry, "pharmacy", "pharmacy.licences.manage");
    await withTx(db, (tx) => updatePharmacySettings(tx, A, { quickDesk: true }, MON));

    // OTC: the patient's consent alone.
    const otc = await ticket([crocin()]);
    const otcDone = await verifyDispense(db, A, fx.decls, otc.id, { lines: [{ lineIdx: 0, qtyBase: 10, dispensedMedicineId: fx.med.calpol, patientConsent: true }] }, MON2);
    expect(otcDone.status).toBe("verified");
    expect(otcDone.lines[0]!.dispensedMedicine?.id).toBe(fx.med.calpol);

    // Schedule H1: the swap waits for the prescriber.
    const { id } = await ticket([line({ drug: "Azee 500", medicineId: fx.med.azithro })]);
    const swap = { lines: [{ lineIdx: 0, qtyBase: 3, dispensedMedicineId: azithral.medicineId, patientConsent: true }] };
    await expect(verifyDispense(db, A, fx.decls, id, swap, MON2)).rejects.toMatchObject({ code: "substitution_needs_prescriber" });
    const asked = await requestAuthorisation(db, A, { dispenseId: id, lineIdx: 0, book: "substitution", about: azithral.medicineId, note: "Azee is out" }, MON2);
    expect(asked).toMatchObject({ status: "pending", book: "substitution", prescriberUserId: fx.doctor.userId });
    await expect(verifyDispense(db, A, fx.decls, id, swap, MON2)).rejects.toMatchObject({ code: "substitution_needs_prescriber" });
    await decideAuthorisation(db, fx.doctor.actor, asked.id, { authorise: true, reason: "same molecule and strength, fine" }, MON2);
    const verified = await verifyDispense(db, A, fx.decls, id, swap, MON2);
    expect(verified.status).toBe("verified");
    expect(verified.lines[0]!.dispensedMedicine?.id).toBe(azithral.medicineId);
  });
});
