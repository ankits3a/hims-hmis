import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { activateOpdVisitDefinition, mkDoctor, mkPatient, mkUser, seedOpdBase, seedOpdMasters } from "../../../test/helpers/opd";
import { cdsDoctorLearningResets, events, opdComplaintTermUsage, opdEncounterDiagnoses, opdEncounters, opdSuggestionEvents } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { openVisit } from "./encounters";
import { recordComplaintUsage, suggestComplaints } from "./complaints";
import { hiddenSuggestions, recordSignals } from "./consult-guards";
import { learnedAboutMe, myDiagnoses, resetLearning } from "./learned";
import { myTerms, testsForDiagnosis } from "./term-suggest";
import type { Db } from "../../kernel/db/client";

const DAY = 24 * 3600 * 1000;
const T0 = new Date(Date.now() - 20 * DAY); // before the reset
const RESET = new Date(Date.now() - 10 * DAY);
const T1 = new Date(Date.now() - 5 * DAY); // after the reset
/** Opening a visit needs the doctor's working day; the consult's own times are set to T0 / T1 after. */
const MON = new Date("2026-08-17T04:00:00.000Z");

/**
 * DECISION 0050, PLAN P4 (#615) — "each doctor be able to see and reset what the system has learned
 * about them." A reset is a WATERMARK: every personal ranking read that exists today ignores the
 * doctor's own evidence from before it; another doctor's, and the hospital's totals, keep it; nothing
 * is deleted; one audit event names the doctor and the surfaces.
 */
