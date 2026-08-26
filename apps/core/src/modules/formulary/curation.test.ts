import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import {
  activateOpdVisitDefinition, mkDoctor, mkPatient, mkUser, openOpdVisit, seedOpdBase, seedOpdMasters,
} from "../../../test/helpers/opd";
import { withTx } from "../../kernel/db/client";
import { opdPrescriptions } from "../../kernel/db/schema";
import { COVERAGE_NOTICE_THRESHOLD, getCoverage, getPairOverrideRates } from "./curation";
import { addInteraction, addMedicine, addSalt, updateInteraction } from "./masters";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 16a T8 — the curation surfaces.
 *
 * The coverage arithmetic is the plan's own worked example (2 resolvable of 3 → 0.667, notice OFF),
 * and the empty-book case is asserted separately because "no evidence" and "full coverage" are the
 * two answers that must never be confused: an empty formulary with an empty prescription book
 * would divide 0 by 0, and a `noticeEnabled: true` there would fire the hint on the very first
 * free-text line anybody wrote.
 */
const PHARMACIST: Actor = { type: "user", id: "01HPHARMACIST0000000000001" };
const NOW = new Date("2026-08-26T09:00:00.000Z");
const daysAgo = (n: number): Date => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

describe("formulary curation (Plan 16a T8)", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  /**
   * A REAL encounter, because `opd_prescriptions` has a foreign key to one and a fixture that
   * invented ids was refused by the database — correctly. The rows below are written directly
   * rather than issued through `issuePrescription`, which is deliberate: this module READS the
   * prescription book, and driving the whole consult path to populate it would test T5 again.
   */
  let seq = 0;
  let encounterId = "";
  let patientId = "";
  let doctorId = "";

  beforeEach(async () => {
    await truncateAll(db);
    seq = 0;
    await seedOpdBase(db);
    await activateOpdVisitDefinition(db);
    const { deptId, roomId } = await seedOpdMasters(db);
    const doctor = await mkDoctor(db, { username: "dra", departmentId: deptId, roomId });
    const clerk = await mkUser(db, "clerk", ["front_office"]);
    const patient = await mkPatient(db, clerk.actor, {});
    const opened = await openOpdVisit(
      db,
      { clerk: clerk.actor, patientId: patient.id, departmentId: deptId, doctorId: doctor.doctorId },
      daysAgo(1),
    );
    encounterId = opened.encounterId;
    patientId = patient.id;
    doctorId = doctor.doctorId;
  });

  async function prescribe(
    lines: { drug: string; medicineId?: string | null }[],
    issuedAt: Date = daysAgo(1),
  ): Promise<void> {
    seq += 1;
    const id = `01HRX00000000000000000${String(seq).padStart(4, "0")}`;
    await db.insert(opdPrescriptions).values({
      id, encounterId, patientId, doctorId, version: seq,
      lines: lines.map((l) => ({
        drug: l.drug, dose: "1", route: "oral", frequency: "OD", durationDays: 5,
        instructions: null, noSubstitution: false,
        ...(l.medicineId === undefined ? {} : { medicineId: l.medicineId }),
      })),
      document: {}, allergyOverrides: [], status: "active", issuedBy: PHARMACIST.id, issuedAt,
    });
  }

  // ─────────────────────────────── coverage ───────────────────────────────

  it("an empty book is NOT full coverage, and the notice stays off", async () => {
    const empty = await getCoverage(db, NOW);
    expect(empty).toEqual({ coverage: 0, noticeEnabled: false, unresolvedTop: [] });
  });

  it("counts the resolvable share of the last thirty days and ranks what it could not resolve", async () => {
    const { saltId } = await withTx(db, (tx) => addSalt(tx, PHARMACIST, { name: "paracetamol" }));
    const { medicineId } = await withTx(db, (tx) => addMedicine(tx, PHARMACIST, {
      brandName: "Crocin 650", form: "tablet", routeClass: "systemic", salts: [{ saltId }],
    }));

    // The plan's worked example: 2 resolvable of 3 → 0.667, and the notice is OFF below 0.8.
    await prescribe([
      { drug: "Crocin 650", medicineId },
      { drug: "paracetamol" },
      { drug: "Some Ayurvedic Tonic" },
    ]);
    const coverage = await getCoverage(db, NOW);
    expect(coverage.coverage).toBeCloseTo(2 / 3, 5);
    expect(coverage.noticeEnabled).toBe(false);
    expect(coverage.unresolvedTop).toEqual([{ drug: "Some Ayurvedic Tonic", count: 1 }]);

    // The worklist ranks by how often the hospital actually writes it — the prescribing stream IS
    // the curation queue, most-frequent first.
    await prescribe([{ drug: "Some Ayurvedic Tonic" }, { drug: "Another Herbal Thing" }]);
    await prescribe([{ drug: "Some Ayurvedic Tonic" }]);
    expect((await getCoverage(db, NOW)).unresolvedTop).toEqual([
      { drug: "Some Ayurvedic Tonic", count: 3 },
      { drug: "Another Herbal Thing", count: 1 },
    ]);
  });

  it("crosses the threshold and turns the notice on — and the client is never told the number", async () => {
    const { saltId } = await withTx(db, (tx) => addSalt(tx, PHARMACIST, { name: "paracetamol" }));
    const { medicineId } = await withTx(db, (tx) => addMedicine(tx, PHARMACIST, {
      brandName: "Crocin 650", form: "tablet", routeClass: "systemic", salts: [{ saltId }],
    }));
    // Four resolvable, one not: 0.8 exactly, and the threshold is inclusive.
    await prescribe([
      { drug: "Crocin 650", medicineId }, { drug: "Crocin 650", medicineId },
      { drug: "Crocin 650", medicineId }, { drug: "paracetamol" },
      { drug: "Some Ayurvedic Tonic" },
    ]);
    const coverage = await getCoverage(db, NOW);
    expect(coverage.coverage).toBeCloseTo(0.8, 5);
    expect(coverage.coverage >= COVERAGE_NOTICE_THRESHOLD).toBe(true);
    expect(coverage.noticeEnabled).toBe(true);
  });

  it("looks at thirty days, not at the whole book", async () => {
    await prescribe([{ drug: "Some Ayurvedic Tonic" }], daysAgo(31));
    expect(await getCoverage(db, NOW)).toEqual({ coverage: 0, noticeEnabled: false, unresolvedTop: [] });
    await prescribe([{ drug: "Some Ayurvedic Tonic" }], daysAgo(29));
    expect((await getCoverage(db, NOW)).unresolvedTop).toEqual([{ drug: "Some Ayurvedic Tonic", count: 1 }]);
  });

  // ─────────────────────────── pair usage ───────────────────────────

  it("counts how many issued prescriptions carry each pair, severe and moderate apart", async () => {
    const { saltId: warfarin } = await withTx(db, (tx) => addSalt(tx, PHARMACIST, { name: "warfarin" }));
    const { saltId: aspirin } = await withTx(db, (tx) => addSalt(tx, PHARMACIST, { name: "aspirin" }));
    const { saltId: para } = await withTx(db, (tx) => addSalt(tx, PHARMACIST, { name: "paracetamol" }));
    await withTx(db, (tx) => addInteraction(tx, PHARMACIST, {
      saltAId: warfarin, saltBId: aspirin, severity: "severe",
      note: "bleeding risk — avoid or monitor INR closely", source: "seed-2026-08",
    }));
    await withTx(db, (tx) => addInteraction(tx, PHARMACIST, {
      saltAId: warfarin, saltBId: para, severity: "moderate",
      note: "INR rise on sustained use", source: "manual",
    }));
    const med = async (brandName: string, saltId: string): Promise<string> =>
      (await withTx(db, (tx) => addMedicine(tx, PHARMACIST, {
        brandName, form: "tablet", routeClass: "systemic", salts: [{ saltId }],
      }))).medicineId;
    const warfMed = await med("Warf 5", warfarin);
    const asaMed = await med("Ecosprin 75", aspirin);
    const paraMed = await med("Crocin 650", para);

    // Two prescriptions carry the SEVERE pair; one carries the MODERATE pair.
    await prescribe([{ drug: "Warf 5", medicineId: warfMed }, { drug: "Ecosprin 75", medicineId: asaMed }]);
    await prescribe([{ drug: "Warf 5", medicineId: warfMed }, { drug: "Ecosprin 75", medicineId: asaMed }]);
    await prescribe([{ drug: "Warf 5", medicineId: warfMed }, { drug: "Crocin 650", medicineId: paraMed }]);
    // And one that carries neither.
    await prescribe([{ drug: "Crocin 650", medicineId: paraMed }]);

    const rates = await getPairOverrideRates(db, NOW);
    expect(rates).toHaveLength(2);
    const severe = rates.find((r) => r.severity === "severe")!;
    const moderate = rates.find((r) => r.severity === "moderate")!;

    /**
     * THE SEVERE PAIR'S SHARE IS 1, STRUCTURALLY, and the test says so on purpose: the issue gate
     * refuses a severe hit no override covers, so every one of these two occurrences WAS clicked
     * through. The honest §1.4 rate needs the times it fired and was NOT overridden, which nothing
     * records — see CLOSE F22.
     */
    expect({ hits: severe.timesOnIssued, overridden: severe.timesOverridden, share: severe.overriddenShare })
      .toEqual({ hits: 2, overridden: 2, share: 1 });

    // A moderate pair is a NOTICE and is never gated, so it appears with no override at all.
    expect({ hits: moderate.timesOnIssued, overridden: moderate.timesOverridden, share: moderate.overriddenShare })
      .toEqual({ hits: 1, overridden: 0, share: 0 });

    // Ranked by how often it is being clicked through — the number a curator acts on.
    expect(rates[0]!.severity).toBe("severe");
  });

  it("a pair inside ONE line is not counted — DD8 puts that at admission, not here", async () => {
    const { saltId: a } = await withTx(db, (tx) => addSalt(tx, PHARMACIST, { name: "ciprofloxacin" }));
    const { saltId: b } = await withTx(db, (tx) => addSalt(tx, PHARMACIST, { name: "theophylline" }));
    await withTx(db, (tx) => addInteraction(tx, PHARMACIST, {
      saltAId: a, saltBId: b, severity: "severe", note: "toxicity risk", source: "seed-2026-08",
    }));
    const { medicineId } = await withTx(db, (tx) => addMedicine(tx, PHARMACIST, {
      brandName: "Invented Combination", form: "tablet", routeClass: "systemic",
      salts: [{ saltId: a }, { saltId: b }], acknowledgeIntraFdc: true,
    }));
    await prescribe([{ drug: "Invented Combination", medicineId }]);
    expect(await getPairOverrideRates(db, NOW)).toEqual([]);
  });

  it("an inactive pair drops out of the curator's view immediately", async () => {
    const { saltId: warfarin } = await withTx(db, (tx) => addSalt(tx, PHARMACIST, { name: "warfarin" }));
    const { saltId: aspirin } = await withTx(db, (tx) => addSalt(tx, PHARMACIST, { name: "aspirin" }));
    const { interactionId } = await withTx(db, (tx) => addInteraction(tx, PHARMACIST, {
      saltAId: warfarin, saltBId: aspirin, severity: "severe", note: "bleeding risk", source: "seed-2026-08",
    }));
    const med = async (brandName: string, saltId: string): Promise<string> =>
      (await withTx(db, (tx) => addMedicine(tx, PHARMACIST, {
        brandName, form: "tablet", routeClass: "systemic", salts: [{ saltId }],
      }))).medicineId;
    const warfMed = await med("Warf 5", warfarin);
    const asaMed = await med("Ecosprin 75", aspirin);
    await prescribe([{ drug: "Warf 5", medicineId: warfMed }, { drug: "Ecosprin 75", medicineId: asaMed }]);
    expect(await getPairOverrideRates(db, NOW)).toHaveLength(1);

    await withTx(db, (tx) => updateInteraction(tx, PHARMACIST, interactionId, { active: false }));
    expect(await getPairOverrideRates(db, NOW)).toEqual([]);
  });
});
