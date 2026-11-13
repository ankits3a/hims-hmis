import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { openSessionFor } from "../../../test/helpers/billing";
import { MON, MON2, MON3, issueRx, line, seedPharmacyBase, stockIn } from "../../../test/helpers/pharmacy";
import { testCfg } from "../../../test/helpers/opd";
import { withTx } from "../../kernel/db/client";
import { pharmacyDispenseLines, stockReservations } from "../../kernel/db/schema";
import { addMedicine, medicinesByIds } from "../formulary";
import { registerItem } from "../materials";
import { decideAuthorisation, requestAuthorisation } from "./authorisations";
import { billDispense, previewDispenseBill } from "./bill";
import { claimDispense, findAtCounter, openBalanceDispense } from "./claim";
import { handOverDispense } from "./handover";
import { enterPaperPrescription } from "./paper-rx";
import { pickDispense } from "./pick";
import { getDispense } from "./queue";
import { registerSaleItem } from "./sale-items";
import { declineLine, verifyDispense } from "./verify";
import type { Actor } from "@hmis/contracts";
import type { PharmacyFixture } from "../../../test/helpers/pharmacy";
import type { Db } from "../../kernel/db/client";
import type { DocumentStore } from "../../kernel/documents/store";
import type { RxLine } from "../opd";

/**
 * Spec #1046 (owner 2026-11-13, ruling 0093) — the edges of the counter's seven exceptions that the locked
 * acceptance checks (`acceptance/counter-go-live-1046.test.ts`) do not walk.
 */
const DAY = 24 * 60 * 60_000;
const HEAD: Actor = { type: "user", id: "01HMATERIALSHEAD00000000001" };
const docs: DocumentStore = { put: async () => {}, get: async () => Buffer.alloc(0), remove: async () => {} };

