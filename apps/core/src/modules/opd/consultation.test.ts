import { and, eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { activateOpdVisitDefinition, mkDoctor, mkPatient, mkUser, seedOpdBase, seedOpdMasters } from "../../../test/helpers/opd";
import { events, opdConfig, opdQueueEntries, workflowInstances } from "../../kernel/db/schema";
import { completeConsultation, saveConsultNote, startConsultation } from "./consultation";
import { getEncounter, openVisit, reEnterVisit, transferQueue } from "./encounters";
import { callNext } from "./queue";
import { recordVitals } from "./vitals";
import type { EncounterRow } from "./encounters";
import type { Db } from "../../kernel/db/client";

/** Monday 2026-08-17, 09:30 IST — every doctor's default template covers Mon–Sat 09:00–13:00. */
const MON = new Date("2026-08-17T04:00:00.000Z");
const MON2 = new Date(MON.getTime() + 20 * 60_000);
/** Tuesday 2026-09-01, 10:30 IST — the NEXT IST month, for the extension cap's reset. */
const SEP = new Date("2026-09-01T05:00:00.000Z");
const adultOk = { heightCm: 165, weightKg: 60, sbp: 120, dbp: 80, pulse: 72, spo2: 98, tempC: 37.0 };

describe("opd consultation (start / note / complete, the follow-up window and the outcomes)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let clerk: Awaited<ReturnType<typeof mkUser>>;
  let sup: Awaited<ReturnType<typeof mkUser>>;
  let vd: Awaited<ReturnType<typeof mkUser>>;
  let dra: Awaited<ReturnType<typeof mkDoctor>>;
  let drb: Awaited<ReturnType<typeof mkDoctor>>;
  let deptId: string;
  let roomId: string;
  let room2Id: string;
  let patient: { id: string; uhid: string };

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    await seedOpdBase(db);
    await activateOpdVisitDefinition(db);
    ({ deptId, roomId, room2Id } = await seedOpdMasters(db));
    dra = await mkDoctor(db, { username: "dra", departmentId: deptId, roomId });
    drb = await mkDoctor(db, { username: "drb", departmentId: deptId, roomId: room2Id });
    clerk = await mkUser(db, "clerk", ["front_office"]);
    sup = await mkUser(db, "sup", ["front_office_supervisor"]);
    vd = await mkUser(db, "vd", ["vitals_desk"]);
    patient = await mkPatient(db, clerk.actor);
  });

  /** open → vitals (registered→waiting) → call → start, the production path the desk actually walks. */
  async function inConsult(doc: Awaited<ReturnType<typeof mkDoctor>>, at: Date = MON): Promise<EncounterRow> {
    const opened = await openVisit(db, clerk.actor, { patientId: patient.id, departmentId: deptId, doctorId: doc.doctorId }, at);
    await recordVitals(db, vd.actor, opened.encounter.id, adultOk, at);
    await callNext(db, doc.actor, opened.sessionId, at);
    return (await startConsultation(db, doc.actor, opened.encounter.id, at)).encounter;
  }

  const eventsNamed = (name: string): Promise<{ payload: unknown; encounterId: string | null; patientId: string | null; correlationId: string | null }[]> =>
    db.select({ payload: events.payload, encounterId: events.encounterId, patientId: events.patientId, correlationId: events.correlationId })
      .from(events).where(eq(events.name, name));

  it("start: waiting → in_consultation with the queue entry and one consultation.started; registered, a non-doctor and another doctor refuse", async () => {
    const opened = await openVisit(db, clerk.actor, { patientId: patient.id, departmentId: deptId, doctorId: dra.doctorId }, MON);
    await expect(startConsultation(db, dra.actor, opened.encounter.id, MON)).rejects.toMatchObject({ code: "encounter_state_conflict" });

    await recordVitals(db, vd.actor, opened.encounter.id, adultOk, MON);
    await expect(startConsultation(db, clerk.actor, opened.encounter.id, MON)).rejects.toMatchObject({ code: "not_a_doctor" });
    await expect(startConsultation(db, drb.actor, opened.encounter.id, MON)).rejects.toMatchObject({ code: "not_your_patient" });

    const r = await startConsultation(db, dra.actor, opened.encounter.id, MON); // never called: the doctor took them straight from waiting
    expect(r.encounter.status).toBe("in_consultation");
    expect(r.encounter.consultStartedAt).toEqual(MON);
    expect(r.queueEntry.status).toBe("in_consult");

    const started = await eventsNamed("consultation.started");
    expect(started).toHaveLength(1);
    expect(started[0]!.encounterId).toBe(opened.encounter.id);
    expect(started[0]!.patientId).toBe(patient.id);
    expect(started[0]!.correlationId).toBe(opened.encounter.workflowInstanceId);
    expect(started[0]!.payload).toEqual({
      encounterId: opened.encounter.id, patientId: patient.id, departmentId: deptId, doctorId: dra.doctorId,
      serviceDate: "2026-08-17", sessionId: opened.sessionId, roomId, tokenNo: 1,
    });
  });

  it("the note is saved without a state change and without an event; a waiting encounter refuses", async () => {
    const enc = await inConsult(dra);
    const before = (await db.select({ payload: events.payload }).from(events)).length;
    const saved = await saveConsultNote(db, dra.actor, enc.id, {
      chiefComplaint: "fever 3d", diagnosis: "Acute pharyngitis", icd10Code: "J02.9", advice: "fluids", admissionAdvised: false,
    });
    expect(saved.encounter).toMatchObject({
      status: "in_consultation", chiefComplaint: "fever 3d", diagnosis: "Acute pharyngitis", icd10Code: "J02.9",
      advice: "fluids", admissionAdvised: false,
    });
    expect((await db.select({ payload: events.payload }).from(events)).length).toBe(before);

    const other = await openVisit(db, clerk.actor, { patientId: patient.id, departmentId: deptId, doctorId: dra.doctorId }, MON);
    await recordVitals(db, vd.actor, other.encounter.id, adultOk, MON);
    await expect(saveConsultNote(db, dra.actor, other.encounter.id, { advice: "fluids" }))
      .rejects.toMatchObject({ code: "encounter_state_conflict" });
  });

  it("completing with the default window closes the encounter, the entry and the instance and events exactly once", async () => {
    const enc = await inConsult(dra);
    const r = await completeConsultation(
      db, dra.actor, enc.id, { note: { diagnosis: "Acute pharyngitis", icd10Code: "J02.9" }, testsOrderedReturnToday: false }, MON2,
    );
    expect(r.encounter).toMatchObject({ status: "completed", followUpDays: 7, followUpExtended: false, icd10Code: "J02.9" });
    expect(r.encounter.consultCompletedAt).toEqual(MON2);

    const entries = await db.select().from(opdQueueEntries).where(eq(opdQueueEntries.encounterId, enc.id));
    expect(entries.map((e) => e.status)).toEqual(["done"]);
    expect(entries[0]!.doneAt).toEqual(MON2);

    const inst = (await db.select().from(workflowInstances).where(eq(workflowInstances.id, enc.workflowInstanceId)))[0]!;
    expect(inst.status).toBe("completed");
    expect(inst.currentState).toBe("completed");

    const completed = await eventsNamed("consultation.completed");
    expect(completed).toHaveLength(1);
    expect(completed[0]!.correlationId).toBe(enc.workflowInstanceId);
    expect(completed[0]!.payload).toMatchObject({
      visitType: "new", followUpDays: 7, followUpExtended: false, admissionAdvised: false,
      referralIssued: false, prescriptionCount: 0, icd10Code: "J02.9",
    });
    expect(await eventsNamed("admission.requested")).toHaveLength(0);
    expect(await eventsNamed("referral.issued")).toHaveLength(0);

    await expect(completeConsultation(db, dra.actor, enc.id, { testsOrderedReturnToday: false }, MON2))
      .rejects.toMatchObject({ code: "encounter_state_conflict" });
  });

  it("the follow-up extension: only configured values, evented, and capped per doctor per IST month", async () => {
    await db.update(opdConfig).set({ extensionCapPerDoctorPerMonth: 2 }).where(eq(opdConfig.id, "main"));
    const e1 = await inConsult(dra);
    const e2 = await inConsult(dra);
    const e3 = await inConsult(dra);

    const r1 = await completeConsultation(db, dra.actor, e1.id, { testsOrderedReturnToday: false, followUpDays: 21 }, MON2);
    expect(r1.encounter).toMatchObject({ status: "completed", followUpDays: 21, followUpExtended: true });
    const first = await eventsNamed("consultation.completed");
    expect(first).toHaveLength(1);
    expect(first[0]!.payload).toMatchObject({ followUpDays: 21, followUpExtended: true });

    // 10 is not one of the configured [15, 21, 30] values — refused with nothing moved.
    await expect(completeConsultation(db, dra.actor, e2.id, { testsOrderedReturnToday: false, followUpDays: 10 }, MON2))
      .rejects.toMatchObject({ code: "invalid_follow_up_days" });
    expect((await getEncounter(db, e2.id))!.status).toBe("in_consultation");
    expect((await getEncounter(db, e2.id))!.followUpDays).toBeNull();

    expect((await completeConsultation(db, dra.actor, e2.id, { testsOrderedReturnToday: false, followUpDays: 30 }, MON2)).encounter)
      .toMatchObject({ status: "completed", followUpDays: 30, followUpExtended: true });

    // Two extensions already this IST month for THIS doctor: the third is refused and nothing moves.
    await expect(completeConsultation(db, dra.actor, e3.id, { testsOrderedReturnToday: false, followUpDays: 15 }, MON2))
      .rejects.toMatchObject({ code: "extension_cap_reached" });
    expect((await getEncounter(db, e3.id))!.status).toBe("in_consultation");

    // The DEFAULT window is never an extension, so it still completes.
    expect((await completeConsultation(db, dra.actor, e3.id, { testsOrderedReturnToday: false, followUpDays: 7 }, MON2)).encounter)
      .toMatchObject({ status: "completed", followUpDays: 7, followUpExtended: false });

    // The cap is per DOCTOR: drb has spent none of theirs.
    const other = await inConsult(drb);
    expect((await completeConsultation(db, drb.actor, other.id, { testsOrderedReturnToday: false, followUpDays: 15 }, MON2)).encounter)
      .toMatchObject({ status: "completed", followUpDays: 15, followUpExtended: true });

    // …and per IST MONTH: dra's September extension is a fresh count.
    const september = await inConsult(dra, SEP);
    expect((await completeConsultation(db, dra.actor, september.id, { testsOrderedReturnToday: false, followUpDays: 15 }, SEP)).encounter)
      .toMatchObject({ status: "completed", followUpDays: 15, followUpExtended: true });
  });

  it("outcomes: an admission advice and a referral each event once alongside the completion", async () => {
    const enc = await inConsult(dra);
    await saveConsultNote(db, dra.actor, enc.id, {
      diagnosis: "Unstable angina", admissionAdvised: true, referralTo: "AIIMS Patna", referralNote: "cardiac eval",
    });
    await completeConsultation(db, dra.actor, enc.id, { testsOrderedReturnToday: false }, MON2);

    const admissions = await eventsNamed("admission.requested");
    expect(admissions).toHaveLength(1);
    expect(admissions[0]!.encounterId).toBe(enc.id);
    expect(admissions[0]!.payload).toEqual({
      encounterId: enc.id, patientId: patient.id, doctorId: dra.doctorId, departmentId: deptId, note: null,
    });
    const referrals = await eventsNamed("referral.issued");
    expect(referrals).toHaveLength(1);
    expect(referrals[0]!.payload).toEqual({
      encounterId: enc.id, patientId: patient.id, doctorId: dra.doctorId, referralTo: "AIIMS Patna", note: "cardiac eval",
    });
    expect((await eventsNamed("consultation.completed"))[0]!.payload)
      .toMatchObject({ admissionAdvised: true, referralIssued: true });
  });

  it("tests ordered, return today: awaiting_results with no completion event, then the re-entry consult completes exactly once", async () => {
    const enc = await inConsult(dra);
    const held = await completeConsultation(db, dra.actor, enc.id, { testsOrderedReturnToday: true }, MON2);
    expect(held.encounter.status).toBe("awaiting_results");
    expect(held.encounter.consultCompletedAt).toBeNull();
    expect((await db.select().from(opdQueueEntries).where(eq(opdQueueEntries.encounterId, enc.id))).map((e) => e.status)).toEqual(["done"]);
    expect(await eventsNamed("consultation.completed")).toHaveLength(0);

    const MON3 = new Date(MON.getTime() + 40 * 60_000);
    const re = await reEnterVisit(db, clerk.actor, enc.id, MON3);
    expect(re.encounter.status).toBe("waiting");
    expect(re.queueEntry.reEntry).toBe(true);

    const MON4 = new Date(MON.getTime() + 60 * 60_000);
    expect((await startConsultation(db, dra.actor, enc.id, MON4)).encounter.status).toBe("in_consultation");
    expect(await eventsNamed("consultation.started")).toHaveLength(2);

    const MON5 = new Date(MON.getTime() + 80 * 60_000);
    expect((await completeConsultation(db, dra.actor, enc.id, { testsOrderedReturnToday: false }, MON5)).encounter.status).toBe("completed");
    expect(await eventsNamed("consultation.completed")).toHaveLength(1);

    // A completed consult now exists inside the window, so a fresh visit LATER THE SAME IST DAY is a revisit.
    const later = await openVisit(
      db, clerk.actor, { patientId: patient.id, departmentId: deptId, doctorId: dra.doctorId }, new Date(MON.getTime() + 6 * 3_600_000),
    );
    expect(later.visitType).toBe("revisit");
  });

  it("only the treating doctor: after an E2 transfer the previous doctor is refused and the new one starts", async () => {
    const opened = await openVisit(db, clerk.actor, { patientId: patient.id, departmentId: deptId, doctorId: dra.doctorId }, MON);
    await recordVitals(db, vd.actor, opened.encounter.id, adultOk, MON);
    const out = await transferQueue(db, sup.actor, {
      fromDoctorId: dra.doctorId, toDoctorId: drb.doctorId, serviceDate: "2026-08-17", consented: true, reason: "Dr A called away",
    }, MON);
    expect(out.transferred).toBe(1);

    await expect(startConsultation(db, dra.actor, opened.encounter.id, MON)).rejects.toMatchObject({ code: "not_your_patient" });
    const r = await startConsultation(db, drb.actor, opened.encounter.id, MON);
    expect(r.encounter.status).toBe("in_consultation");
    expect(r.queueEntry.sessionId).toBe(out.toSessionId);
  });

  it("two concurrent completions: one winner, ONE mapped loser code, one event and one done entry", async () => {
    const enc = await inConsult(dra);
    const settled = await Promise.allSettled([
      completeConsultation(db, dra.actor, enc.id, { testsOrderedReturnToday: false }, MON2),
      completeConsultation(db, dra.actor, enc.id, { testsOrderedReturnToday: false }, MON2),
    ]);
    const fulfilled = settled.filter((s) => s.status === "fulfilled");
    const rejected = settled.filter((s) => s.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: "encounter_state_conflict" });

    expect((await getEncounter(db, enc.id))!.status).toBe("completed");
    const completed = await db.select({ id: events.eventId }).from(events)
      .where(and(eq(events.name, "consultation.completed"), eq(events.encounterId, enc.id)));
    expect(completed).toHaveLength(1);
    const done = await db.select().from(opdQueueEntries)
      .where(and(eq(opdQueueEntries.encounterId, enc.id), eq(opdQueueEntries.status, "done")));
    expect(done).toHaveLength(1);
  });
});
