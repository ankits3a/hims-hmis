import { and, eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import {
  activateOpdVisitDefinition, mkDoctor, mkPatient, mkUser, seedOpdBase, seedOpdMasters, testCfg,
} from "../../../test/helpers/opd";
import { opdDepartments, opdSectionRecords, phiAccessLog } from "../../kernel/db/schema";
import { openVisit } from "./encounters";
import { recordVitals } from "./vitals";
import { callNext } from "./queue";
import { startConsultation } from "./consultation";
import { OpdQueueController } from "./opd-queue.controller";
import { saveVisitSection, visitSections } from "./sections";
import type { Db } from "../../kernel/db/client";

/**
 * CONSULT ENGINE, FIRST SLICE (01-CONSULT-ENGINE.md §3, §6.1; D19) — the ophthalmology department's
 * consult gains four sections; every other department's consult is unchanged. The record is
 * append-only and versioned (D1, D7).
 */
const MON = new Date("2026-08-17T04:00:00.000Z");
const LATER = new Date("2026-08-17T04:10:00.000Z");
const adultOk = { heightCm: 172, weightKg: 70, sbp: 118, dbp: 76, pulse: 70, rr: 15, spo2: 99, tempC: 36.6 };

describe("consult engine — the ophthalmology sections", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let clerk: Awaited<ReturnType<typeof mkUser>>;
  let vd: Awaited<ReturnType<typeof mkUser>>;
  let dre: Awaited<ReturnType<typeof mkDoctor>>; // the eye doctor
  let drm: Awaited<ReturnType<typeof mkDoctor>>; // general medicine
  let eyeDeptId: string;
  let medDeptId: string;
  let patientId: string;
  let ctl: OpdQueueController;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());

  beforeEach(async () => {
    await truncateAll(db);
    await seedOpdBase(db);
    await activateOpdVisitDefinition(db);
    const m = await seedOpdMasters(db);
    medDeptId = m.deptId;
    eyeDeptId = m.dept2Id;
    // The fixture's second department becomes the eye OPD: the profile is chosen by department CODE.
    await db.update(opdDepartments).set({ code: "OPH", name: "Ophthalmology" }).where(eq(opdDepartments.id, eyeDeptId));
    drm = await mkDoctor(db, { username: "drm", departmentId: medDeptId, roomId: m.roomId });
    dre = await mkDoctor(db, { username: "dre", departmentId: eyeDeptId, roomId: m.room2Id });
    clerk = await mkUser(db, "clerk1", ["front_office_t"]);
    vd = await mkUser(db, "vitals1", ["vitals_desk"]);
    patientId = (await mkPatient(db, clerk.actor)).id;
    ctl = new OpdQueueController(db, testCfg as never);
  });

  async function inConsult(departmentId: string, doctor: typeof dre): Promise<string> {
    const opened = await openVisit(db, clerk.actor, { patientId, departmentId, doctorId: doctor.doctorId }, MON);
    await recordVitals(db, vd.actor, opened.encounter.id, adultOk, MON);
    await callNext(db, doctor.actor, opened.sessionId, MON);
    await startConsultation(db, doctor.actor, opened.encounter.id, MON);
    return opened.encounter.id;
  }

  it("an eye visit's consult names the four eye sections, versioned; a general-medicine visit names none", async () => {
    const eye = await inConsult(eyeDeptId, dre);
    const s = await ctl.sections(dre.actor, eye);
    expect(s.profile).toBe("ophthalmology");
    expect(s.sections).toEqual([
      { key: "eye.vision", version: 1, kind: "eye-grid" }, { key: "eye.iop", version: 1, kind: "eye-grid" },
      { key: "eye.slit_lamp", version: 1, kind: "eye-grid" }, { key: "eye.glasses_rx", version: 1, kind: "lens-grid" },
    ]);
    expect(s.records).toEqual({});
    const med = await inConsult(medDeptId, drm);
    expect(await ctl.sections(drm.actor, med)).toEqual({ profile: null, sections: [], records: {} });
  });

  it("a save is a new row that supersedes the last one; the read returns only the current, with its author and version", async () => {
    const eye = await inConsult(eyeDeptId, dre);
    const first = await saveVisitSection(db, dre.actor, eye, "eye.vision", { body: { vaUnaided: { od: "6/36", os: "6/9" } } }, MON);
    const second = await saveVisitSection(db, dre.actor, eye, "eye.vision", { body: { vaUnaided: { od: "6/36", os: "6/9" }, vaPinhole: { od: "6/24", os: "6/6" } } }, LATER);
    const rows = await db.select().from(opdSectionRecords).where(and(eq(opdSectionRecords.encounterId, eye), eq(opdSectionRecords.sectionKey, "eye.vision")));
    expect(rows).toHaveLength(2); // append-only: the first row is still there
    expect(rows.find((r) => r.id === second.recordId)!.supersedesId).toBe(first.recordId);
    const s = await visitSections(db, dre.actor, eye);
    expect(s.records["eye.vision"]).toMatchObject({ recordId: second.recordId, sectionVersion: 1, authorId: dre.actor.id });
    // Rows the doctor did not fill come back as empty pairs, so every reader sees one shape.
    expect(s.records["eye.vision"]!.body).toMatchObject({ vaPinhole: { od: "6/24", os: "6/6" }, near: { od: "", os: "" } });
  });

  it("the glasses prescription refuses what a trial set cannot hold: a sixth of a dioptre, and a cylinder with no axis", async () => {
    const eye = await inConsult(eyeDeptId, dre);
    await expect(saveVisitSection(db, dre.actor, eye, "eye.glasses_rx", { body: { od: { sph: -1.1 } } }, MON)).rejects.toMatchObject({ code: "invalid_section_body" });
    await expect(saveVisitSection(db, dre.actor, eye, "eye.glasses_rx", { body: { od: { sph: -1, cyl: -0.75 } } }, MON)).rejects.toMatchObject({ code: "invalid_section_body" });
    const ok = await saveVisitSection(db, dre.actor, eye, "eye.glasses_rx", { body: { od: { sph: -1, cyl: -0.75, axis: 90, add: 2.5 }, os: { sph: -0.5 }, use: "bifocal" } }, MON);
    expect(ok.body).toMatchObject({ od: { sph: -1, cyl: -0.75, axis: 90, add: 2.5 }, os: { sph: -0.5, cyl: null, axis: null, add: null }, use: "bifocal" });
  });

  it("an eye section cannot be written on a general-medicine visit, by another doctor, outside the consultation, or from a tab without the lease", async () => {
    const med = await inConsult(medDeptId, drm);
    await expect(saveVisitSection(db, drm.actor, med, "eye.iop", { body: { od: 18 } }, MON)).rejects.toMatchObject({ code: "section_not_in_profile" });
    const waiting = await openVisit(db, clerk.actor, { patientId, departmentId: eyeDeptId, doctorId: dre.doctorId }, MON);
    await expect(saveVisitSection(db, dre.actor, waiting.encounter.id, "eye.iop", { body: { od: 18 } }, MON)).rejects.toMatchObject({ code: "encounter_state_conflict" });
    const eye = await inConsult(eyeDeptId, dre);
    await expect(saveVisitSection(db, drm.actor, eye, "eye.iop", { body: { od: 18 } }, MON)).rejects.toThrow();
    await expect(saveVisitSection(db, dre.actor, eye, "eye.unknown", { body: {} }, MON)).rejects.toMatchObject({ code: "section_not_in_profile" });
    expect((await ctl.lease(dre.actor, eye, { token: "tab-aaaa-1111" })).held).toBe(true);
    await expect(saveVisitSection(db, dre.actor, eye, "eye.iop", { body: { od: 18 }, leaseToken: "tab-bbbb-2222" }, new Date())).rejects.toThrow(/another tab/);
  });

  it("two first saves cannot both become current: the second is refused as a conflict", async () => {
    const eye = await inConsult(eyeDeptId, dre);
    await saveVisitSection(db, dre.actor, eye, "eye.iop", { body: { method: "NCT", od: 18, os: 16 } }, MON);
    // Simulate the lost race: a second ROOT for the same section, as a concurrent first save would write.
    await expect(db.insert(opdSectionRecords).values({
      id: "race-root", encounterId: eye, patientId, sectionKey: "eye.iop", sectionVersion: 1, body: {}, authorId: dre.actor.id, at: MON,
    })).rejects.toThrow();
  });

  it("the read is PHI-logged under opd.sections", async () => {
    const eye = await inConsult(eyeDeptId, dre);
    await visitSections(db, dre.actor, eye);
    const rows = await db.select().from(phiAccessLog).where(and(eq(phiAccessLog.surface, "opd.sections"), eq(phiAccessLog.encounterId, eye)));
    expect(rows).toHaveLength(1);
  });
});
