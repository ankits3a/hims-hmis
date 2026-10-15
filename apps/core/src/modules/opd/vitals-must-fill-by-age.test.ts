import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { activateOpdVisitDefinition, mkDoctor, mkPatient, mkUser, seedOpdBase, seedOpdMasters } from "../../../test/helpers/opd";
import { opdConfig, opdVitals } from "../../kernel/db/schema";
import { DEFAULT_DANGER_RANGES } from "./config";
import { openVisit } from "./encounters";
import { preStage } from "./prestage";
import { recordVitals } from "./vitals";
import { bandFor, BP_REQUIRED_FROM_YEARS, CHILD_UNDER_YEARS, evaluateVitals, missingRequired, requiredFor, UNDER_SIX_YEARS } from "./vitals-rules";
import type { Db } from "../../kernel/db/client";

/**
 * OWNER 2026-10-08 — *"In the vitals screen, I can see height is mandatory field for 1 year child. and
 * BP is mandatory for a 16yr child. Let's do something for this."* … *"Go with your suggestions."*
 *
 *   under 6            must-fill: weight, arm band (MUAC)
 *   6 to 17            must-fill: weight, height, pulse           (blood pressure shown, optional)
 *   18+ / age unknown  must-fill: blood pressure, pulse, weight, height
 *
 * The stored protocol row is untouched; `requiredFor` narrows it.
 */
const cfg = DEFAULT_DANGER_RANGES;
const need = (age: number | null): string[] => [...requiredFor(bandFor(age, cfg), age)].sort();

describe("must-fill by age (pure)", () => {
  it("the two lines are their own constants, and the paediatric band line is not moved", () => {
    expect(UNDER_SIX_YEARS).toBe(6);
    expect(BP_REQUIRED_FROM_YEARS).toBe(18);
    expect(CHILD_UNDER_YEARS).toBe(13);
  });
  it("under six: weight and the arm band, and nothing else", () => {
    for (const age of [0, 1, 4, 5]) expect(need(age)).toEqual(["muacCm", "weightKg"]);
    expect(missingRequired({ weightKg: 9.4, muacCm: 13.8 }, 1, cfg)).toEqual([]);
    expect(missingRequired({ weightKg: 15, muacCm: 14.2 }, 4, cfg)).toEqual([]);
    expect(missingRequired({ weightKg: 9.4, heightCm: 74, pulse: 120 }, 1, cfg)).toEqual(["muacCm"]);
    expect(missingRequired({ muacCm: 13.8 }, 4, cfg)).toEqual(["weightKg"]);
  });
  it("six to seventeen: weight, height and pulse — no blood pressure", () => {
    for (const age of [6, 8, 12, 13, 16, 17]) expect(need(age)).toEqual(["heightCm", "pulse", "weightKg"]);
    expect(missingRequired({ weightKg: 26, heightCm: 128, pulse: 90 }, 8, cfg)).toEqual([]);
    expect(missingRequired({ weightKg: 54, heightCm: 165, pulse: 78 }, 16, cfg)).toEqual([]);
    expect(missingRequired({ weightKg: 54, heightCm: 165 }, 16, cfg)).toEqual(["pulse"]);
    expect(missingRequired({ weightKg: 26, heightCm: 128 }, 8, cfg)).toEqual(["pulse"]);
  });
  it("eighteen and above, and an unknown age: blood pressure is still must-fill", () => {
    for (const age of [18, 40, null]) expect(need(age)).toEqual(["dbp", "heightCm", "pulse", "sbp", "weightKg"]);
    expect(missingRequired({ weightKg: 60, heightCm: 165, pulse: 78 }, 18, cfg)).toEqual(["sbp", "dbp"]);
    expect(missingRequired({ weightKg: 60, heightCm: 165, pulse: 78 }, null, cfg)).toEqual(["sbp", "dbp"]);
  });
  it("a sixteen-year-old's typed BP is still ranged and flagged exactly as before, and the emergency save still demands BP, pulse and SpO₂", () => {
    expect(evaluateVitals({ sbp: 190, dbp: 100 }, bandFor(16, cfg), cfg).map((f) => [f.vital, f.bound, f.limit])).toEqual([["sbp", "max", 180]]);
    expect(evaluateVitals({ sbp: 150, dbp: 95 }, bandFor(8, cfg), cfg).map((f) => f.vital)).toEqual(["sbp", "dbp"]);
    expect(missingRequired({ weightKg: 54 }, 16, cfg, { emergency: true })).toEqual(["sbp", "dbp", "spo2", "pulse"]);
  });
  it("only ever narrows the stored list — which still says what it said", () => {
    expect(cfg.bands.find((b) => b.key === "child_1_5")!.required).toEqual(["heightCm", "weightKg", "tempC", "spo2", "pulse", "muacCm"]);
    expect(cfg.bands.find((b) => b.key === "adult")!.required).toEqual(["heightCm", "weightKg", "sbp", "dbp", "tempC", "spo2", "pulse"]);
  });
});