describe("what the system learned about me — the reset watermark", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let deptId: string;
  let dra: Awaited<ReturnType<typeof mkDoctor>>;
  let drb: Awaited<ReturnType<typeof mkDoctor>>;
  let clerk: Awaited<ReturnType<typeof mkUser>>;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });
  beforeEach(async () => {
    await truncateAll(db);
    await seedOpdBase(db);
    await activateOpdVisitDefinition(db);
    let roomId: string; let room2Id: string;
    ({ deptId, roomId, room2Id } = await seedOpdMasters(db));
    dra = await mkDoctor(db, { username: "dra", departmentId: deptId, roomId });
    drb = await mkDoctor(db, { username: "drb", departmentId: deptId, roomId: room2Id });
    clerk = await mkUser(db, "clerk", ["front_office"]);
  });

  const doc = (d: typeof dra) => ({ id: d.doctorId, userId: d.userId });

  /** A completed visit of `doctorId` at `at`, carrying a diagnosis, an advised test and a finding. */
  async function visit(doctorId: string, at: Date, phone: string): Promise<string> {
    const patient = await mkPatient(db, clerk.actor, { ageYears: 30, phone });
    const opened = await openVisit(db, clerk.actor, { patientId: patient.id, departmentId: deptId, doctorId }, MON);
    const id = opened.encounter.id;
    await db.update(opdEncounters).set({
      consultStartedAt: at, consultCompletedAt: at,
      advisedTests: [{ serviceId: "svc_crp", code: "CRP", name: "C-reactive protein", pricePaise: 45000 }],
      examination: [{ group: "general", text: "pallor present" }],
      treatment: ["steam inhalation"],
    } as never).where(eq(opdEncounters.id, id));
    await db.insert(opdEncounterDiagnoses).values({ encounterId: id, seq: 1, text: "Acute URTI", icd10Code: "J06.9" } as never);
    return id;
  }

  it("COMPLAINTS: after a reset the doctor's own count starts again from zero; the other doctor's and the hospital's keep every use", async () => {
    await withTx(db, (tx) => recordComplaintUsage(tx, dra.doctorId, ["bukhar"], T0));
    await withTx(db, (tx) => recordComplaintUsage(tx, dra.doctorId, ["bukhar"], T0));
    await withTx(db, (tx) => recordComplaintUsage(tx, drb.doctorId, ["bukhar"], T0));
    expect((await suggestComplaints(db, dra.doctorId, "bukh")).find((s) => s.term === "bukhar")).toMatchObject({ mine: 2, hospital: 3 });

    await resetLearning(db, dra.actor, doc(dra), ["complaints"], RESET);
    expect((await suggestComplaints(db, dra.doctorId, "bukh")).find((s) => s.term === "bukhar")).toMatchObject({ mine: 0, hospital: 3 });
    expect((await suggestComplaints(db, drb.doctorId, "bukh")).find((s) => s.term === "bukhar")).toMatchObject({ mine: 1, hospital: 3 });
    // A use after the reset counts again.
    await withTx(db, (tx) => recordComplaintUsage(tx, dra.doctorId, ["bukhar"], T1));
    expect((await suggestComplaints(db, dra.doctorId, "bukh")).find((s) => s.term === "bukhar")).toMatchObject({ mine: 1, hospital: 4 });
    // Nothing deleted: the counter rows still hold every use.
    const rows = await db.select().from(opdComplaintTermUsage).where(eq(opdComplaintTermUsage.doctorId, dra.doctorId));
    expect(rows.map((r) => r.uses)).toEqual([3]);
  });

  it("FINDINGS: the doctor's own words from before the reset are not offered back; the other doctor's are", async () => {
    await visit(dra.doctorId, T0, "9876500001");
    await visit(drb.doctorId, T0, "9876500002");
    expect(await myTerms(db, dra.doctorId, "exam_general", "pall")).toEqual([{ term: "pallor present", uses: 1 }]);
    await resetLearning(db, dra.actor, doc(dra), ["findings"], RESET);
    expect(await myTerms(db, dra.doctorId, "exam_general", "pall")).toEqual([]);
    expect(await myTerms(db, dra.doctorId, "treatment", "steam")).toEqual([]);
    expect(await myTerms(db, drb.doctorId, "exam_general", "pall")).toEqual([{ term: "pallor present", uses: 1 }]);
    await visit(dra.doctorId, T1, "9876500003");
    expect(await myTerms(db, dra.doctorId, "treatment", "steam")).toEqual([{ term: "steam inhalation", uses: 1 }]);
  });

  it("TESTS: 'mine' counts only visits after the reset; 'hospital' keeps every visit; the other doctor's 'mine' is untouched", async () => {
    await visit(dra.doctorId, T0, "9876500001");
    await visit(drb.doctorId, T0, "9876500002");
    const dx = [{ text: "Acute URTI", icd10: "J06.9" }];
    expect((await testsForDiagnosis(db, dra.doctorId, dx))[0]).toMatchObject({ serviceId: "svc_crp", mine: 1, hospital: 2 });
    await resetLearning(db, dra.actor, doc(dra), ["tests"], RESET);
    expect((await testsForDiagnosis(db, dra.doctorId, dx))[0]).toMatchObject({ serviceId: "svc_crp", mine: 0, hospital: 2 });
    expect((await testsForDiagnosis(db, drb.doctorId, dx))[0]).toMatchObject({ serviceId: "svc_crp", mine: 1, hospital: 2 });
  });

  it("DIAGNOSES: the phone's most-used list counts only visits after the reset; the other doctor's list is untouched", async () => {
    await visit(dra.doctorId, T0, "9876500001");
    await visit(drb.doctorId, T0, "9876500002");
    expect(await myDiagnoses(db, dra.doctorId, 8)).toEqual([{ text: "Acute URTI", icd10Code: "J06.9", uses: 1 }]);
    await resetLearning(db, dra.actor, doc(dra), ["diagnoses"], RESET);
    expect(await myDiagnoses(db, dra.doctorId, 8)).toEqual([]);
    expect(await myDiagnoses(db, drb.doctorId, 8)).toEqual([{ text: "Acute URTI", icd10Code: "J06.9", uses: 1 }]);
    await visit(dra.doctorId, T1, "9876500003");
    expect(await myDiagnoses(db, dra.doctorId, 8)).toEqual([{ text: "Acute URTI", icd10Code: "J06.9", uses: 1 }]);
  });

  it("HIDDEN: crosses from before the reset no longer hide the item for that doctor; the other doctor's crosses still do; the log keeps every cross", async () => {
    const cross = { kind: "test" as const, source: "suggested" as const, outcome: "dismissed" as const, surface: "consult_web" as const, contextKey: "dx:J06", itemKey: "CRP" };
    await recordSignals(db, dra.actor, { misses: [], suggestions: [cross, cross, cross] }, T0);
    await recordSignals(db, drb.actor, { misses: [], suggestions: [cross, cross, cross] }, T0);
    expect(await hiddenSuggestions(db, dra.actor.id)).toHaveLength(1);
    await resetLearning(db, dra.actor, doc(dra), ["hidden"], RESET);
    expect(await hiddenSuggestions(db, dra.actor.id)).toEqual([]);
    expect(await hiddenSuggestions(db, drb.actor.id)).toHaveLength(1);
    expect(await db.select().from(opdSuggestionEvents).where(eq(opdSuggestionEvents.outcome, "dismissed"))).toHaveLength(6);
  });

  it("A RESET is the caller's own, audited once naming the doctor and the surfaces, and touches only the named surfaces", async () => {
    await expect(resetLearning(db, drb.actor, doc(dra), ["complaints"], RESET)).rejects.toThrow();
    await expect(resetLearning(db, clerk.actor, doc(dra), ["complaints"], RESET)).rejects.toThrow();
    await expect(resetLearning(db, dra.actor, doc(dra), [], RESET)).rejects.toThrow();
    await visit(dra.doctorId, T0, "9876500001");
    await resetLearning(db, dra.actor, doc(dra), ["tests", "hidden"], RESET);
    const audit = (await db.select().from(events)).filter((e) => e.name === "suggestions.learning_reset");
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorType: "user", actorId: dra.userId, payload: { doctorId: dra.doctorId, surfaces: ["tests", "hidden"] } });
    expect(audit[0]!.patientId).toBeNull();
    expect((await db.select().from(cdsDoctorLearningResets)).map((r) => r.surface).sort()).toEqual(["hidden", "tests"]);
    // Findings were not named: still offered back.
    expect(await myTerms(db, dra.doctorId, "exam_general", "pall")).toHaveLength(1);
  });

  it("THE READ: the doctor's own patterns since each watermark — counts and items, no patient, no visit, no price", async () => {
    await withTx(db, (tx) => recordComplaintUsage(tx, dra.doctorId, ["khansi"], T0));
    await visit(dra.doctorId, T0, "9876500001");
    await visit(drb.doctorId, T0, "9876500002");
    const before = await learnedAboutMe(db, doc(dra), []);
    expect(before.complaints).toEqual([{ term: "khansi", uses: 1 }]);
    expect(before.diagnoses).toEqual([{ text: "Acute URTI", icd10Code: "J06.9", uses: 1 }]);
    expect(before.tests).toEqual([{ diagnosis: "J06.9", name: "C-reactive protein", uses: 1 }]);
    expect(before.findings).toEqual(expect.arrayContaining([{ field: "exam_general", term: "pallor present", uses: 1 }, { field: "treatment", term: "steam inhalation", uses: 1 }]));
    expect(before.since.complaints).toBeNull();
    const text = JSON.stringify(before);
    for (const forbidden of ["pricePaise", "45000", "patient", "encounter"]) expect(text).not.toContain(forbidden);

    await resetLearning(db, dra.actor, doc(dra), ["complaints", "diagnoses", "tests", "findings", "hidden"], RESET);
    const after = await learnedAboutMe(db, doc(dra), []);
    expect(after).toMatchObject({ complaints: [], diagnoses: [], tests: [], findings: [] });
    expect(after.since.tests).toBe(RESET.toISOString());
  });
});
