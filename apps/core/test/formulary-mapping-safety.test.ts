import { eq, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "./helpers/db";
import {
  activateOpdVisitDefinition, mkDoctor, mkPatient, mkUser, seedOpdBase, seedOpdMasters, testCfg,
} from "./helpers/opd";
import { withTx } from "../src/kernel/db/client";
import { events } from "../src/kernel/db/schema";
import {
  addMedicine, addSalt, adoptAllergyClasses, attestSubstance, catalogueCensus, normalizeDrugName, refreshRankSignals, resolveDrugTexts,
  ruleSubstanceUnmappable, searchMedicines,
} from "../src/modules/formulary";
import { runRxChecks } from "../src/modules/opd";
import { startConsultation } from "../src/modules/opd/consultation";
import { openVisit } from "../src/modules/opd/encounters";
import { issuePrescription, precheckPrescription } from "../src/modules/opd/prescriptions";
import { callNext } from "../src/modules/opd/queue";
import { recordVitals } from "../src/modules/opd/vitals";
import { addAllergy } from "../src/modules/patients";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../src/kernel/db/client";
import type { RxLine } from "../src/modules/opd";

/**
 * ═══ A MAPPING DECISION MUST NOT SILENCE A CHECK THAT WAS FIRING — THE SEAM TEST ═══
 *
 * Formulary phase 2 moves a product's composition row from a release entry ("Amoxicillin
 * trihydrate") to the moiety a pharmacist attested ("amoxicillin"). Both ends of that move were
 * right, and the seam between them was not.
 *
 * An allergy is stored as TEXT and resolved at check time. The text "Amoxicillin trihydrate"
 * resolves, by exact moiety name, to the release entry. Before the decision the product contained
 * that entry, so the allergy matched. After it, the product contains `amoxicillin`, and none of the
 * three allergy layers could see it:
 *   - no shared salt id;
 *   - the allergy text is neither the moiety's name nor its class;
 *   - the brand text does not contain the allergy text.
 * The decision that was supposed to make the checks better made one stop firing.
 *
 * This runs the real prescription checks (`runRxChecks`), with a real patient and a real allergy
 * record, across the real decision.
 */
const PHARMACIST: Actor = { type: "user", id: "01HPHARMACIST0000000000001" };
const AMOX_TRIHYDRATE = "96068000";

const line = (drug: string, medicineId: string | null): RxLine => ({
  drug, medicineId, dose: "1 tab", route: "oral", frequency: "TDS", durationDays: 5, instructions: null, noSubstitution: false,
});

describe("formulary mapping × prescription checks", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); });

  async function world(): Promise<{ amox: string; substance: string; image: string; mox: string; novamox: string }> {
    const { saltId: amox } = await withTx(db, (tx) => addSalt(tx, PHARMACIST, { name: "amoxicillin", drugClass: "penicillin" }));
    const substance = newId();
    const image = newId();
    await db.execute(sql`
      insert into formulary_substances (id, sctid, name, synonyms, mapping_status, source, created_by, updated_by)
      values (${substance}, ${AMOX_TRIHYDRATE}, 'Amoxicillin trihydrate (substance)', '[]'::jsonb, 'pending', 'nrces-2026-09', 'nrces-test', 'nrces-test')
    `);
    await db.execute(sql`
      insert into formulary_salts (id, name, aliases, source_ref, created_by, updated_by)
      values (${image}, 'Amoxicillin trihydrate', '[]'::jsonb, ${AMOX_TRIHYDRATE}, 'cds-import', 'cds-import')
    `);
    const mox = newId();
    await db.execute(sql`
      insert into formulary_medicines (id, brand_name, name_normalized, form, route_class, created_by, updated_by)
      values (${mox}, 'Mox 250 Kid', ${normalizeDrugName("Mox 250 Kid")}, 'tablet', 'systemic', 'cds-import', 'cds-import')
    `);
    await db.execute(sql`
      insert into formulary_medicine_salts (medicine_id, salt_id, strength, source, derived_from)
      values (${mox}, ${image}, '250 mg', 'derived', ${AMOX_TRIHYDRATE})
    `);
    // Composed by hand from the release entry, before anybody decided what that entry is.
    const { medicineId: novamox } = await withTx(db, (tx) => addMedicine(tx, PHARMACIST, {
      brandName: "Novamox 500", form: "capsule", routeClass: "systemic", salts: [{ saltId: image }],
    }));
    await withTx(db, (tx) => refreshRankSignals(tx, "all"));
    return { amox, substance, image, mox, novamox };
  }

  async function patientAllergicTo(substance: string, allergenClass: string | null = null): Promise<string> {
    await seedOpdBase(db);
    const clerk = await mkUser(db, "clerk", []);
    const patient = await mkPatient(db, clerk.actor);
    await withTx(db, (tx) => addAllergy(tx, clerk.actor, patient.id, { substance, severity: "severe", source: "consult", allergenClass }));
    return patient.id;
  }

  it("an allergy recorded against the release entry still fires on the product after the entry is mapped", async () => {
    const w = await world();
    const patientId = await patientAllergicTo("Amoxicillin trihydrate");
    const before = await runRxChecks(db, patientId, [line("Mox 250 Kid", w.mox)], new Date());
    expect(before.allergyMatches).toEqual([{ lineIndex: 0, substance: "Amoxicillin trihydrate" }]);

    await withTx(db, (tx) => attestSubstance(tx, PHARMACIST, w.substance, { saltId: w.amox }));

    const after = await runRxChecks(db, patientId, [line("Mox 250 Kid", w.mox)], new Date());
    expect(after.allergyMatches).toEqual([{ lineIndex: 0, substance: "Amoxicillin trihydrate" }]);
  });

  it("a penicillin allergy reaches a hand-composed product whose release entry has since been mapped", async () => {
    const w = await world();
    const patientId = await patientAllergicTo("penicillin");
    const before = await runRxChecks(db, patientId, [line("Novamox 500", w.novamox)], new Date());
    // The known gap the `reviewed` flag names: an unreviewed entry carries no class.
    expect(before.allergyMatches).toEqual([]);

    await withTx(db, (tx) => attestSubstance(tx, PHARMACIST, w.substance, { saltId: w.amox }));

    const after = await runRxChecks(db, patientId, [line("Novamox 500", w.novamox)], new Date());
    expect(after.allergyMatches).toEqual([{ lineIndex: 0, substance: "penicillin" }]);
  });

  it("a class the doctor PICKED reaches the product once the allergy classes are adopted (formulary P22)", async () => {
    const w = await world();
    await withTx(db, (tx) => attestSubstance(tx, PHARMACIST, w.substance, { saltId: w.amox }));
    // The doctor picked the class and kept their own words for the substance.
    const patientId = await patientAllergicTo("Penicillin (rash, 2019)", "Penicillins / Beta-Lactams");
    const before = await runRxChecks(db, patientId, [line("Mox 250 Kid", w.mox)], new Date());
    // The picked class is neither a moiety nor a drug class: silent until the classes are adopted.
    expect(before.allergyMatches).toEqual([]);

    await withTx(db, (tx) => adoptAllergyClasses(tx, PHARMACIST, "P&T resolution 2026-09-17/3", [
      { classKey: "penicillin", rule: "allergy_cross_reactivity_rules#1", moieties: ["amoxicillin"] },
    ]));

    const after = await runRxChecks(db, patientId, [line("Mox 250 Kid", w.mox), line("Novamox 500", w.novamox)], new Date());
    expect(after.allergyMatches).toEqual([
      { lineIndex: 0, substance: "Penicillin (rash, 2019)" }, { lineIndex: 1, substance: "Penicillin (rash, 2019)" },
    ]);
  });

  it("a text naming a mapped release entry resolves to the entry AND the moiety it was mapped to", async () => {
    const w = await world();
    await withTx(db, (tx) => attestSubstance(tx, PHARMACIST, w.substance, { saltId: w.amox }));

    const resolved = (await resolveDrugTexts(db, ["Amoxicillin trihydrate"])).get("Amoxicillin trihydrate");

    expect(resolved?.salts.map((s) => [s.saltId, s.drugClass]).sort()).toEqual([
      [w.amox, "penicillin"], [w.image, null],
    ].sort());
  });

  /**
   * ═══ A LINE WITH AN UNREVIEWED COMPONENT WAS CHECKED ONLY IN PART (phase doc §3.4) ═══
   *
   * An unreviewed release entry carries no drug class and no interaction pairs. A line containing
   * one used to come back from `runRxChecks` exactly like a fully checked line: resolved, no hits.
   * The doctor's picker said "not yet reviewed by pharmacy", and the check said nothing. The server
   * now names such lines, and it must name the same products the picker does.
   */
  describe("which lines the checks could see only in part", () => {
    it("names every line on an unreviewed entry, and none once the entry's substance is mapped", async () => {
      const w = await world();
      const patientId = await patientAllergicTo("sulfonamide");
      // A projected product, a hand-composed one, and a text naming the entry.
      const lines = [line("Mox 250 Kid", w.mox), line("Novamox 500", w.novamox), line("Amoxicillin trihydrate", null)];

      const before = await runRxChecks(db, patientId, lines, new Date());
      expect([before.unreviewedLineIndexes, before.unresolvedLineIndexes]).toEqual([[0, 1, 2], []]);

      await withTx(db, (tx) => attestSubstance(tx, PHARMACIST, w.substance, { saltId: w.amox }));

      // Mox moved to the moiety. Novamox and the text still name the entry, and the moiety beside it.
      const after = await runRxChecks(db, patientId, lines, new Date());
      expect([after.unreviewedLineIndexes, after.unresolvedLineIndexes]).toEqual([[], []]);
    });

    it("agrees with the doctor's picker and the census, product by product: pending, mapped, then ruled unmappable", async () => {
      const w = await world();
      const patientId = await patientAllergicTo("sulfonamide");
      const products = [{ id: w.mox, name: "Mox 250 Kid" }, { id: w.novamox, name: "Novamox 500" }];
      const both = async (): Promise<{ checks: boolean[]; picker: (boolean | undefined)[]; census: number }> => {
        const out = await runRxChecks(db, patientId, products.map((p) => line(p.name, p.id)), new Date());
        const picker = await Promise.all(products.map(async (p) =>
          (await searchMedicines(db, p.name)).find((h) => h.id === p.id)?.reviewed));
        const census = (await catalogueCensus(db)).unreviewedActiveMedicines;
        return { checks: products.map((_, i) => !out.unreviewedLineIndexes.includes(i)), picker, census };
      };

      expect(await both()).toEqual({ checks: [false, false], picker: [false, false], census: 2 });

      await withTx(db, (tx) => attestSubstance(tx, PHARMACIST, w.substance, { saltId: w.amox }));
      expect(await both()).toEqual({ checks: [true, true], picker: [true, true], census: 0 });

      // E4: an unmappable ruling returns the rows to the entry, and the product is unreviewed again.
      await withTx(db, (tx) => ruleSubstanceUnmappable(tx, PHARMACIST, w.substance, {
        reason: "test: the attestation above was wrong", correction: true,
      }));
      expect(await both()).toEqual({ checks: [false, false], picker: [false, false], census: 2 });
    });

    it("names a product only partly reviewed, and leaves a line it cannot resolve to the other list", async () => {
      const w = await world();
      const patientId = await patientAllergicTo("sulfonamide");
      const { saltId: clav } = await withTx(db, (tx) => addSalt(tx, PHARMACIST, { name: "clavulanic acid" }));
      const { medicineId: mixed } = await withTx(db, (tx) => addMedicine(tx, PHARMACIST, {
        brandName: "Moxclav 625", form: "tablet", routeClass: "systemic", salts: [{ saltId: w.image }, { saltId: clav }],
      }));
      const { medicineId: curated } = await withTx(db, (tx) => addMedicine(tx, PHARMACIST, {
        brandName: "Clavo Only", form: "tablet", routeClass: "systemic", salts: [{ saltId: clav }],
      }));

      const out = await runRxChecks(db, patientId, [
        line("Moxclav 625", mixed), line("Clavo Only", curated), line("Some Ayurvedic Tonic", null),
      ], new Date());

      expect([out.unreviewedLineIndexes, out.unresolvedLineIndexes]).toEqual([[0], [2]]);
    });

    it("\"it is its own moiety\" makes the entry's lines reviewed without moving a row", async () => {
      const w = await world();
      const patientId = await patientAllergicTo("sulfonamide");
      const lines = [line("Mox 250 Kid", w.mox), line("Amoxicillin trihydrate", null)];
      expect((await runRxChecks(db, patientId, lines, new Date())).unreviewedLineIndexes).toEqual([0, 1]);

      await withTx(db, (tx) => attestSubstance(tx, PHARMACIST, w.substance, { saltId: w.image }));

      expect((await runRxChecks(db, patientId, lines, new Date())).unreviewedLineIndexes).toEqual([]);
    });
  });
});

