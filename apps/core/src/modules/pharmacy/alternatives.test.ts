import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { MON2, addAllergy, issueRx, line, seedPharmacyBase, stockIn } from "../../../test/helpers/pharmacy";
import { testCfg } from "../../../test/helpers/opd";
import { withTx } from "../../kernel/db/client";
import { adoptDrugDisease } from "../formulary";
import { claimDispense, findAtCounter } from "./claim";
import { checkedAlternativesFor, declineLine, precheckTicket, verifyDispense } from "./verify";
import type { PharmacyFixture } from "../../../test/helpers/pharmacy";
import type { Db } from "../../kernel/db/client";

/**
 * PD-7 C3 — THE EQUIVALENTS, EACH ALREADY PUT TO THIS PATIENT'S CHECK. The sheet used to say it
 * would not draw a "clean" it had not been told. It is told now, by `refusalsOf` — the function
 * verify refuses with — so a blocked alternative on the sheet is exactly one the check refuses.
 */
describe("the substitute sheet's alternatives, pre-checked for this patient (PD-7 C3)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: PharmacyFixture;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); fx = await seedPharmacyBase(db); });
  afterEach(() => { fx.unregister(); });

  async function claimed(lines: Parameters<typeof issueRx>[2], opts: Parameters<typeof issueRx>[3] = {}): Promise<string> {
    const { issued } = await issueRx(db, fx, lines, opts);
    const r = await findAtCounter(db, testCfg, fx.pharmacist.actor, issued.qrPayload, MON2);
    if (r.kind !== "dispense") throw new Error(`expected a dispense, got ${JSON.stringify(r)}`);
    await claimDispense(db, fx.pharmacist.actor, { dispenseId: r.dispense.id, door: "rx_qr" }, MON2);
    return r.dispense.id;
  }

  it("clear when nothing stands against it; blocked BY NAME once an allergy is recorded — and the check agrees", async () => {
    await stockIn(db, fx, { itemId: fx.item.calpol, batchNo: "CP-1", qtyBase: 30 });
    const id = await claimed([line({ drug: "Crocin 500", medicineId: fx.med.crocin })]);
    expect(await checkedAlternativesFor(db, fx.pharmacist.actor, id, 0, MON2)).toEqual([
      expect.objectContaining({ itemCode: "CALP500", available: 30, check: { verdict: "clear", blocks: [] } }),
    ]);

    await addAllergy(db, fx.patient.id, "Paracetamol");
    expect((await checkedAlternativesFor(db, fx.pharmacist.actor, id, 0, MON2)).map((a) => a.check)).toEqual([
      { verdict: "blocked", blocks: [{ book: "allergy", about: "Paracetamol" }] },
    ]);
    await expect(verifyDispense(db, fx.pharmacist.actor, fx.decls, id, { lines: [{ lineIdx: 0, qtyBase: 10, dispensedMedicineId: fx.med.calpol, patientConsent: true }] }, MON2))
      .rejects.toThrow(expect.objectContaining({ code: "allergy_block" }));
  });

  it("a diagnosis coded after the issue blocks the equivalent too, naming the ruling", async () => {
    await withTx(db, (tx) => adoptDrugDisease(tx, fx.pharmacist.actor, "owner-resolution-test", [{
      rule: "icd10_contraindications#0", prefix: "K72", title: "Hepatic failure", moieties: ["Paracetamol"], severity: "severe", note: "Hepatotoxic.",
    }]));
    const id = await claimed([line({ drug: "Crocin 500", medicineId: fx.med.crocin })]);
    await issueRx(db, fx, [line({ drug: "ORS sachet" })], { at: MON2, diagnoses: [{ text: "Hepatic failure", icd10Code: "K72.90" }] });
    expect((await checkedAlternativesFor(db, fx.pharmacist.actor, id, 0, MON2)).map((a) => a.check)).toEqual([
      { verdict: "blocked", blocks: [{ book: "drug_disease", about: "Hepatic failure" }] },
    ]);
  });

  it("a no-substitution line, or one with no equivalent on the shelf, is asked nothing", async () => {
    const id = await claimed([line({ drug: "Crocin 500", medicineId: fx.med.crocin, noSubstitution: true }), line({ drug: "Azee 500", medicineId: fx.med.azithro, frequency: "OD", durationDays: 3 })]);
    expect(await checkedAlternativesFor(db, fx.pharmacist.actor, id, 0, MON2)).toEqual([]);
    expect(await checkedAlternativesFor(db, fx.pharmacist.actor, id, 1, MON2)).toEqual([]);
  });

  /**
   * C3b — THE TICKET'S OWN LINES, PUT TO THE SAME CHECK AT THE CLAIM. Found walking C3: an allergy
   * recorded after the issue sat silent on its line until the tick fired verify, after the strips
   * were in hand. `refusalsOf` answers it before anyone walks to the shelf.
   */
  it("C3b — the ticket's own lines, pre-checked: the allergic line says so before the tick, the others are clear, an unplaced one is unplaced", async () => {
    const id = await claimed([
      line({ drug: "Crocin 500", medicineId: fx.med.crocin }),
      line({ drug: "Azee 500", medicineId: fx.med.azithro, frequency: "OD", durationDays: 3 }),
      line({ drug: "Tab Mystery 10mg" }),
    ]);
    await addAllergy(db, fx.patient.id, "Paracetamol");
    expect(await precheckTicket(db, fx.pharmacist.actor, id, MON2)).toEqual({ lines: [
      { lineIdx: 0, verdict: "blocked", blocks: [{ book: "allergy", about: "Paracetamol" }] },
      { lineIdx: 1, verdict: "clear", blocks: [] },
      { lineIdx: 2, verdict: "unplaced", blocks: [] },
    ] });
    // and the check, when it runs, refuses exactly that line for exactly that reason
    await declineLine(db, fx.pharmacist.actor, fx.decls, id, 2, "not stocked here", MON2);
    await expect(verifyDispense(db, fx.pharmacist.actor, fx.decls, id, { lines: [{ lineIdx: 0, qtyBase: 15 }, { lineIdx: 1, qtyBase: 3 }] }, MON2))
      .rejects.toThrow(expect.objectContaining({ code: "allergy_block", detail: { hits: [{ lineIdx: 0, substance: "Paracetamol" }] } }));
  });

  it("C3b — a ticket past the check is not pre-checked again; a declined line is not asked", async () => {
    const id = await claimed([line({ drug: "Crocin 500", medicineId: fx.med.crocin }), line({ drug: "Tab Mystery 10mg" })]);
    await declineLine(db, fx.pharmacist.actor, fx.decls, id, 1, "not stocked here", MON2);
    expect((await precheckTicket(db, fx.pharmacist.actor, id, MON2)).lines.map((l) => l.lineIdx)).toEqual([0]);
    await verifyDispense(db, fx.pharmacist.actor, fx.decls, id, { lines: [{ lineIdx: 0, qtyBase: 15 }] }, MON2);
    expect(await precheckTicket(db, fx.pharmacist.actor, id, MON2)).toEqual({ lines: [] });
  });
});
