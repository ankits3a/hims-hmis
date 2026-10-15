import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { activateOpdVisitDefinition, mkDoctor, mkPatient, mkUser, seedOpdBase, seedOpdMasters } from "../../../test/helpers/opd";
import { opdConfig, opdVitals } from "../../kernel/db/schema";
import { DEFAULT_DANGER_RANGES } from "./config";
import { getVisit, openVisit } from "./encounters";
import { patientVitalsHistory } from "./history";
import { OpdVisitsController } from "./opd-visits.controller";
import { preStage } from "./prestage";
import { amendVitals, getVitalsForAmend, recordVitals } from "./vitals";
import { bandFor, missingRequired, requiredFor } from "./vitals-rules";
import type { Db } from "../../kernel/db/client";

/**
 * OWNER 2026-10-08 — *"keep BP, Weight, height & Pulse as the primary and add a '+' … Move SpO2 behind
 * '+'. Add Glucose behind '+'."* The server half: an ordinary save no longer demands SpO₂ (whatever
 * the stored band lists), the emergency save still does, a child under six still owes the arm band,
 * and a finger-prick glucose is stored with its timing or not at all.
 */
const MON = new Date("2026-08-17T04:00:00.000Z");
const DOB_ADULT = new Date(Date.UTC(1996, 0, 15));
const DOB_CHILD = new Date(Date.UTC(2023, 0, 15));
/** The four boxes the screen opens with, and nothing else. */
const four = { sbp: 148, dbp: 92, pulse: 84, weightKg: 71.5, heightCm: 168 };

describe("owner 2026-10-08 — SpO₂ is not demanded on an ordinary save (pure)", () => {
  const cfg = DEFAULT_DANGER_RANGES;
  it("no band may demand SpO₂, though every stored band still lists it", () => {
    for (const b of cfg.bands) expect(b.required).toContain("spo2"); // the DATA is untouched
    for (const age of [0, 3, 8, 12, 13, 40, null]) expect(requiredFor(bandFor(age, cfg), age)).not.toContain("spo2");
    expect(missingRequired(four, 40, cfg)).toEqual([]);
  });
  it("the emergency save still demands it", () => {
    expect(missingRequired({ sbp: 208, dbp: 126, pulse: 104 }, 40, cfg, { emergency: true })).toEqual(["spo2"]);
  });
  it("a child under six still owes the arm band", () => {
    expect(requiredFor(bandFor(3, cfg), 3)).toEqual(["weightKg", "muacCm"]);   // height and pulse left the list the same day (must-fill by age)
    expect(missingRequired({ heightCm: 92, weightKg: 14, pulse: 100 }, 3, cfg)).toEqual(["muacCm"]);
  });
  it("a vital taken and wholly held out is still owed, though no band demands it", () => {
    expect(missingRequired(four, 40, cfg, { heldOut: ["spo2"] })).toEqual(["spo2"]);
    expect(missingRequired({ ...four, spo2: 96 }, 40, cfg, { heldOut: [] })).toEqual([]);
  });
});

