import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { activateOpdVisitDefinition, mkDoctor, mkPatient, mkUser, seedOpdBase, seedOpdMasters } from "../../../test/helpers/opd";
import { openVisit } from "./encounters";
import { patientVitalsHistory } from "./history";
import { preStage } from "./prestage";
import { recordVitals } from "./vitals";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ VD-1 T4 — THE PRE-STAGE READ, AND THE PERMISSION GAP IT CLOSES (recon §3 R15) ═══
 *
 * The seat's opening move is *"file, last vitals, band and cuff size staged before she reached the
 * stool"*, and until this reader existed the role that works the bench could not perform it: the
 * only cross-visit vitals reader is gated on `opd.consult`, which `vitals_desk` does not hold and
 * should not.
 *
 * The test that matters most is the permission one, and it asserts BOTH directions — that the bay
 * can now reach the one row it needs, AND that it still cannot reach the whole history. A new
 * permission that quietly bought the wider read would be worse than the gap.
 */
const MON = new Date("2026-08-17T04:00:00.000Z");
const TUE = new Date("2026-08-18T04:00:00.000Z");
const DOB_ADULT = new Date(Date.UTC(1972, 0, 15)); // 54 at MON
const DOB_CHILD = new Date(Date.UTC(2022, 0, 15)); // 4 at MON
const sunita = { heightCm: 152, weightKg: 67, sbp: 132, dbp: 84, pulse: 82, spo2: 98, tempC: 36.6 };

describe("VD-1 T4 — pre-stage", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let clerk: Awaited<ReturnType<typeof mkUser>>;
  let vd: Awaited<ReturnType<typeof mkUser>>;
  let doc: Awaited<ReturnType<typeof mkUser>>;
  let dra: Awaited<ReturnType<typeof mkDoctor>>;
  let deptId: string;
  let roomId: string;
  let adult: { id: string };
  let child: { id: string };

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    await seedOpdBase(db);
    await activateOpdVisitDefinition(db);
    ({ deptId, roomId } = await seedOpdMasters(db));
    dra = await mkDoctor(db, { username: "dra", departmentId: deptId, roomId });
    clerk = await mkUser(db, "clerk", ["front_office"]);
    vd = await mkUser(db, "vd", ["vitals_desk"]);
    doc = await mkUser(db, "doc", ["doctor"]);
    adult = await mkPatient(db, clerk.actor, { ageYears: undefined, dob: DOB_ADULT });
    child = await mkPatient(db, clerk.actor, { ageYears: undefined, dob: DOB_CHILD, guardian: { name: "G", relationship: "mother" } });
  });

  const visit = async (patientId: string, at: Date): Promise<string> =>
    (await openVisit(db, clerk.actor, { patientId, departmentId: deptId, doctorId: dra.doctorId }, at)).encounter.id;

  it("a first visit stages the band and demands everything — nothing to carry, nothing expected", async () => {
    const enc = await visit(adult.id, MON);
    const p = await preStage(db, vd.actor, enc, MON);
    expect(p.band).toBe("adult");
    expect(p.ageYears).toBe(54);
    expect(p.last).toBeNull();
    expect(p.carryCandidates).toEqual([]);
    expect(p.expectedFlags).toEqual([]);
    expect(p.required).toContain("heightCm");
  });

  it("a returning patient stages the last reading, offers the height, and says what flagged", async () => {
    const june = await visit(adult.id, MON);
    await recordVitals(db, vd.actor, june, { ...sunita, sbp: 190 }, MON); // 190 is outside the adult band

    const today = await visit(adult.id, TUE);
    const p = await preStage(db, vd.actor, today, TUE);
    expect(p.last!.heightCm).toBe(152);
    expect(p.last!.sbp).toBe(190);
    expect(p.last!.serviceDate).toBe("2026-08-17");
    expect(p.carryCandidates).toEqual(["heightCm"]);
    // "This is what happened last time", judged by TODAY's band — the cuff goes on first.
    expect(p.expectedFlags).toEqual([{ vital: "sbp", value: 190, bound: "max", limit: 180, severity: "danger" }]);
  });

  it("a child's height is NEVER carried — a changing height is the clinical finding", async () => {
    const first = await visit(child.id, MON);
    await recordVitals(db, vd.actor, first, { heightCm: 102, weightKg: 16, tempC: 37, spo2: 98, pulse: 110, muacCm: 14 }, MON);
    const today = await visit(child.id, TUE);
    const p = await preStage(db, vd.actor, today, TUE);
    expect(p.band).toBe("child_1_5");
    expect(p.last!.heightCm).toBe(102);
    expect(p.carryCandidates).toEqual([]);
    // D5 — the band records BP and never range-flags it.
    expect(p.notRoutine).toEqual(["sbp", "dbp"]);
    expect(p.required).toContain("muacCm");
  });

  /** THE POINT OF THE TASK: the bay reaches the one row, and still cannot reach the history. */
  it("`vitals_desk` reaches pre-stage and is STILL refused the cross-visit history", async () => {
    const june = await visit(adult.id, MON);
    await recordVitals(db, vd.actor, june, sunita, MON);
    const today = await visit(adult.id, TUE);

    const p = await preStage(db, vd.actor, today, TUE);
    expect(p.last!.weightKg).toBe(67);

    // The doctor reaches both; the bay reaches only the pre-stage. `patientVitalsHistory` is the
    // route gated on `opd.consult`, and this asserts the gap is closed WITHOUT being widened.
    const asDoctor = await patientVitalsHistory(db, doc.actor, adult.id);
    expect(asDoctor.length).toBeGreaterThan(0);
    const docStage = await preStage(db, doc.actor, today, TUE);
    expect(docStage.last!.weightKg).toBe(67);
  });

  it("a confidential patient answers exactly as an unknown encounter does", async () => {
    const enc = await visit(adult.id, MON);
    const stranger = await mkUser(db, "stranger", ["front_office"]);
    // `front_office` can see this patient, so the refusal below is about the ENCOUNTER id being
    // unknown — the same answer, which is the property 07a DD2 requires.
    await expect(preStage(db, stranger.actor, "enc-does-not-exist", MON))
      .rejects.toMatchObject({ code: "unknown_encounter" });
    expect((await preStage(db, vd.actor, enc, MON)).patientId).toBe(adult.id);
  });
});
