import { HttpException } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import {
  activateOpdVisitDefinition, mkDoctor, mkPatient, mkUser, seedOpdBase, seedOpdMasters, testCfg,
} from "../../../test/helpers/opd";
import { opdDepartments, opdEncounters, printJobs } from "../../kernel/db/schema";
import { renderDocument } from "../../kernel/printing/render";
import { openVisit } from "./encounters";
import { recordVitals } from "./vitals";
import { callNext } from "./queue";
import { startConsultation } from "./consultation";
import { OpdQueueController } from "./opd-queue.controller";
import { saveVisitSection } from "./sections";
import { printGlassesRx, registerOpdGlassesPrinting } from "./glasses-print";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ THE GLASSES PRESCRIPTION, ITS OWN PRINT (board `Ophthal`: "GLASSES PRESCRIPTION · ITS OWN PRINT") ═══
 *
 * The doctor presses "Print glasses Rx"; one A4 job goes to the front desk's laser for the VERSION
 * of the section on record, and the relay's claim renders it from that exact row. These pin the
 * producer's guards and what the sheet says.
 */
const MON = new Date("2026-08-17T04:00:00.000Z");
const LATER = new Date("2026-08-17T04:10:00.000Z");
const adultOk = { heightCm: 172, weightKg: 70, sbp: 118, dbp: 76, pulse: 70, rr: 15, spo2: 99, tempC: 36.6 };