/**
 * ═══ THE DOCTOR IS TOLD BEFORE AND AFTER THE ISSUE, AND THE RECORD KEEPS IT ═══
 *
 * The consult screen shows the pre-check's answer only when a hard warning pauses the issue.
 * Otherwise the prescription issues at once, and the only thing that reaches the doctor afterwards
 * is the issue's own response. So the issue returns the list too. The `prescription.issued` event
 * records it: which prescriptions were checked only in part is what a later retro-scan needs, and
 * the next attestation changes the live answer.
 */
describe("an issued prescription with a line checked only in part", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); });

  const MON = new Date("2026-08-17T04:00:00.000Z");
  const MON2 = new Date(MON.getTime() + 20 * 60_000);
  const adultOk = { heightCm: 165, weightKg: 60, sbp: 120, dbp: 80, pulse: 72, spo2: 98, tempC: 37.0 };

  it("returns the lines from the pre-check and the issue, and records them on the event", async () => {
    await seedOpdBase(db);
    await activateOpdVisitDefinition(db);
    const { deptId, roomId } = await seedOpdMasters(db);
    const dra = await mkDoctor(db, { username: "dra", departmentId: deptId, roomId });
    const clerk = await mkUser(db, "clerk", ["front_office"]);
    const vd = await mkUser(db, "vd", ["vitals_desk"]);
    const patient = await mkPatient(db, clerk.actor);

    const { saltId: paracetamol } = await withTx(db, (tx) => addSalt(tx, PHARMACIST, { name: "paracetamol", drugClass: "analgesic" }));
    const { medicineId: crocin } = await withTx(db, (tx) => addMedicine(tx, PHARMACIST, {
      brandName: "Crocin 500", form: "tablet", routeClass: "systemic", salts: [{ saltId: paracetamol }],
    }));
    const image = newId();
    await db.execute(sql`
      insert into formulary_salts (id, name, aliases, source_ref, created_by, updated_by)
      values (${image}, 'Amoxicillin trihydrate', '[]'::jsonb, ${AMOX_TRIHYDRATE}, 'cds-import', 'cds-import')
    `);
    const { medicineId: novamox } = await withTx(db, (tx) => addMedicine(tx, PHARMACIST, {
      brandName: "Novamox 500", form: "capsule", routeClass: "systemic", salts: [{ saltId: image }],
    }));

    const opened = await openVisit(db, clerk.actor, { patientId: patient.id, departmentId: deptId, doctorId: dra.doctorId }, MON);
    await recordVitals(db, vd.actor, opened.encounter.id, adultOk, MON);
    await callNext(db, dra.actor, opened.sessionId, MON);
    const enc = (await startConsultation(db, dra.actor, opened.encounter.id, MON)).encounter;
    const lines = [line("Crocin 500", crocin), line("Novamox 500", novamox), line("Some Ayurvedic Tonic", null)];

    const pre = await precheckPrescription(db, dra.actor, enc.id, lines, MON2);
    expect([pre.unreviewedLineIndexes, pre.unresolvedLineIndexes]).toEqual([[1], [2]]);

    const issued = await issuePrescription(db, dra.actor, testCfg, enc.id, { lines }, MON2);
    expect(issued.unreviewedLineIndexes).toEqual([1]);

    const recorded = await db.select({ payload: events.payload }).from(events).where(eq(events.name, "prescription.issued"));
    expect(recorded.map((r) => (r.payload as { unreviewedLineIndexes?: unknown }).unreviewedLineIndexes)).toEqual([[1]]);
  });
});

