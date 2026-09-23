import { eq, sql } from "drizzle-orm";
import { withTx } from "../../kernel/db/client";
import { formularyMedicines } from "../../kernel/db/schema";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { testCfg } from "../../../test/helpers/opd";
import { MON, MON2, addAllergy, seedPharmacyBase } from "../../../test/helpers/pharmacy";
import { addMedicine, addSalt } from "../formulary";
import { registerItem } from "../materials";
import { registerSaleItem } from "../pharmacy";
import { startConsultation } from "./consultation";
import { openVisit } from "./encounters";
import { OpdCdsController } from "./opd-cds.controller";
import { issuePrescription } from "./prescriptions";
import { callNext } from "./queue";
import { recordVitals } from "./vitals";
import type { Actor } from "@hmis/contracts";
import type { PharmacyFixture } from "../../../test/helpers/pharmacy";
import type { RegimenLineOut } from "./opd-cds.controller";
import type { RxLine } from "./prescriptions";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ A REGIMEN FILLS REAL MEDICINES (production, prescription 01M36QQXMD7DKKHZ7MF2ZC1N8W) ═══
 *
 * A doctor filled the URI regimen and issued four lines of free text with no `medicineId`:
 * "Paracetamol Tablets 650mg", "Amoxicillin and Clavulanic Acid 625mg", "Levocetirizine 5mg +
 * Ambroxol 60mg", "Pantoprazole 40mg". The pharmacy could not tell which product was meant, and the
 * issue-time checks — which resolve a line by id, or by EXACT text (DD2) — resolved none of them.
 *
 * R3 is the safety half, measured before the fix: an allergy the doctor records in the room AFTER
 * filling ("Penicillin") did not stop the filled amoxicillin line at issue. The moiety and class
 * paths need a resolution the free text never had, and the substring layer cannot see that
 * "penicillin" is in "Amoxicillin and Clavulanic Acid 625mg". The prescription issued.
 */
const ADULT = { heightCm: 165, weightKg: 60, sbp: 120, dbp: 80, pulse: 72, spo2: 98, tempC: 37.0 };
const HEAD: Actor = { type: "user", id: "01HMATERIALSHEAD00000000001" };

