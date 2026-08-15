import { and, eq, isNull } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { activateOpdVisitDefinition, mkDoctor, mkPatient, mkUser, seedOpdBase, seedOpdMasters } from "../../../test/helpers/opd";
import { events, opdQueueEntries, opdVitals, workflowInstances, workflowTimers } from "../../kernel/db/schema";
import { abandonVisit, getEncounter, openVisit } from "./encounters";
import { recordVitals } from "./vitals";
import type { Db } from "../../kernel/db/client";

/** Monday 2026-08-17, 09:30 IST — the encounters.test.ts anchor. */
const MON = new Date("2026-08-17T04:00:00.000Z");
const adultOk = { heightCm: 165, weightKg: 60, sbp: 120, dbp: 80, pulse: 72, spo2: 98, tempC: 37.0 };

describe("opd vitals (recording, danger flags, the registered→waiting move)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let clerk: Awaited<ReturnType<typeof mkUser>>;
  let vd: Awaited<ReturnType<typeof mkUser>>;
  let dra: Awaited<ReturnType<typeof mkDoctor>>;
  let deptId: string;
  let roomId: string;
  let patient: { id: string; uhid: string };
  let childPatient: { id: string; uhid: string };

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
    patient = await mkPatient(db, clerk.actor);
    childPatient = await mkPatient(db, clerk.actor, { ageYears: 3, guardian: { name: "G", relationship: "mother" } });
  });

  it("normal recording moves registered → waiting", async () => {
    const opened = await openVisit(db, clerk.actor, { patientId: patient.id, departmentId: deptId, doctorId: dra.doctorId }, MON);
    const r = await recordVitals(db, vd.actor, opened.encounter.id, adultOk, MON);

    expect(r.flags).toEqual([]);
    expect(r.vitals.band).toBe("adult");
    expect(r.vitals.ageYearsAtRecord).toBe(30);
    expect(r.vitals.dangerFlags).toEqual([]);
    expect(r.vitals.recordedBy).toBe(vd.id);
    expect(r.encounter.status).toBe("waiting");
    expect(r.encounter.dangerFlagged).toBe(false);

    const entry = (await db.select().from(opdQueueEntries).where(eq(opdQueueEntries.encounterId, opened.encounter.id)))[0]!;
    expect(entry.status).toBe("waiting");
    expect(entry.eligibleAt).toEqual(MON);
    expect(entry.danger).toBe(false);

    const recorded = await db.select().from(events).where(eq(events.name, "vitals.recorded"));
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.payload).toMatchObject({
      encounterId: opened.encounter.id, vitalsId: r.vitals.id, band: "adult", dangerCount: 0, tokenNo: 1, serviceDate: "2026-08-17",
    });
    const flagged = await db.select().from(events).where(eq(events.name, "vitals.danger_flagged"));
    expect(flagged).toHaveLength(0);

    const inst = (await db.select().from(workflowInstances).where(eq(workflowInstances.id, r.encounter.workflowInstanceId)))[0]!;
    expect(inst.currentState).toBe("waiting");
    const timers = await db.select().from(workflowTimers).where(and(
      eq(workflowTimers.instanceId, r.encounter.workflowInstanceId), eq(workflowTimers.state, "waiting"),
      isNull(workflowTimers.firedAt), isNull(workflowTimers.cancelledAt),
    ));
    expect(timers).toHaveLength(1);
  });

  it("danger flags and never auto-clears", async () => {
    const opened = await openVisit(db, clerk.actor, { patientId: patient.id, departmentId: deptId, doctorId: dra.doctorId }, MON);
    const r1 = await recordVitals(db, vd.actor, opened.encounter.id, { ...adultOk, sbp: 190 }, MON);
    expect(r1.flags).toEqual([{ vital: "sbp", value: 190, bound: "max", limit: 180 }]);
    expect(r1.encounter.dangerFlagged).toBe(true);

    const entry1 = (await db.select().from(opdQueueEntries).where(eq(opdQueueEntries.encounterId, opened.encounter.id)))[0]!;
    expect(entry1.danger).toBe(true);

    const flaggedEvents = await db.select().from(events).where(eq(events.name, "vitals.danger_flagged"));
    expect(flaggedEvents).toHaveLength(1);
    expect(flaggedEvents[0]!.payload).toMatchObject({
      flags: [{ vital: "sbp", value: 190, bound: "max", limit: 180 }], tokenNo: 1,
    });

    const MON5 = new Date(MON.getTime() + 5 * 60_000);
    const r2 = await recordVitals(db, vd.actor, opened.encounter.id, adultOk, MON5);
    expect(r2.vitals.dangerFlags).toEqual([]);
    expect(r2.encounter.dangerFlagged).toBe(true); // never auto-clears

    const entry2 = (await db.select().from(opdQueueEntries).where(eq(opdQueueEntries.encounterId, opened.encounter.id)))[0]!;
    expect(entry2.danger).toBe(true);

    const inst = (await db.select().from(workflowInstances).where(eq(workflowInstances.id, r2.encounter.workflowInstanceId)))[0]!;
    expect(inst.currentState).toBe("waiting");
    const timers = await db.select().from(workflowTimers).where(and(
      eq(workflowTimers.instanceId, r2.encounter.workflowInstanceId), eq(workflowTimers.state, "waiting"),
      isNull(workflowTimers.firedAt), isNull(workflowTimers.cancelledAt),
    ));
    expect(timers).toHaveLength(1); // no second transition

    const recordedEvents = await db.select().from(events).where(eq(events.name, "vitals.recorded"));
    expect(recordedEvents).toHaveLength(2);
  });

  it("incomplete writes nothing", async () => {
    const opened = await openVisit(db, clerk.actor, { patientId: patient.id, departmentId: deptId, doctorId: dra.doctorId }, MON);
    await expect(recordVitals(db, vd.actor, opened.encounter.id, { ...adultOk, weightKg: undefined }, MON))
      .rejects.toMatchObject({ code: "vitals_incomplete", detail: { missing: ["weightKg"] } });

    const vitalsRows = await db.select().from(opdVitals).where(eq(opdVitals.encounterId, opened.encounter.id));
    expect(vitalsRows).toHaveLength(0);
    const opdEvents = await db.select().from(events).where(eq(events.module, "opd"));
    expect(opdEvents).toHaveLength(2); // visit.opened + patient.checked_in only
    expect((await getEncounter(db, opened.encounter.id))!.status).toBe("registered");
  });

  it("pediatric band + weight context", async () => {
    const opened = await openVisit(db, clerk.actor, { patientId: childPatient.id, departmentId: deptId, doctorId: dra.doctorId }, MON);
    const r = await recordVitals(db, vd.actor, opened.encounter.id, { heightCm: 92, weightKg: 14, tempC: 37.2, spo2: 98, pulse: 155 }, MON);
    expect(r.vitals.band).toBe("child_1_5");
    expect(r.vitals.ageYearsAtRecord).toBe(3);
    expect(r.flags).toEqual([{ vital: "pulse", value: 155, bound: "max", limit: 150 }]);

    await expect(recordVitals(db, vd.actor, opened.encounter.id, { heightCm: 92, tempC: 37.2, spo2: 98, pulse: 100 }, MON))
      .rejects.toMatchObject({ code: "vitals_incomplete", detail: { missing: ["weightKg"] } });
  });

  it("gates: invalid ranges, role_denied writes nothing, and a non-recordable state", async () => {
    const opened = await openVisit(db, clerk.actor, { patientId: patient.id, departmentId: deptId, doctorId: dra.doctorId }, MON);

    await expect(recordVitals(db, vd.actor, opened.encounter.id, { ...adultOk, spo2: 101 }, MON))
      .rejects.toMatchObject({ code: "invalid_vitals" });
    expect(await db.select().from(opdVitals).where(eq(opdVitals.encounterId, opened.encounter.id))).toHaveLength(0);

    await expect(recordVitals(db, clerk.actor, opened.encounter.id, adultOk, MON))
      .rejects.toMatchObject({ name: "WorkflowError", code: "role_denied" });
    expect(await db.select().from(opdVitals).where(eq(opdVitals.encounterId, opened.encounter.id))).toHaveLength(0);
    expect((await getEncounter(db, opened.encounter.id))!.status).toBe("registered");

    await abandonVisit(db, clerk.actor, opened.encounter.id, "left before vitals", MON);
    await expect(recordVitals(db, vd.actor, opened.encounter.id, adultOk, MON))
      .rejects.toMatchObject({ code: "encounter_state_conflict" });
  });
});