describe("the glasses prescription — its own print", () => {
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
  let unregister: () => void;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); unregister = registerOpdGlassesPrinting(); });
  afterAll(async () => { unregister(); await teardown(); });

  beforeEach(async () => {
    await truncateAll(db);
    await seedOpdBase(db);
    await activateOpdVisitDefinition(db);
    const m = await seedOpdMasters(db);
    medDeptId = m.deptId;
    eyeDeptId = m.dept2Id;
    await db.update(opdDepartments).set({ code: "OPH", name: "Ophthalmology" }).where(eq(opdDepartments.id, eyeDeptId));
    drm = await mkDoctor(db, { username: "drm", departmentId: medDeptId, roomId: m.roomId });
    dre = await mkDoctor(db, { username: "dre", departmentId: eyeDeptId, roomId: m.room2Id, displayName: "Dr Meera Iyer" });
    clerk = await mkUser(db, "clerk1", ["front_office_t"]);
    vd = await mkUser(db, "vitals1", ["vitals_desk"]);
    patientId = (await mkPatient(db, clerk.actor, { name: "Suresh Kumar", sex: "male", ageYears: 52 })).id;
    ctl = new OpdQueueController(db, testCfg as never);
  });

  async function inConsult(departmentId: string, doctor: typeof dre): Promise<string> {
    const opened = await openVisit(db, clerk.actor, { patientId, departmentId, doctorId: doctor.doctorId }, MON);
    await recordVitals(db, vd.actor, opened.encounter.id, adultOk, MON);
    await callNext(db, doctor.actor, opened.sessionId, MON);
    await startConsultation(db, doctor.actor, opened.encounter.id, MON);
    return opened.encounter.id;
  }

  const glassesJobs = async (encounterId: string) =>
    (await db.select().from(printJobs).where(eq(printJobs.encounterId, encounterId))).filter((j) => j.document === "opd_glasses_rx");

  it("the treating doctor queues ONE A4 job per version; a second press says it is already coming", async () => {
    const eye = await inConsult(eyeDeptId, dre);
    const rec = await saveVisitSection(db, dre.actor, eye, "eye.glasses_rx", { body: { od: { sph: -1.25 }, os: { sph: -1 } } }, MON);
    expect(await ctl.printGlassesRx(dre.actor, eye)).toEqual({ queued: true });
    expect(await ctl.printGlassesRx(dre.actor, eye)).toEqual({ queued: false });
    const jobs = await glassesJobs(eye);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      destination: "front_desk_a4", dedupeKey: `glasses:${rec.recordId}`, requestedBy: dre.actor.id, patientId,
    });
    // Identifiers only — the version travels, so a reprint prints the row that was queued.
    expect(jobs[0]!.params).toEqual({ encounterId: eye, recordId: rec.recordId });
  });

  it("an edit is a new version, and the new version queues again", async () => {
    const eye = await inConsult(eyeDeptId, dre);
    await saveVisitSection(db, dre.actor, eye, "eye.glasses_rx", { body: { od: { sph: -1.25 } } }, MON);
    await printGlassesRx(db, dre.actor, eye);
    const second = await saveVisitSection(db, dre.actor, eye, "eye.glasses_rx", { body: { od: { sph: -1.5 } } }, LATER);
    expect(await printGlassesRx(db, dre.actor, eye)).toEqual({ queued: true });
    const jobs = await glassesJobs(eye);
    expect(jobs).toHaveLength(2);
    expect(jobs.map((j) => j.dedupeKey)).toContain(`glasses:${second.recordId}`);
  });

  it("another doctor is refused, and so is a general-medicine visit", async () => {
    const eye = await inConsult(eyeDeptId, dre);
    await saveVisitSection(db, dre.actor, eye, "eye.glasses_rx", { body: { od: { sph: -1.25 } } }, MON);
    await expect(printGlassesRx(db, drm.actor, eye)).rejects.toMatchObject({ code: "not_your_patient" });
    const med = await inConsult(medDeptId, drm);
    await expect(printGlassesRx(db, drm.actor, med)).rejects.toMatchObject({ code: "section_not_in_profile" });
    expect(await glassesJobs(eye)).toHaveLength(0);
  });

  it("an empty prescription is refused with glasses_rx_empty — nothing on record, or a record with no power — and the route says 400", async () => {
    const eye = await inConsult(eyeDeptId, dre);
    await expect(printGlassesRx(db, dre.actor, eye)).rejects.toMatchObject({ code: "glasses_rx_empty" });
    await saveVisitSection(db, dre.actor, eye, "eye.glasses_rx", { body: { use: "distance", note: "anti-glare" } }, MON);
    await expect(printGlassesRx(db, dre.actor, eye)).rejects.toMatchObject({ code: "glasses_rx_empty" });
    const refused = await ctl.printGlassesRx(dre.actor, eye).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(HttpException);
    expect((refused as HttpException).getStatus()).toBe(400);
    expect(await glassesJobs(eye)).toHaveLength(0);
  });

  it("prints after the visit is completed — the doctor's own paper is not a consultation act", async () => {
    const eye = await inConsult(eyeDeptId, dre);
    await saveVisitSection(db, dre.actor, eye, "eye.glasses_rx", { body: { os: { sph: 2.5 } } }, MON);
    await db.update(opdEncounters).set({ status: "completed" }).where(eq(opdEncounters.id, eye));
    expect(await printGlassesRx(db, dre.actor, eye)).toEqual({ queued: true });
  });

  it("the sheet: A4, the letterhead, the powers signed to two decimals, the axis in degrees, every value escaped, and the Doctor ID — never the doctor's name or council number", async () => {
    const eye = await inConsult(eyeDeptId, dre);
    const rec = await saveVisitSection(db, dre.actor, eye, "eye.glasses_rx", {
      body: { od: { sph: -1, cyl: -0.75, axis: 90, add: 2.5 }, os: { sph: 0, cyl: null, axis: null, add: 2.5 }, use: "bifocal", note: "<b>tint</b> & anti-glare" },
    }, MON);
    const doc = await renderDocument(db, "opd_glasses_rx", { encounterId: eye, recordId: rec.recordId }, MON, dre.actor);
    expect(doc).not.toBeNull();
    expect(doc!.page).toEqual({ widthMm: 210, heightMm: 297 });
    expect(doc!.html).toContain("@page { size: A4 portrait");
    expect(doc!.html).toContain("Spectacle prescription");
    expect(doc!.html).toContain("CRK Medical College &amp; Hospital");
    expect(doc!.html).toContain("data:image/png;base64,");
    expect(doc!.html).toContain("Suresh Kumar");
    expect(doc!.html).toContain("−1.00");
    expect(doc!.html).toContain("−0.75");
    expect(doc!.html).toContain("+2.50");
    expect(doc!.html).toContain("0.00");
    expect(doc!.html).toContain("90°");
    expect(doc!.html).toContain("Bifocal");
    expect(doc!.html).toContain("&lt;b&gt;tint&lt;/b&gt; &amp; anti-glare");
    expect(doc!.html).not.toContain("<b>tint</b>");
    // Owner ruling 2026-09-06: the Doctor ID prints; the doctor's name and council number do not.
    expect(doc!.html).toContain("Doctor ID");
    expect(doc!.html).not.toContain("BMC/12345");
    expect(doc!.html).not.toContain("Dr Meera Iyer");
    expect(doc!.title).toContain("Suresh Kumar");
    // The left eye has no cylinder: the cell is blank, never a zero the optician would grind.
    expect(doc!.html).toMatch(/data-cell="os-cyl"><\/td>/);
    expect(doc!.html).toMatch(/data-cell="os-axis"><\/td>/);
  });

  it("a reprint prints the version that was queued, not whatever is current now", async () => {
    const eye = await inConsult(eyeDeptId, dre);
    const first = await saveVisitSection(db, dre.actor, eye, "eye.glasses_rx", { body: { od: { sph: -1.25 } } }, MON);
    await saveVisitSection(db, dre.actor, eye, "eye.glasses_rx", { body: { od: { sph: -3 } } }, LATER);
    const doc = await renderDocument(db, "opd_glasses_rx", { encounterId: eye, recordId: first.recordId }, MON, dre.actor);
    expect(doc!.html).toContain("−1.25");
    expect(doc!.html).not.toContain("−3.00");
    // A record id that is not this visit's glasses row renders nothing rather than someone else's lenses.
    const other = await inConsult(medDeptId, drm);
    expect(await renderDocument(db, "opd_glasses_rx", { encounterId: other, recordId: first.recordId }, MON, dre.actor)).toBeNull();
    expect(await renderDocument(db, "opd_glasses_rx", { encounterId: eye }, MON, dre.actor)).not.toBeNull(); // no id: the current row
  });
});