describe("must-fill by age (database: the pre-stage and the save agree)", () => {
  const MON = new Date("2026-08-17T04:00:00.000Z");
  const born = (yearsBeforeMon: number): Date => new Date(Date.UTC(2026 - yearsBeforeMon, 0, 15));   // fixed DOBs: exact whole years at MON
  let db: Db;
  let teardown: () => Promise<void>;
  let clerk: Awaited<ReturnType<typeof mkUser>>;
  let vd: Awaited<ReturnType<typeof mkUser>>;
  let dra: Awaited<ReturnType<typeof mkDoctor>>;
  let deptId: string;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    await seedOpdBase(db);
    await activateOpdVisitDefinition(db);
    let roomId: string;
    ({ deptId, roomId } = await seedOpdMasters(db));
    dra = await mkDoctor(db, { username: "dra", departmentId: deptId, roomId });
    clerk = await mkUser(db, "clerk", ["front_office"]);
    vd = await mkUser(db, "vd", ["vitals_desk"]);
  });
  const visitFor = async (age: number): Promise<string> => {
    const p = await mkPatient(db, clerk.actor, { ageYears: undefined, dob: born(age), ...(age < 18 ? { guardian: { name: "G", relationship: "mother" } } : {}) });
    return (await openVisit(db, clerk.actor, { patientId: p.id, departmentId: deptId, doctorId: dra.doctorId }, MON)).encounter.id;
  };

  it.each([1, 4])("a %i-year-old saves on weight and the arm band alone; without the arm band the save is refused", async (age) => {
    const enc = await visitFor(age);
    const p = await preStage(db, vd.actor, enc, MON);
    expect(p.ageYears).toBe(age);
    expect([...p.required].sort()).toEqual(["muacCm", "weightKg"]);
    await expect(recordVitals(db, vd.actor, enc, { weightKg: 10, heightCm: 80, pulse: 110 }, MON))
      .rejects.toMatchObject({ code: "vitals_incomplete", detail: { missing: ["muacCm"] } });
    const r = await recordVitals(db, vd.actor, enc, { weightKg: 10, muacCm: 13.8 }, MON);
    expect([r.vitals.heightCm, r.vitals.pulse, r.vitals.muacCm]).toEqual([null, null, 13.8]);
    // the stored row was never rewritten
    const stored = (await db.select().from(opdConfig).where(eq(opdConfig.id, "main")))[0]!.dangerRanges as typeof DEFAULT_DANGER_RANGES;
    expect(stored.bands.find((b) => b.key === "child_1_5")!.required).toContain("heightCm");
  });

  it.each([8, 16])("a %i-year-old saves on weight, height and pulse with no blood pressure; without the pulse the save is refused", async (age) => {
    const enc = await visitFor(age);
    const p = await preStage(db, vd.actor, enc, MON);
    expect([...p.required].sort()).toEqual(["heightCm", "pulse", "weightKg"]);
    await expect(recordVitals(db, vd.actor, enc, { weightKg: 40, heightCm: 140 }, MON))
      .rejects.toMatchObject({ code: "vitals_incomplete", detail: { missing: ["pulse"] } });
    expect(await db.select().from(opdVitals).where(eq(opdVitals.encounterId, enc))).toHaveLength(0);
    const r = await recordVitals(db, vd.actor, enc, { weightKg: 40, heightCm: 140, pulse: 84 }, MON);
    expect([r.vitals.sbp, r.vitals.dbp]).toEqual([null, null]);
  });

  it("a 16-year-old's typed BP still gets its flag, and the emergency save still demands BP, pulse and SpO₂", async () => {
    const enc = await visitFor(16);
    await expect(recordVitals(db, vd.actor, enc, { weightKg: 54 }, MON, { emergency: true }))
      .rejects.toMatchObject({ code: "vitals_incomplete", detail: { missing: ["sbp", "dbp", "spo2", "pulse"] } });
    const r = await recordVitals(db, vd.actor, enc, { weightKg: 54, heightCm: 165, pulse: 78, sbp: 190, dbp: 100 }, MON);
    expect(r.flags.map((f) => [f.vital, f.value, f.limit])).toEqual([["sbp", 190, 180]]);
  });

  it("an 18-year-old still owes the blood pressure", async () => {
    const enc = await visitFor(18);
    expect((await preStage(db, vd.actor, enc, MON)).required).toEqual(expect.arrayContaining(["sbp", "dbp"]));
    await expect(recordVitals(db, vd.actor, enc, { weightKg: 60, heightCm: 165, pulse: 78 }, MON))
      .rejects.toMatchObject({ code: "vitals_incomplete", detail: { missing: ["sbp", "dbp"] } });
  });
});