describe("counter go-live edges (spec #1046)", () => {
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
    await stockIn(db, fx, { itemId: fx.item.azithro, batchNo: "AZ-1", qtyBase: 30 });
  });
  afterEach(() => { fx.unregister(); });

  async function ticket(lines: RxLine[]): Promise<{ id: string; qr: string }> {
    const { issued } = await issueRx(db, fx, lines, { at: MON });
    const found = await findAtCounter(db, testCfg, A, issued.qrPayload, MON2);
    if (found.kind !== "dispense") throw new Error("no dispense");
    await claimDispense(db, A, { dispenseId: found.dispense.id, door: "rx_qr" }, MON2);
    return { id: found.dispense.id, qr: issued.qrPayload };
  }
  async function pay(id: string, at: Date): Promise<void> {
    const p = await previewDispenseBill(db, A, id, at, { tender: "cash" });
    await billDispense(db, A, id, { tenders: [{ mode: "cash", amountPaise: p.byTender.cash.netPayablePaise }] }, at);
  }
  const crocin = (): RxLine => line({ drug: "Crocin 500", medicineId: fx.med.crocin });

  /** Crocin 20 verified, 10 picked short, paid and handed over at MON3: 10 owed. */
  async function shortHandedOver(): Promise<{ id: string; qr: string }> {
    const t = await ticket([crocin()]);
    await verifyDispense(db, A, fx.decls, t.id, { lines: [{ lineIdx: 0, qtyBase: 20 }] }, MON2);
    await pickDispense(db, A, fx.decls, t.id, { lines: [{ lineIdx: 0, qtyBase: 10, pickNote: "one strip on the shelf" }] }, MON2);
    await pay(t.id, MON2);
    await handOverDispense(db, A, fx.decls, t.id, {}, MON3);
    return t;
  }

  describe("D2 — a line dropped at the bill", () => {
    it("dropping the last live line cancels the ticket as a cancel does, and frees its stock", async () => {
      const { id } = await ticket([crocin()]);
      await verifyDispense(db, A, fx.decls, id, { lines: [{ lineIdx: 0, qtyBase: 10 }] }, MON2);
      const picked = await pickDispense(db, A, fx.decls, id, {}, MON2);
      const reservationId = picked.lines[0]!.reservationId!;
      const after = await declineLine(db, A, fx.decls, id, 0, "patient changed their mind", MON2);
      expect(after.status).toBe("cancelled");
      expect(after.cancelReason).toBe("patient changed their mind");
      const [r] = await db.select().from(stockReservations).where(eq(stockReservations.id, reservationId));
      expect(r!.status).toBe("released");
    });

    it("a reason is still required, and a claimed ticket declines as before", async () => {
      const { id } = await ticket([crocin()]);
      await expect(declineLine(db, A, fx.decls, id, 0, "  ", MON2)).rejects.toMatchObject({ code: "qty_required" });
      const after = await declineLine(db, A, fx.decls, id, 0, "not stocked", MON2);
      expect(after.status).toBe("claimed");
      expect(after.lines[0]!.status).toBe("declined");
    });
  });

  describe("D6 — the balance ticket", () => {
    it("a short pick records the owed base units on the prescription's line", async () => {
      const { id } = await shortHandedOver();
      const [row] = await db.select().from(pharmacyDispenseLines).where(eq(pharmacyDispenseLines.dispenseId, id));
      expect(row!.owedQtyBase).toBe(10);
    });

    it("billing the SAME dispense twice is still refused: one bill per dispense", async () => {
      const { id } = await ticket([crocin()]);
      await verifyDispense(db, A, fx.decls, id, { lines: [{ lineIdx: 0, qtyBase: 10 }] }, MON2);
      await pickDispense(db, A, fx.decls, id, {}, MON2);
      await pay(id, MON2);
      await expect(billDispense(db, A, id, { tenders: [{ mode: "cash", amountPaise: 1200 }] }, MON2)).rejects.toMatchObject({ code: "dispense_not_in_state" });
    });

    it("one live balance per ticket; a balance of a balance inside the window; nothing after 30 days", async () => {
      const { id } = await shortHandedOver();
      const NEXT = new Date(MON3.getTime() + DAY);
      const b1 = await openBalanceDispense(db, A, id, NEXT);
      expect(b1.balanceOf).toBe(id);
      await expect(openBalanceDispense(db, A, id, NEXT)).rejects.toMatchObject({ code: "no_balance_owed" });
      // the balance is itself picked short: it owes its own balance, inside the same 30 days
      await claimDispense(db, A, { dispenseId: b1.id, door: "rx_qr" }, NEXT);
      await verifyDispense(db, A, fx.decls, b1.id, { lines: [{ lineIdx: 0, qtyBase: 10 }] }, NEXT);
      await pickDispense(db, A, fx.decls, b1.id, { lines: [{ lineIdx: 0, qtyBase: 4, pickNote: "four left" }] }, NEXT);
      await pay(b1.id, NEXT);
      const done = await handOverDispense(db, A, fx.decls, b1.id, {}, NEXT);
      expect(done.balanceOwed?.lines).toEqual([expect.objectContaining({ lineIdx: 0, qtyBase: 6 })]);
      expect(done.balanceOwed?.until.getTime()).toBe(MON3.getTime() + 30 * DAY);
      // past the window counted from the FIRST hand-over, nothing is offered and nothing opens
      const LATE = new Date(MON3.getTime() + 31 * DAY);
      expect((await getDispense(db, A, b1.id, LATE)).balanceOwed).toBeNull();
      await expect(openBalanceDispense(db, A, b1.id, LATE)).rejects.toMatchObject({ code: "no_balance_owed" });
    });

    it("a ticket picked in full owes nothing", async () => {
      const { id } = await ticket([crocin()]);
      await verifyDispense(db, A, fx.decls, id, { lines: [{ lineIdx: 0, qtyBase: 10 }] }, MON2);
      await pickDispense(db, A, fx.decls, id, {}, MON2);
      await pay(id, MON2);
      const done = await handOverDispense(db, A, fx.decls, id, {}, MON3);
      expect(done.balanceOwed).toBeNull();
      await expect(openBalanceDispense(db, A, id, MON3)).rejects.toMatchObject({ code: "no_balance_owed" });
    });

    it("by name or UHID the next day, the desk is told a balance is owed", async () => {
      const { id } = await shortHandedOver();
      const found = await findAtCounter(db, testCfg, A, fx.patient.uhid, new Date(MON3.getTime() + DAY));
      expect(found).toMatchObject({ kind: "none", reason: "no_prescription_today", balanceDispenseId: id });
    });
  });

  describe("D1 — collected by", () => {
    async function billedH1(): Promise<string> {
      const { id } = await ticket([line({ drug: "Azee 500", medicineId: fx.med.azithro })]);
      await verifyDispense(db, A, fx.decls, id, { lines: [{ lineIdx: 0, qtyBase: 3 }] }, MON2);
      await pickDispense(db, A, fx.decls, id, {}, MON2);
      await pay(id, MON2);
      return id;
    }

    it("an attendant needs a name and a relation from OPD's list, and 'self' is not an attendant's relation", async () => {
      const id = await billedH1();
      for (const bad of [{ name: " ", relation: "son" }, { name: "Ramesh", relation: "neighbour" }, { name: "Ramesh", relation: "self" }]) {
        await expect(handOverDispense(db, A, fx.decls, id, { identity: { via: "collected_by", who: "attendant", ...bad } }, MON3))
          .rejects.toMatchObject({ code: "identity_confirmation_required" });
      }
    });

    it("the patient collecting for themself is recorded as self", async () => {
      const id = await billedH1();
      const done = await handOverDispense(db, A, fx.decls, id, { identity: { via: "collected_by", who: "self" } }, MON3);
      expect(done.collectedBy).toEqual({ who: "self", name: null, relation: null });
      expect(done.identityConfirmedVia).toBe("collected_by");
    });

    it("the token still works as before and records no collector", async () => {
      const { issued, tokenNo } = await issueRx(db, fx, [line({ drug: "Azee 500", medicineId: fx.med.azithro })], { at: MON });
      const found = await findAtCounter(db, testCfg, A, issued.qrPayload, MON2);
      if (found.kind !== "dispense") throw new Error("no dispense");
      const id = found.dispense.id;
      await claimDispense(db, A, { dispenseId: id, door: "rx_qr" }, MON2);
      await verifyDispense(db, A, fx.decls, id, { lines: [{ lineIdx: 0, qtyBase: 3 }] }, MON2);
      await pickDispense(db, A, fx.decls, id, {}, MON2);
      await pay(id, MON2);
      const done = await handOverDispense(db, A, fx.decls, id, { identity: { via: "token", value: String(tokenNo) } }, MON3);
      expect(done.identityConfirmedVia).toBe("token");
      expect(done.collectedBy).toBeNull();
    });
  });

  describe("D7 — an H/H1 brand swap", () => {
    async function azithral(): Promise<string> {
      const [azee] = [...(await medicinesByIds(db, [fx.med.azithro])).values()];
      const { medicineId } = await withTx(db, (tx) => addMedicine(tx, A, {
        brandName: "Azithral 500", form: "tablet", routeClass: "systemic", strengthLabel: "500 mg", scheduleFlag: "H1",
        salts: [{ saltId: azee!.salts[0]!.saltId, strength: "500 mg" }],
      }));
      const itemId = await withTx(db, async (tx) => {
        const { itemId: idOf } = await registerItem(tx, HEAD, {
          code: "AZTL500", name: "Azithral 500 tablet", class: "drug", baseUom: "tablet", batchTracked: true, formularyMedicineId: medicineId, gstRateBps: 500,
          uoms: [{ uom: "strip", toBaseMultiplier: 10, isPurchaseUom: true, isIssueUom: true }],
        });
        await registerSaleItem(tx, A, idOf);
        return idOf;
      });
      await stockIn(db, fx, { itemId, batchNo: "AZL-1", qtyBase: 30 });
      return medicineId;
    }

    it("declined by the prescriber, the swap stays refused and the line keeps the brand written", async () => {
      const sub = await azithral();
      const { id } = await ticket([line({ drug: "Azee 500", medicineId: fx.med.azithro })]);
      const asked = await requestAuthorisation(db, A, { dispenseId: id, lineIdx: 0, book: "substitution", about: sub }, MON2);
      await decideAuthorisation(db, fx.doctor.actor, asked.id, { authorise: false, reason: "keep Azee, it is what she tolerates" }, MON2);
      await expect(verifyDispense(db, A, fx.decls, id, { lines: [{ lineIdx: 0, qtyBase: 3, dispensedMedicineId: sub, patientConsent: true }] }, MON2))
        .rejects.toMatchObject({ code: "substitution_needs_prescriber", detail: expect.objectContaining({ lineIdx: 0, to: sub, prescriberOnRecord: true }) });
      const written = await verifyDispense(db, A, fx.decls, id, { lines: [{ lineIdx: 0, qtyBase: 3 }] }, MON2);
      expect(written.lines[0]!.dispensedMedicine?.id).toBe(fx.med.azithro);
    });

    it("an OTC swap is not the prescriber's to agree to; a non-equivalent is no swap at all", async () => {
      const { id } = await ticket([crocin()]);
      await expect(requestAuthorisation(db, A, { dispenseId: id, lineIdx: 0, book: "substitution", about: fx.med.calpol }, MON2))
        .rejects.toMatchObject({ code: "authorisation_not_needed" });
      await expect(requestAuthorisation(db, A, { dispenseId: id, lineIdx: 0, book: "substitution", about: fx.med.ibuprofen }, MON2))
        .rejects.toMatchObject({ code: "substitution_not_allowed" });
    });

    it("an outside doctor's paper cannot be agreed to: the pharmacist is told to give the brand written", async () => {
      const sub = await azithral();
      const paper = await enterPaperPrescription(db, testCfg, docs, A, {
        patientId: fx.patient.id, rxDate: "2026-08-17", outside: { name: "Dr Outside", registrationNo: "MMC-1", address: "Pune" },
        photo: { mimeType: "image/jpeg", bytes: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]) },
        lines: [{ itemId: fx.item.azithro, qtyBase: 3 }],
      }, MON2);
      await expect(requestAuthorisation(db, A, { dispenseId: paper.id, lineIdx: 0, book: "substitution", about: sub }, MON2))
        .rejects.toMatchObject({ code: "substitution_needs_prescriber" });
      await expect(verifyDispense(db, A, fx.decls, paper.id, { lines: [{ lineIdx: 0, qtyBase: 3, dispensedMedicineId: sub, patientConsent: true }] }, MON2))
        .rejects.toMatchObject({ code: "substitution_needs_prescriber", detail: expect.objectContaining({ prescriberOnRecord: false }) });
    });
  });
});
