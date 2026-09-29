import { and, eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import {
  activateOpdVisitDefinition, mkDoctor, mkPatient, mkUser, seedOpdBase, seedOpdMasters, testCfg,
} from "../../../test/helpers/opd";
import { opdSectionRecords } from "../../kernel/db/schema";
import { openVisit } from "./encounters";
import { recordVitals } from "./vitals";
import { callNext } from "./queue";
import { startConsultation } from "./consultation";
import { OpdQueueController } from "./opd-queue.controller";
import { visitLayout } from "./layout";
import { whoZ } from "./paeds";
import { saveVisitSection, visitSections } from "./sections";
import type { Db } from "../../kernel/db/client";

/**
 * CONSULT ENGINE, SECOND SPECIALTY — PAEDIATRICS (01-CONSULT-ENGINE.md §6.2). The PED department's
 * consult gains the Child sections, chosen by the department code like ophthalmology's; the
 * visit's read carries the child's age in Y-M-D, growth against WHO with today's weight, and the
 * IAP 2023 immunisation timetable. "Given today" is append-only across the child's visits.
 */
const MON = new Date("2026-09-28T04:00:00.000Z"); // 09:30 IST
const LATER = new Date("2026-09-28T04:20:00.000Z");
const DOB = new Date(Date.UTC(2025, 5, 15)); // 1 y 3 m 13 d at MON
const toddler = { heightCm: 76, weightKg: 9.6, tempC: 37, spo2: 98, pulse: 120, muacCm: 14 };
const adultOk = { heightCm: 172, weightKg: 70, sbp: 118, dbp: 76, pulse: 70, rr: 15, spo2: 99, tempC: 36.6 };

describe("consult engine — the paediatrics sections", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let clerk: Awaited<ReturnType<typeof mkUser>>;
  let vd: Awaited<ReturnType<typeof mkUser>>;
  let drp: Awaited<ReturnType<typeof mkDoctor>>; // the paediatrician
  let drq: Awaited<ReturnType<typeof mkDoctor>>; // a second paediatrician
  let drm: Awaited<ReturnType<typeof mkDoctor>>; // general medicine
  let pedDeptId: string;
  let medDeptId: string;
  let childId: string;
  let adultId: string;
  let ctl: OpdQueueController;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());

  beforeEach(async () => {
    await truncateAll(db);
    await seedOpdBase(db);
    await activateOpdVisitDefinition(db);
    const m = await seedOpdMasters(db);
    medDeptId = m.deptId;
    pedDeptId = m.dept2Id; // the fixture's second department is PED — "Paediatrics"
    drm = await mkDoctor(db, { username: "drm", departmentId: medDeptId, roomId: m.roomId });
    drp = await mkDoctor(db, { username: "drp", departmentId: pedDeptId, roomId: m.room2Id });
    drq = await mkDoctor(db, { username: "drq", departmentId: pedDeptId, roomId: m.room2Id });
    clerk = await mkUser(db, "clerk1", ["front_office_t"]);
    vd = await mkUser(db, "vitals1", ["vitals_desk"]);
    childId = (await mkPatient(db, clerk.actor, { ageYears: undefined, dob: DOB, guardian: { name: "Sunita", relationship: "mother" } })).id;
    adultId = (await mkPatient(db, clerk.actor)).id;
    ctl = new OpdQueueController(db, testCfg as never);
  });

  async function inConsult(patientId: string, departmentId: string, doctor: typeof drp, vitals: Record<string, number>, at: Date = MON): Promise<string> {
    const opened = await openVisit(db, clerk.actor, { patientId, departmentId, doctorId: doctor.doctorId }, at);
    await recordVitals(db, vd.actor, opened.encounter.id, vitals, at);
    await callNext(db, doctor.actor, opened.sessionId, at);
    await startConsultation(db, doctor.actor, opened.encounter.id, at);
    return opened.encounter.id;
  }

  it("a paediatric visit names the six Child sections, versioned; the read carries age in Y-M-D, growth from today's vitals, and the IAP timetable", async () => {
    const enc = await inConsult(childId, pedDeptId, drp, toddler);
    const s = await visitSections(db, drp.actor, enc, MON);
    expect(s.profile).toBe("paediatrics");
    expect(s.sections.map((x) => [x.key, x.version])).toEqual([
      ["paeds.informant", 1], ["paeds.growth", 1], ["paeds.immunisation", 1], ["paeds.birth", 1], ["paeds.milestones", 1], ["paeds.feeding", 1],
    ]);
    const p = s.paeds!;
    expect(p.age).toEqual({ years: 1, months: 3, days: 13, totalDays: 470 });
    expect(p.sex).toBe("girl");
    expect(p.weight).toMatchObject({ kg: 9.6, today: true });
    expect(p.lengthSource).toBe("vitals");
    const wfa = p.growth.find((g) => g.key === "wfa")!;
    expect(wfa).toMatchObject({ reference: "WHO 2006", z: whoZ("wfa", "girl", 470, 9.6)!.z });
    // 15 months was 2026-09-15: MMR-2 is due and not yet overdue; the 9-month MMR-1 is overdue.
    const dose = (id: string) => p.immunisation!.doses.find((d) => d.id === id)!;
    expect(dose("mmr-2")).toMatchObject({ status: "due", dueOn: "2026-09-15" });
    expect(dose("mmr-1").status).toBe("overdue");
    expect(p.immunisation!.source).toMatch(/IAP/);
  });

  it("a length measured on the Child tab is charted over the vitals height, and needs to say how it was measured", async () => {
    const enc = await inConsult(childId, pedDeptId, drp, toddler);
    await expect(saveVisitSection(db, drp.actor, enc, "paeds.growth", { body: { lengthCm: 77.2 } }, MON)).rejects.toMatchObject({ code: "invalid_section_body" });
    await saveVisitSection(db, drp.actor, enc, "paeds.growth", { body: { lengthCm: 77.2, measure: "length", headCircCm: 45.5 } }, MON);
    const p = (await visitSections(db, drp.actor, enc, MON)).paeds!;
    expect(p.lengthSource).toBe("section");
    expect(p.growth.find((g) => g.key === "lhfa")).toMatchObject({ value: 77.2, z: whoZ("lhfa", "girl", 470, 77.2, "length")!.z });
    expect(p.growth.find((g) => g.key === "hcfa")!.z).toBe(whoZ("hcfa", "girl", 470, 45.5)!.z);
  });

  it("a vaccine given today is recorded with its batch and site, and cannot be taken off — only marked in error with a reason", async () => {
    const enc = await inConsult(childId, pedDeptId, drp, toddler);
    await expect(saveVisitSection(db, drp.actor, enc, "paeds.immunisation", { body: { givenToday: [{ dose: "mmr-2", site: "right_upper_arm" }] } }, MON))
      .rejects.toMatchObject({ code: "invalid_section_body" }); // no batch
    const first = await saveVisitSection(db, drp.actor, enc, "paeds.immunisation", {
      body: { givenToday: [{ dose: "mmr-2", batch: "MMR2231A", site: "right_upper_arm" }], earlier: [{ dose: "bcg", on: "2025-06-16", where: "Govt hospital" }] },
    }, MON);
    const saved = (first.body as { givenToday: { id: string }[] }).givenToday[0]!;
    expect(saved.id).toBeTruthy();
    await expect(saveVisitSection(db, drp.actor, enc, "paeds.immunisation", { body: { givenToday: [] } }, LATER)).rejects.toThrow(/cannot be removed/);
    const p = (await visitSections(db, drp.actor, enc, LATER)).paeds!;
    expect(p.immunisation!.doses.find((d) => d.id === "mmr-2")).toMatchObject({ status: "given_today", givenOn: "2026-09-28" });
    expect(p.immunisation!.doses.find((d) => d.id === "bcg")).toMatchObject({ status: "given", givenWhere: "earlier", givenOn: "2025-06-16" });
    // The rows stay append-only underneath: one row, then the error mark is a second that supersedes it.
    await saveVisitSection(db, drp.actor, enc, "paeds.immunisation", {
      body: { givenToday: [{ ...saved, dose: "mmr-2", batch: "MMR2231A", site: "right_upper_arm", errorReason: "given to the sibling" }], earlier: [{ dose: "bcg", on: "2025-06-16", where: "Govt hospital" }] },
    }, LATER);
    const rows = await db.select().from(opdSectionRecords).where(and(eq(opdSectionRecords.encounterId, enc), eq(opdSectionRecords.sectionKey, "paeds.immunisation")));
    expect(rows).toHaveLength(2);
    const after = (await visitSections(db, drp.actor, enc, LATER)).paeds!;
    expect(after.immunisation!.doses.find((d) => d.id === "mmr-2")!.status).toBe("due"); // an entry in error is not a dose given
  });

  it("a dose given on one visit is 'given here' on the child's next visit, and cannot be given twice", async () => {
    const first = await inConsult(childId, pedDeptId, drp, toddler);
    await saveVisitSection(db, drp.actor, first, "paeds.immunisation", { body: { givenToday: [{ dose: "var-1", batch: "VZ88", site: "left_thigh" }] } }, MON);
    const next = await inConsult(childId, pedDeptId, drq, toddler, LATER);
    const p = (await visitSections(db, drq.actor, next, LATER)).paeds!;
    expect(p.immunisation!.doses.find((d) => d.id === "var-1")).toMatchObject({ status: "given", givenWhere: "here", givenOn: "2026-09-28" });
    await expect(saveVisitSection(db, drq.actor, next, "paeds.immunisation", { body: { givenToday: [{ dose: "var-1", batch: "VZ89", site: "left_thigh" }] } }, LATER))
      .rejects.toThrow(/already given/);
  });

  it("the history sections take the informant, birth, milestones and feeding — and refuse what is not a measurement", async () => {
    const enc = await inConsult(childId, pedDeptId, drp, toddler);
    await saveVisitSection(db, drp.actor, enc, "paeds.informant", { body: { relation: "mother", name: "Sunita" } }, MON);
    await saveVisitSection(db, drp.actor, enc, "paeds.birth", { body: { gestationWeeks: 36, birthWeightKg: 2.2, delivery: "lscs_emergency", nicu: "yes", nicuDays: 5 } }, MON);
    await saveVisitSection(db, drp.actor, enc, "paeds.milestones", { body: { language: { status: "delayed", note: "no words yet" } } }, MON);
    await saveVisitSection(db, drp.actor, enc, "paeds.feeding", { body: { mode: "complementary_with_breast", complementaryFromMonths: 6 } }, MON);
    await expect(saveVisitSection(db, drp.actor, enc, "paeds.birth", { body: { gestationWeeks: 60 } }, MON)).rejects.toMatchObject({ code: "invalid_section_body" });
    await expect(saveVisitSection(db, drp.actor, enc, "paeds.informant", { body: { relation: "neighbour" } }, MON)).rejects.toMatchObject({ code: "invalid_section_body" });
    const s = await visitSections(db, drp.actor, enc, MON);
    expect(s.records["paeds.milestones"]!.body).toMatchObject({ language: { status: "delayed" }, grossMotor: { status: null } });
    expect(s.records["paeds.informant"]!.body).toMatchObject({ relation: "mother", name: "Sunita" });
  });

  it("a general-medicine visit has no Child sections and no paediatric read; a Child section cannot be written on it", async () => {
    const med = await inConsult(adultId, medDeptId, drm, adultOk);
    const s = await ctl.sections(drm.actor, med);
    expect(s).toEqual({ profile: null, sections: [], records: {} });
    expect("paeds" in s).toBe(false);
    await expect(saveVisitSection(db, drm.actor, med, "paeds.growth", { body: { headCircCm: 45 } }, MON)).rejects.toMatchObject({ code: "section_not_in_profile" });
  });

  it("the paediatric consult's layout has a Child tab; general medicine's does not", async () => {
    const enc = await inConsult(childId, pedDeptId, drp, toddler);
    expect((await visitLayout(db, drp.actor, enc)).sections.map((x) => x.key)).toContain("paeds");
    const med = await inConsult(adultId, medDeptId, drm, adultOk);
    expect((await visitLayout(db, drm.actor, med)).sections.map((x) => x.key)).not.toContain("paeds");
  });
});