describe("vitals behind '+': SpO₂ optional, glucose with its timing (database)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let clerk: Awaited<ReturnType<typeof mkUser>>;
  let vd: Awaited<ReturnType<typeof mkUser>>;
  let dra: Awaited<ReturnType<typeof mkDoctor>>;
  let deptId: string;
  let patient: { id: string; uhid: string };
  let child: { id: string; uhid: string };
  let ctl: OpdVisitsController;

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
    patient = await mkPatient(db, clerk.actor, { ageYears: undefined, dob: DOB_ADULT });
    child = await mkPatient(db, clerk.actor, { ageYears: undefined, dob: DOB_CHILD, guardian: { name: "G", relationship: "mother" } });
    ctl = new OpdVisitsController(db, {} as never);
  });

  const visit = async (patientId: string): Promise<string> =>
    (await openVisit(db, clerk.actor, { patientId, departmentId: deptId, doctorId: dra.doctorId }, MON)).encounter.id;

  it("an adult saves on BP, pulse, weight and height alone — and the pre-stage asks for exactly those", async () => {
    const enc = await visit(patient.id);
    // the stored protocol still lists SpO₂ for the adult band: the ruling sits in code, over the data
    const stored = (await db.select().from(opdConfig).where(eq(opdConfig.id, "main")))[0]!.dangerRanges as typeof DEFAULT_DANGER_RANGES;
    expect(stored.bands.find((b) => b.key === "adult")!.required).toContain("spo2");

    const p = await preStage(db, vd.actor, enc, MON);
    expect([...p.required].sort()).toEqual(["dbp", "heightCm", "pulse", "sbp", "weightKg"]);

    const r = await recordVitals(db, vd.actor, enc, four, MON);
    expect(r.vitals.spo2).toBeNull();
    expect(r.encounter.status).toBe("waiting");
  });

  it("the emergency save is still refused without SpO₂", async () => {
    const enc = await visit(patient.id);
    await expect(recordVitals(db, vd.actor, enc, { sbp: 208, dbp: 126, pulse: 104 }, MON, { emergency: true }))
      .rejects.toMatchObject({ code: "vitals_incomplete", detail: { missing: ["spo2"] } });
    expect(await db.select().from(opdVitals).where(eq(opdVitals.encounterId, enc))).toHaveLength(0);
  });

  it("a child under six: the pre-stage demands the arm band, and a save without it is refused", async () => {
    const enc = await visit(child.id);
    const p = await preStage(db, vd.actor, enc, MON);
    expect(p.band).toBe("child_1_5");
    expect(p.required).toContain("muacCm");
    expect(p.required).not.toContain("spo2");
    await expect(recordVitals(db, vd.actor, enc, { heightCm: 92, weightKg: 14, pulse: 100, tempC: 37.2 }, MON))
      .rejects.toMatchObject({ code: "vitals_incomplete", detail: { missing: ["muacCm"] } });
    const ok = await recordVitals(db, vd.actor, enc, { heightCm: 92, weightKg: 14, pulse: 100, tempC: 37.2, muacCm: 13.4 }, MON);
    expect(ok.vitals.muacCm).toBe(13.4);
  });

  it("an SpO₂ that IS typed is still ranged, flagged and held below the probe floor", async () => {
    const enc = await visit(patient.id);
    const r = await recordVitals(db, vd.actor, enc, { ...four, spo2: 86 }, MON);
    expect(r.flags.map((f) => f.vital)).toEqual(["spo2"]);
    const enc2 = await visit((await mkPatient(db, clerk.actor, { ageYears: undefined, dob: DOB_ADULT })).id);
    // a probe error is still not skippable: taken, wholly held below the floor → re-clip it or confirm it
    await expect(recordVitals(db, vd.actor, enc2, { ...four, spo2: 45 }, MON))
      .rejects.toMatchObject({ code: "vitals_incomplete", detail: { missing: ["spo2"] } });
    expect(await db.select().from(opdVitals).where(eq(opdVitals.encounterId, enc2))).toHaveLength(0);
    const reclipped = await recordVitals(db, vd.actor, enc2, four, MON, {
      readings: { bp: { takes: [[148, 92]], source: "typed" }, pulse: { takes: [84], source: "typed" }, weightKg: { takes: [71.5], source: "typed" }, heightCm: { takes: [168], source: "typed" }, spo2: { takes: [45, 96], source: "typed" } },
    });
    expect(reclipped.vitals.spo2).toBe(96);
    expect((reclipped.vitals.readings as { spo2: { held: number[] } }).spo2.held).toEqual([45]); // seen, logged, never a chart fact
  });

  it("glucose 186 with no timing is refused and nothing is written; with 'random' it is stored and read back everywhere", async () => {
    const enc = await visit(patient.id);
    await expect(recordVitals(db, vd.actor, enc, { ...four, glucoseMgDl: 186 }, MON))
      .rejects.toMatchObject({ code: "invalid_vitals", detail: { vital: "glucoseTiming" } });
    expect(await db.select().from(opdVitals).where(eq(opdVitals.encounterId, enc))).toHaveLength(0);

    const r = await recordVitals(db, vd.actor, enc, { ...four, glucoseMgDl: 186, glucoseTiming: "random" }, MON);
    expect([r.vitals.glucoseMgDl, r.vitals.glucoseTiming]).toEqual([186, "random"]);
    expect(r.flags).toEqual([]); // no threshold, no flag — an owner ruling not yet made
    expect((r.vitals.readings as { glucoseMgDl: { takes: number[] } }).glucoseMgDl.takes).toEqual([186]);

    const chart = await getVitalsForAmend(db, vd.actor, r.vitals.id);
    expect([chart!.glucoseMgDl, chart!.glucoseTiming]).toEqual([186, "random"]);
    const seen = await getVisit(db, dra.actor, enc);
    expect(seen!.vitals.map((v) => [v.glucoseMgDl, v.glucoseTiming])).toEqual([[186, "random"]]);
    const history = await patientVitalsHistory(db, dra.actor, patient.id);
    expect(history.map((h) => [h.glucoseMgDl, h.glucoseTiming])).toEqual([[186, "random"]]);
  });

  it("glucose 700, 19 and 186.5 are refused; a timing with no value is dropped", async () => {
    const enc = await visit(patient.id);
    for (const bad of [700, 19, 186.5]) {
      await expect(recordVitals(db, vd.actor, enc, { ...four, glucoseMgDl: bad, glucoseTiming: "fasting" }, MON))
        .rejects.toMatchObject({ code: "invalid_vitals", detail: { vital: "glucoseMgDl" } });
    }
    const r = await recordVitals(db, vd.actor, enc, { ...four, glucoseTiming: "fasting" }, MON);
    expect([r.vitals.glucoseMgDl, r.vitals.glucoseTiming]).toEqual([null, null]);
  });

  it("over HTTP's own schema: the timing is not stripped on the way in, on a save or on an amendment", async () => {
    const enc = await visit(patient.id);
    const body = {
      emergency: false, contextChips: [], glucoseTiming: "after_food",
      readings: {
        bp: { takes: [[148, 92]], source: "typed" }, pulse: { takes: [84], source: "typed" }, weightKg: { takes: [71.5], source: "typed" },
        heightCm: { takes: [168], source: "typed" }, glucoseMgDl: { takes: [186], source: "typed" },
      },
    };
    const saved = await ctl.postVitals(vd.actor, enc, body) as { vitals: { id: string; glucoseMgDl: number | null; glucoseTiming: string | null; spo2: number | null } };
    expect([saved.vitals.glucoseMgDl, saved.vitals.glucoseTiming, saved.vitals.spo2]).toEqual([186, "after_food", null]);
    await expect(ctl.postVitals(vd.actor, await visit(child.id), { ...body, glucoseTiming: "bedtime" })).rejects.toBeDefined();

    // amend: the value moves, the timing moves, the trail names the number
    const amended = await ctl.postVitalsAmend(vd.actor, saved.vitals.id, {
      ...four, glucoseMgDl: 168, glucoseTiming: "random", reason: "Typing error — wrong number keyed",
    }) as { vitals: { glucoseMgDl: number | null; glucoseTiming: string | null }; superseded: string };
    expect([amended.vitals.glucoseMgDl, amended.vitals.glucoseTiming]).toEqual([168, "random"]);
    expect(amended.superseded).toBe(saved.vitals.id);
  });

  it("an amendment that drops the timing from a glucose value is refused; one that clears the value clears both", async () => {
    const enc = await visit(patient.id);
    const r = await recordVitals(db, vd.actor, enc, { ...four, glucoseMgDl: 186, glucoseTiming: "random" }, MON);
    await expect(amendVitals(db, vd.actor, r.vitals.id, { ...four, glucoseMgDl: 190 }, "re-measured", MON))
      .rejects.toMatchObject({ code: "invalid_vitals", detail: { vital: "glucoseTiming" } });
    const a = await amendVitals(db, vd.actor, r.vitals.id, { ...four, glucoseMgDl: null, glucoseTiming: "random" }, "entered on the wrong chart", MON);
    expect([a.vitals.glucoseMgDl, a.vitals.glucoseTiming]).toEqual([null, null]);
  });
});