/**
 * ═══ A BRAND NAME TWO PRODUCTS SHARE NAMES THEIR MOIETIES, NOT ONE OF THEM ═══
 *
 * 103,383 brand names on the loaded catalogue normalise to 103,332 keys, so 51 names collide
 * (`Ab-Xone` and `Abxone`). The resolver kept whichever row came LAST. That row's id then became the
 * DISPENSED medicine at the pharmacy counter for a free-typed line (`pharmacy/claim.ts`,
 * `substitutionType: "resolved"`), and 6 of the 51 differ in strength, form or route. The server
 * was choosing which product the doctor meant.
 *
 * DD2 and FD-35's rule settle it: exact resolution, and a guard rather than a correction. The text
 * exactly names two products, so it resolves to what both are made of (the checks still fire),
 * and to NO product (the pharmacist picks at the counter). If the two ever differ in composition,
 * the union is the conservative answer, as C1/C2's union is.
 */
describe("an ambiguous brand name", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); });

  it("resolves to the union of the colliding products' moieties and to no product", async () => {
    const { saltId: ceftriaxone } = await withTx(db, (tx) => addSalt(tx, PHARMACIST, { name: "ceftriaxone", drugClass: "cephalosporin" }));
    const { saltId: sulbactam } = await withTx(db, (tx) => addSalt(tx, PHARMACIST, { name: "sulbactam" }));
    await withTx(db, (tx) => addMedicine(tx, PHARMACIST, {
      brandName: "Ab-Xone", form: "injection", routeClass: "systemic", strengthLabel: "1 g", salts: [{ saltId: ceftriaxone }],
    }));
    await withTx(db, (tx) => addMedicine(tx, PHARMACIST, {
      brandName: "Abxone", form: "injection", routeClass: "systemic", strengthLabel: "1.5 g",
      salts: [{ saltId: ceftriaxone }, { saltId: sulbactam }],
    }));
    const { medicineId: single } = await withTx(db, (tx) => addMedicine(tx, PHARMACIST, {
      brandName: "Monocef 1g", form: "injection", routeClass: "systemic", salts: [{ saltId: ceftriaxone }],
    }));

    const out = await resolveDrugTexts(db, ["ABXONE", "Monocef 1g"]);

    const ambiguous = out.get("ABXONE");
    expect(ambiguous?.medicineId).toBeNull();
    expect(ambiguous?.brandName).toBeNull();
    expect(ambiguous?.routeClass).toBe("systemic");
    expect(ambiguous?.salts.map((s) => s.saltId).sort()).toEqual([ceftriaxone, sulbactam].sort());
    // A name only one product carries still names that product.
    expect(out.get("Monocef 1g")?.medicineId).toBe(single);
  });

  it("reports systemic when any colliding product is, because a topical guess would suppress a warning", async () => {
    const { saltId: diclofenac } = await withTx(db, (tx) => addSalt(tx, PHARMACIST, { name: "diclofenac", drugClass: "nsaid" }));
    // The topical one is written LAST, so a resolver that keeps the last row answers "topical".
    await withTx(db, (tx) => addMedicine(tx, PHARMACIST, {
      brandName: "Dynapain", form: "tablet", routeClass: "systemic", salts: [{ saltId: diclofenac }],
    }));
    await withTx(db, (tx) => addMedicine(tx, PHARMACIST, {
      brandName: "Dyna-Pain", form: "gel", routeClass: "topical", salts: [{ saltId: diclofenac }],
    }));

    expect((await resolveDrugTexts(db, ["dynapain"])).get("dynapain")?.routeClass).toBe("systemic");
  });
});
