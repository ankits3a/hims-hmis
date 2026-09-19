import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { MON2, addAllergy, issueRx, line, seedPharmacyBase, stockIn } from "../../../test/helpers/pharmacy";
import { testCfg } from "../../../test/helpers/opd";
import { withTx } from "../../kernel/db/client";
import { events, orders, pharmacyDispenseLines } from "../../kernel/db/schema";
import { addMedicine, adoptDrugDisease, resolveMedicines } from "../formulary";
import { registerItem } from "../materials";
import { claimDispense, findAtCounter } from "./claim";
import { getDispense } from "./queue";
import { registerSaleItem } from "./sale-items";
import { placementsFor, verifyDispense } from "./verify";
import type { Actor } from "@hmis/contracts";
import type { PharmacyFixture } from "../../../test/helpers/pharmacy";
import type { Db } from "../../kernel/db/client";

/**
 * PD-5b — A LINE THE CATALOGUE COULD NOT PLACE IS RESOLVED BY THE PHARMACIST, NOT SUBSTITUTED.
 *
 * The doctor typed words the catalogue could not match to one product (PD-D4's amber row). Reading
 * those words as a medicine on the shelf is the pharmacist's act — it replaces nothing the doctor
 * named, so there is no consent to capture — but it is still a medicine chosen at the window, so
 * every book re-runs on it at the check, Schedule X is refused, and the choice is recorded with
 * who made it. A line the doctor DID name, or the catalogue placed from the words, keeps the
 * substitution rule: equivalent, with consent.
 */
