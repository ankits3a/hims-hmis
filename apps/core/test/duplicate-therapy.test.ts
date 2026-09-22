import { setupTestDb, truncateAll } from "./helpers/db";
import { mkPatient, mkUser, seedOpdBase } from "./helpers/opd";
import { withTx } from "../src/kernel/db/client";
import { addMedicine, addSalt, adoptTherapeuticClasses } from "../src/modules/formulary";
import { runRxChecks } from "../src/modules/opd";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../src/kernel/db/client";
import type { RxLine } from "../src/modules/opd";

/**
 * ═══ FORMULARY P23 — A SECOND STATIN, THROUGH THE REAL CHECKS ═══
 *
 * Phase doc `docs/superpowers/plans/2026-09-17-phase-formulary-p23-duplicate-classes.md`. The pure
 * tests prove `checkDuplicateClass`; this one proves the prescription checks call it, over moieties
 * whose class was set by the adoption, and that the hit is a notice rather than a gate.
 */
const PHARMACIST: Actor = { type: "user", id: "01HPHARMACIST0000000000001" };
const line = (drug: string, medicineId: string): RxLine => ({
  drug, medicineId, dose: "1 tab", route: "oral", frequency: "OD", durationDays: 30, instructions: null, noSubstitution: false,
});

describe("duplicate therapy classes × prescription checks (P23)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); });

  it("two statins on one prescription are one soft class notice once the classes are adopted, and nothing before", async () => {
    await seedOpdBase(db);
    const clerk = await mkUser(db, "clerk", []);
    const patient = await mkPatient(db, clerk.actor);
    const medicine = async (brand: string, moiety: string): Promise<string> => {
      const { saltId } = await withTx(db, (tx) => addSalt(tx, PHARMACIST, { name: moiety }));
      return (await withTx(db, (tx) => addMedicine(tx, PHARMACIST, { brandName: brand, form: "tablet", routeClass: "systemic", salts: [{ saltId }] }))).medicineId;
    };
    const lipitor = await medicine("Lipitor 10", "atorvastatin");
    const rosuvas = await medicine("Rosuvas 10", "rosuvastatin");
    const lines = [line("Lipitor 10", lipitor), line("Rosuvas 10", rosuvas)];

    expect((await runRxChecks(db, patient.id, lines, new Date())).duplicates).toEqual([]);

    await withTx(db, (tx) => adoptTherapeuticClasses(tx, PHARMACIST, "P&T resolution 2026-09-17/4", [
      { drugClass: "statin", rule: "therapeutic_subclass_groups#SUB_STATIN", moieties: ["atorvastatin", "rosuvastatin"] },
    ]));

    const after = await runRxChecks(db, patient.id, lines, new Date());
    expect(after.duplicates).toEqual([{
      moiety: "rosuvastatin", drugClass: "statin", with: "atorvastatin", lineIndex: 1, hard: false,
      against: { scope: "in_rx", lineIndex: 0 },
    }]);
    expect(after.allergyMatches).toEqual([]);
    expect(after.interactions).toEqual([]);
  });
});
