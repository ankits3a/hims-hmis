import { sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "./helpers/db";
import { mkPatient, mkUser, seedOpdBase } from "./helpers/opd";
import { withTx } from "../src/kernel/db/client";
import {
  addMedicine, addSalt, attestSubstance, normalizeDrugName, refreshRankSignals, resolveDrugTexts,
} from "../src/modules/formulary";
import { runRxChecks } from "../src/modules/opd";
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

  async function patientAllergicTo(substance: string): Promise<string> {
    await seedOpdBase(db);
    const clerk = await mkUser(db, "clerk", []);
    const patient = await mkPatient(db, clerk.actor);
    await withTx(db, (tx) => addAllergy(tx, clerk.actor, patient.id, { substance, severity: "severe", source: "consult" }));
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

  it("a text naming a mapped release entry resolves to the entry AND the moiety it was mapped to", async () => {
    const w = await world();
    await withTx(db, (tx) => attestSubstance(tx, PHARMACIST, w.substance, { saltId: w.amox }));

    const resolved = (await resolveDrugTexts(db, ["Amoxicillin trihydrate"])).get("Amoxicillin trihydrate");

    expect(resolved?.salts.map((s) => [s.saltId, s.drugClass]).sort()).toEqual([
      [w.amox, "penicillin"], [w.image, null],
    ].sort());
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