describe("resolve a line the catalogue could not place (PD-5b)", () => {
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

  /** A controlled brand with paracetamol's salt set, bridged and stocked — the R-3 road (counter.test.ts). */
  async function stockedScheduleX(): Promise<string> {
    const HEAD: Actor = { type: "user", id: "01HMATERIALSHEAD00000000001" };
    const saltId = (await resolveMedicines(db, [fx.med.crocin])).get(fx.med.crocin)!.salts[0]!.saltId;
    return withTx(db, async (tx) => {
      const m = await addMedicine(tx, fx.pharmacist.actor, {
        brandName: "Calmol 500", form: "tablet", routeClass: "systemic", strengthLabel: "500 mg",
        scheduleFlag: "X", salts: [{ saltId, strength: "500 mg" }],
      });
      const { itemId } = await registerItem(tx, HEAD, {
        code: "CALM500", name: "Calmol 500 tablet", class: "drug", baseUom: "tablet", batchTracked: true,
        formularyMedicineId: m.medicineId, gstRateBps: 1200,
        uoms: [{ uom: "strip", toBaseMultiplier: 10, isPurchaseUom: true, isIssueUom: true }],
      });
      await registerSaleItem(tx, fx.pharmacist.actor, itemId);
      return m.medicineId;
    });
  }

  it("E31 — the pharmacist names what the words mean: no consent asked, recorded as resolved, and the resolver named", async () => {
    const id = await claimed([line({ drug: "Tab Mystery 10mg" })]);
    expect((await getDispense(db, fx.pharmacist.actor, id)).lines[0]).toMatchObject({ dispensedMedicine: null, substitutionType: "none" });

    const v = await verifyDispense(db, fx.pharmacist.actor, fx.decls, id, { lines: [{ lineIdx: 0, qtyBase: 10, dispensedMedicineId: fx.med.calpol }] }, MON2);
    expect(v.status).toBe("verified");
    expect(v.lines[0]).toMatchObject({ substitutionType: "resolved", orderedMedicine: null, dispensedMedicine: { id: fx.med.calpol }, item: { code: "CALP500" }, qtyBase: 10 });
    const [row] = await db.select().from(pharmacyDispenseLines).where(eq(pharmacyDispenseLines.dispenseId, id));
    expect(row).toMatchObject({ consentBy: null, consentAt: null }); // a resolution is not a consent

    const resolved = await db.select().from(events).where(eq(events.name, "dispense.line_resolved"));
    expect(resolved.map((e) => e.payload)).toEqual([{
      dispenseId: id, lineIdx: 0, patientId: fx.patient.id, doctorId: fx.doctor.doctorId, dispensedMedicineId: fx.med.calpol, resolvedBy: fx.pharmacist.id,
    }]);
    expect(await db.select().from(events).where(eq(events.name, "substitution.recorded"))).toHaveLength(0);
  });

  it("E32 — the books re-run on what was chosen: an allergy the doctor could not have seen refuses it at the check", async () => {
    const id = await claimed([line({ drug: "Tab Mystery 10mg" })]);
    await addAllergy(db, fx.patient.id, "Paracetamol");
    await expect(verifyDispense(db, fx.pharmacist.actor, fx.decls, id, { lines: [{ lineIdx: 0, qtyBase: 10, dispensedMedicineId: fx.med.calpol }] }, MON2))
      .rejects.toThrow(expect.objectContaining({ code: "allergy_block", detail: { hits: [{ lineIdx: 0, substance: "Paracetamol" }] } }));
    expect(await db.select().from(orders)).toHaveLength(0);
    expect((await getDispense(db, fx.pharmacist.actor, id)).status).toBe("claimed");
  });

  it("E33 — Schedule X is neither offered by the shelf search nor accepted at the check", async () => {
    const x = await stockedScheduleX();
    const id = await claimed([line({ drug: "Tab Mystery 10mg" })]);
    expect((await placementsFor(db, id, 0, "cal", MON2)).map((e) => e.itemCode)).toEqual(["CALP500"]);

    await expect(verifyDispense(db, fx.pharmacist.actor, fx.decls, id, { lines: [{ lineIdx: 0, qtyBase: 10, dispensedMedicineId: x }] }, MON2))
      .rejects.toThrow(expect.objectContaining({ code: "schedule_x_not_dispensed_here" }));
    expect(await db.select().from(orders)).toHaveLength(0);
  });

  it("E34 — the search serves an unplaced line only, from this counter's shelf; a line the doctor or the catalogue placed keeps the consent rule", async () => {
    await stockIn(db, fx, { itemId: fx.item.calpol, batchNo: "CP-1", qtyBase: 30 });
    const id = await claimed([
      line({ drug: "Crocin 500", medicineId: fx.med.crocin }), // the doctor named it
      line({ drug: "Azee 500", frequency: "OD", durationDays: 3 }), // the catalogue placed the words
      line({ drug: "Tab Mystery 10mg" }), // nobody could
    ]);
    expect((await getDispense(db, fx.pharmacist.actor, id)).lines[1]).toMatchObject({ substitutionType: "resolved", dispensedMedicine: { id: fx.med.azithro } });
    expect(await placementsFor(db, id, 0, "cal", MON2)).toEqual([]);
    expect(await placementsFor(db, id, 1, "cal", MON2)).toEqual([]);
    expect(await placementsFor(db, id, 2, "", MON2)).toEqual([]);
    expect(await placementsFor(db, id, 2, "cal", MON2)).toEqual([expect.objectContaining({ medicineId: fx.med.calpol, itemCode: "CALP500", scheduleFlag: "OTC", available: 30 })]);

    // Calpol in place of a named or a placed medicine is a SUBSTITUTION, however the body is shaped:
    // the equivalent needs consent, the non-equivalent is refused outright.
    const body = (i0: string, i1: string): Parameters<typeof verifyDispense>[4] => ({
      lines: [{ lineIdx: 0, qtyBase: 10, dispensedMedicineId: i0 }, { lineIdx: 1, qtyBase: 3, dispensedMedicineId: i1 }, { lineIdx: 2, qtyBase: 10, dispensedMedicineId: fx.med.calpol }],
    });
    await expect(verifyDispense(db, fx.pharmacist.actor, fx.decls, id, body(fx.med.calpol, fx.med.azithro), MON2))
      .rejects.toThrow(expect.objectContaining({ code: "consent_required", detail: { lineIdx: 0 } }));
    await expect(verifyDispense(db, fx.pharmacist.actor, fx.decls, id, body(fx.med.crocin, fx.med.calpol), MON2))
      .rejects.toThrow(expect.objectContaining({ code: "substitution_not_allowed", detail: expect.objectContaining({ lineIdx: 1 }) }));
  });

  /**
   * ═══ THE TWO BOOKS A READING CAN NEWLY TRIP ═══
   *
   * `verify` gated only allergy and severe interaction, which is sound for a SUBSTITUTE: same salts,
   * so its duplicates and its drug×disease rulings are the ones the prescriber met at issue. A
   * RESOLUTION brings moieties the prescriber never saw, and a hard duplicate or a severe
   * contraindication on one is a decision nobody made. Found reading the check's outcome for C3.
   */
  it("E35 — a reading that repeats a moiety already on the prescription is refused, on the line the pharmacist chose", async () => {
    const id = await claimed([line({ drug: "Crocin 500", medicineId: fx.med.crocin }), line({ drug: "Tab Mystery 10mg" })]);
    await expect(verifyDispense(db, fx.pharmacist.actor, fx.decls, id, {
      lines: [{ lineIdx: 0, qtyBase: 10 }, { lineIdx: 1, qtyBase: 10, dispensedMedicineId: fx.med.calpol }],
    }, MON2)).rejects.toThrow(expect.objectContaining({ code: "duplicate_block", detail: { hits: [{ lineIdx: 1, moiety: expect.stringMatching(/paracetamol/i) }] } }));
    expect(await db.select().from(orders)).toHaveLength(0);
  });

  it("E36 — a reading a coded diagnosis contraindicates is refused on its line; one the prescriber already overrode passes", async () => {
    await withTx(db, (tx) => adoptDrugDisease(tx, fx.pharmacist.actor, "owner-resolution-test", [{
      rule: "icd10_contraindications#0", prefix: "K72", title: "Hepatic failure", moieties: ["Paracetamol"],
      severity: "severe", note: "Hepatotoxic in hepatic failure.",
    }]));
    // the doctor coded the failure and wrote words nothing could read: issue saw no paracetamol and ruled on none
    const unread = await claimed([line({ drug: "Tab Mystery 10mg" })], { diagnoses: [{ text: "Hepatic failure", icd10Code: "K72.90" }] });
    await expect(verifyDispense(db, fx.pharmacist.actor, fx.decls, unread, { lines: [{ lineIdx: 0, qtyBase: 10, dispensedMedicineId: fx.med.calpol }] }, MON2))
      .rejects.toThrow(expect.objectContaining({ code: "drug_disease_block", detail: { hits: [expect.objectContaining({ lineIdx: 0, icd10Prefix: "K72" })] } }));

    // the doctor wrote the moiety: issue saw the contraindication and the doctor overrode it, with a reason
    const ruled = await claimed([line({ drug: "Paracetamol" })], {
      at: MON2, overrides: { drugDiseaseOverrides: [{ lineIndex: 0, moiety: "Paracetamol", icd10Prefix: "K72", reason: "short course, hepatology agrees" }] },
    });
    const v = await verifyDispense(db, fx.pharmacist.actor, fx.decls, ruled, { lines: [{ lineIdx: 0, qtyBase: 10, dispensedMedicineId: fx.med.calpol }] }, MON2);
    expect(v.lines[0]).toMatchObject({ substitutionType: "resolved", dispensedMedicine: { id: fx.med.calpol } });
  });

  it("E37 — DECIDED: a diagnosis coded AFTER the prescription stops a doctor-named line too, as a later allergy does (D9)", async () => {
    await withTx(db, (tx) => adoptDrugDisease(tx, fx.pharmacist.actor, "owner-resolution-test", [{
      rule: "icd10_contraindications#0", prefix: "K72", title: "Hepatic failure", moieties: ["Paracetamol"],
      severity: "severe", note: "Hepatotoxic in hepatic failure.",
    }]));
    const id = await claimed([line({ drug: "Calpol 500", medicineId: fx.med.calpol })]);
    // a later visit codes the failure; nobody has ruled on paracetamol against it
    await issueRx(db, fx, [line({ drug: "ORS sachet" })], { at: MON2, diagnoses: [{ text: "Hepatic failure", icd10Code: "K72.90" }] });
    await expect(verifyDispense(db, fx.pharmacist.actor, fx.decls, id, { lines: [{ lineIdx: 0, qtyBase: 10 }] }, MON2))
      .rejects.toThrow(expect.objectContaining({ code: "drug_disease_block", detail: { hits: [expect.objectContaining({ lineIdx: 0, icd10Prefix: "K72" })] } }));
  });
});