describe("the CDS regimen fill carries catalogue medicines", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: PharmacyFixture;
  let ctl: OpdCdsController;
  let med: { dolo: string; paraGeneric: string; amoxClav: string; augmentin: string; levoAmbro: string; panto: string };

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { fx.unregister(); await teardown(); });
  beforeEach(async () => {
    await truncateAll(db);
    fx?.unregister();
    fx = await seedPharmacyBase(db);
    ctl = new OpdCdsController(db);
    const ph = fx.pharmacist.actor;

    med = await withTx(db, async (tx) => {
      const paraSalt = (await tx.execute<{ id: string }>(sql`select id from formulary_salts where lower(name) = 'paracetamol'`)).rows[0]!.id;
      const amox = await addSalt(tx, ph, { name: "amoxicillin", drugClass: "penicillin" });
      const clav = await addSalt(tx, ph, { name: "clavulanic acid" });
      const levo = await addSalt(tx, ph, { name: "levocetirizine" });
      const ambro = await addSalt(tx, ph, { name: "ambroxol" });
      const pan = await addSalt(tx, ph, { name: "pantoprazole" });
      const mk = async (brandName: string, form: string, strengthLabel: string, salts: string[]): Promise<string> =>
        (await addMedicine(tx, ph, { brandName, form, routeClass: "systemic", strengthLabel, salts: salts.map((saltId) => ({ saltId, strength: strengthLabel })) })).medicineId;
      return {
        // Stocked below. The generic beside it proves the stocked product wins.
        dolo: await mk("Dolo 650", "tablet", "650 mg", [paraSalt]),
        paraGeneric: await mk("Product containing precisely paracetamol 650 milligram/1 each conventional release oral tablet (clinical drug)", "Oral tablet", "650 mg/", [paraSalt]),
        amoxClav: await mk("Amoxicillin 500 mg and clavulanic acid (as clavulanate potassium) 125 mg oral tablet", "Oral tablet", "500 mg/", [amox.saltId, clav.saltId]),
        // A brand the hospital does NOT stock: never chosen, however well it matches.
        augmentin: await mk("Augmentin 625 Duo", "tablet", "500 mg", [amox.saltId, clav.saltId]),
        levoAmbro: await mk("Levocetirizine 5 mg and ambroxol 60 mg oral tablet", "Oral tablet", "5 mg/", [levo.saltId, ambro.saltId]),
        panto: await mk("Pantoprazole (as pantoprazole sodium) 40 mg gastro-resistant oral tablet", "Gastro-resistant oral tablet", "40 mg/", [pan.saltId]),
      };
    });
    /* The catalogue's generics carry a D-code; that is what makes a row a generic. */
    for (const [id, code] of [[med.paraGeneric, "D7225"], [med.amoxClav, "D5952"], [med.levoAmbro, "D1999"], [med.panto, "D8300"]] as const) {
      await db.update(formularyMedicines).set({ code }).where(eq(formularyMedicines.id, id));
    }
    await withTx(db, async (tx) => {
      const { itemId } = await registerItem(tx, HEAD, {
        code: "DOLO650", name: "Dolo 650 tablet", class: "drug", baseUom: "tablet", batchTracked: true,
        formularyMedicineId: med.dolo, gstRateBps: 1200,
        uoms: [{ uom: "strip", toBaseMultiplier: 15, isPurchaseUom: true, isIssueUom: true }],
      });
      await registerSaleItem(tx, fx.pharmacist.actor, itemId);
    });
  });

  async function inConsult(): Promise<string> {
    const opened = await openVisit(db, fx.clerk.actor, { patientId: fx.patient.id, departmentId: fx.deptId, doctorId: fx.doctor.doctorId }, MON);
    await recordVitals(db, fx.vd.actor, opened.encounter.id, ADULT, MON);
    await callNext(db, fx.doctor.actor, opened.sessionId, MON);
    return (await startConsultation(db, fx.doctor.actor, opened.encounter.id, MON)).encounter.id;
  }

  const asRx = (l: RegimenLineOut): RxLine => ({
    drug: l.rx.drug, dose: l.rx.dose, route: l.rx.route, frequency: l.rx.frequency, durationDays: l.rx.durationDays,
    instructions: l.rx.instructions, noSubstitution: l.rx.noSubstitution, medicineId: l.rx.medicineId,
  });

  it("R1: the URI regimen that produced the free-text lines now names a medicine on all four", async () => {
    const encounterId = await inConsult();
    const r = await ctl.regimen(fx.doctor.actor, { syndromeKey: "SYN_URI_01", encounterId });
    const byLabel = new Map(r.regimen.lines.map((l) => [l.drugLabel, l]));

    expect(r.regimen.band).toBe("adult");
    expect(byLabel.get("Amoxicillin and Clavulanic Acid 625mg")!.rx.medicineId).toBe(med.amoxClav);
    expect(byLabel.get("Levocetirizine 5mg + Ambroxol 60mg")!.rx.medicineId).toBe(med.levoAmbro);
    expect(byLabel.get("Pantoprazole 40mg")!.rx.medicineId).toBe(med.panto);
    expect(r.regimen.lines.every((l) => l.rx.medicineId !== null && !l.needsPick)).toBe(true);
    /* A generic keeps the bundle's words; the id is what the checks and the counter read. */
    expect(byLabel.get("Pantoprazole 40mg")!.rx.drug).toBe("Pantoprazole 40mg");
    expect(byLabel.get("Pantoprazole 40mg")!.product).toMatchObject({ code: "D8300", stocked: false });
  });

  it("R2: paracetamol 650 tablet fills the STOCKED Dolo 650, by name, over the generic", async () => {
    const encounterId = await inConsult();
    const r = await ctl.regimen(fx.doctor.actor, { syndromeKey: "SYN_URI_01", encounterId });
    const para = r.regimen.lines.find((l) => l.drugLabel === "Paracetamol Tablets 650mg")!;

    expect(para.rx.medicineId).toBe(med.dolo);
    expect(para.rx.drug).toBe("Dolo 650");
    expect(para.product).toMatchObject({ medicineId: med.dolo, stocked: true });
    /* The unstocked brand is never the server's choice. */
    expect(r.regimen.lines.some((l) => l.rx.medicineId === med.augmentin)).toBe(false);
  });

  it("R3: a penicillin allergy recorded after the fill STOPS the regimen's amoxicillin at issue", async () => {
    const encounterId = await inConsult();
    const r = await ctl.regimen(fx.doctor.actor, { syndromeKey: "SYN_URI_01", encounterId });
    const lines = r.regimen.lines.map(asRx);
    const amoxIndex = r.regimen.lines.findIndex((l) => /amoxicillin/i.test(l.drugLabel));
    expect(amoxIndex).toBeGreaterThanOrEqual(0);

    /* The doctor learns it in the room, after tapping fill — the screen allows exactly that. */
    await addAllergy(db, fx.patient.id, "Penicillin");

    await expect(issuePrescription(db, fx.doctor.actor, testCfg, encounterId, { lines }, MON2)).rejects.toMatchObject({
      code: "allergy_conflict",
      detail: { matches: [{ lineIndex: amoxIndex, substance: "Penicillin" }] },
    });
  });

  it("R4: a line no catalogue product matches stays free text and is marked for the doctor to pick", async () => {
    const encounterId = await inConsult();
    /* SYN_GE_02's adult ondansetron has no product in this catalogue; ORS has no spec at all. */
    const r = await ctl.regimen(fx.doctor.actor, { syndromeKey: "SYN_GE_02", encounterId });
    const ond = r.regimen.lines.find((l) => l.drugLabel === "Ondansetron 4mg")!;
    const ors = r.regimen.lines.find((l) => l.drugLabel === "Oral Rehydration Salts (ORS)")!;

    expect(ond.rx.medicineId).toBeNull();
    expect(ond.rx.drug).toBe("Ondansetron 4mg");
    expect(ond.needsPick).toBe(true);
    expect(ors.rx.medicineId).toBeNull();
    expect(ors.needsPick).toBe(ors.dose.state !== "advice_only");
  });
});
