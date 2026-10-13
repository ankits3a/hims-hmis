import { and, eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { seedBillingBase } from "../../../test/helpers/billing";
import { activateOpdVisitDefinition, mkDoctor, mkPatient, mkUser, seedOpdBase, seedOpdMasters } from "../../../test/helpers/opd";
import { events, opdQueueEntries, opdVitals } from "../../kernel/db/schema";
import { listBench } from "./bench";
import { moveVisitDepartment } from "./department-move";
import { abandonVisit, getEncounter, joinQueue, openVisit } from "./encounters";
import { listQueue } from "./queue";
import { recordVitals } from "./vitals";
import type { Db } from "../../kernel/db/client";

/**
 * #773 — a desk correction after the vitals were taken: the readings follow the patient to the
 * replacement visit, the bay stops asking for them, and the move is written down.
 */
const MON = new Date("2026-08-17T04:00:00.000Z"); // Monday 09:30 IST
const LATER = new Date(MON.getTime() + 5 * 60_000);
const DAY = "2026-08-17";
const adultOk = { heightCm: 165, weightKg: 60, sbp: 120, dbp: 80, pulse: 72, spo2: 98, tempC: 37.0 };

describe("#773 — vitals follow a desk correction to the replacement visit", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let clerk: Awaited<ReturnType<typeof mkUser>>;
  let vd: Awaited<ReturnType<typeof mkUser>>;
  let ortho: Awaited<ReturnType<typeof mkDoctor>>;
  let ortho2: Awaited<ReturnType<typeof mkDoctor>>;
  let medic: Awaited<ReturnType<typeof mkDoctor>>;
  let deptId: string;
  let dept2Id: string;
  let patient: { id: string };

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    await seedOpdBase(db);
    await activateOpdVisitDefinition(db);
    const m = await seedOpdMasters(db);
    ({ deptId, dept2Id } = m);
    await seedBillingBase(db);
    const all = [0, 1, 2, 3, 4, 5, 6];
    ortho = await mkDoctor(db, { username: "vc_ortho", departmentId: deptId, roomId: m.roomId, weekdays: all });
    ortho2 = await mkDoctor(db, { username: "vc_ortho2", departmentId: deptId, roomId: m.roomId, weekdays: all });
    medic = await mkDoctor(db, { username: "vc_med", departmentId: dept2Id, roomId: m.room2Id, weekdays: all });
    clerk = await mkUser(db, "vc_clerk", ["front_office", "cashier"]);
    vd = await mkUser(db, "vc_vd", ["vitals_desk"]);
    patient = await mkPatient(db, clerk.actor);
  });

  const moved = () => db.select().from(events).where(eq(events.name, "visit.vitals_moved"));
  const activeOn = async (encounterId: string) =>
    (await db.select().from(opdVitals).where(and(eq(opdVitals.encounterId, encounterId), eq(opdVitals.status, "active")))).map((v) => v.id);

  async function expectCarried(fromId: string, toId: string, vitalsId: string, doctorId: string): Promise<void> {
    expect(await activeOn(toId)).toEqual([vitalsId]);
    expect(await activeOn(fromId)).toEqual([]);
    const row = (await db.select().from(opdVitals).where(eq(opdVitals.id, vitalsId)))[0]!;
    expect(row.recordedBy).toBe(vd.id); // the reading keeps its recorder and its time
    expect(row.recordedAt.getTime()).toBe(MON.getTime());
    expect((await getEncounter(db, toId))!.status).toBe("waiting");
    const entries = await db.select().from(opdQueueEntries).where(eq(opdQueueEntries.encounterId, toId));
    expect(entries.map((e) => e.status)).toEqual(["waiting"]);
    const bench = await listBench(db, vd.actor, { serviceDate: DAY }, LATER);
    expect(bench.find((b) => b.encounterId === toId)).toMatchObject({ vitalsDone: true, vitalsId });
    const q = (await listQueue(db, vd.actor, doctorId, DAY, LATER))!;
    expect(q.ordered.map((e) => e.encounterId)).toContain(toId);
    expect(q.waitingVitals).toBe(0);
    const audit = await moved();
    expect(audit).toHaveLength(1);
    expect(audit[0]!.actorId).toBe(clerk.id);
    expect(audit[0]!.payload).toMatchObject({ fromEncounterId: fromId, toEncounterId: toId, vitalsIds: [vitalsId] });
  }

  it("a department move after vitals: the new visit has the vitals, the bay shows it done, the move is audited", async () => {
    const wrong = await openVisit(db, clerk.actor, { patientId: patient.id, departmentId: deptId, doctorId: ortho.doctorId }, MON);
    const { vitals } = await recordVitals(db, vd.actor, wrong.encounter.id, adultOk, MON);
    const r = await moveVisitDepartment(db, clerk.actor, wrong.encounter.id, { departmentId: dept2Id, doctorId: medic.doctorId, reason: "booked in the wrong room" }, LATER);
    expect(r.to.encounter.status).toBe("waiting");
    await expectCarried(wrong.encounter.id, r.to.encounter.id, vitals.id, medic.doctorId);
  });

  it("'change the doctor' after vitals (abandon, then open): the same", async () => {
    const first = await openVisit(db, clerk.actor, { patientId: patient.id, departmentId: deptId, doctorId: ortho.doctorId }, MON);
    const { vitals } = await recordVitals(db, vd.actor, first.encounter.id, adultOk, MON);
    await abandonVisit(db, clerk.actor, first.encounter.id, "doctor changed at the desk before billing", LATER);
    const second = await openVisit(db, clerk.actor, { patientId: patient.id, departmentId: deptId, doctorId: ortho2.doctorId }, LATER);
    expect(second.encounter.status).toBe("waiting");
    await expectCarried(first.encounter.id, second.encounter.id, vitals.id, ortho2.doctorId);
  });

  it("a bill-first replacement carries them when its token is born", async () => {
    const first = await openVisit(db, clerk.actor, { patientId: patient.id, departmentId: deptId, doctorId: ortho.doctorId }, MON);
    const { vitals } = await recordVitals(db, vd.actor, first.encounter.id, adultOk, MON);
    await abandonVisit(db, clerk.actor, first.encounter.id, "doctor changed at the desk before billing", LATER);
    const second = await openVisit(db, clerk.actor, { patientId: patient.id, departmentId: deptId, doctorId: ortho2.doctorId, join: "defer" }, LATER);
    expect(await moved()).toHaveLength(0);
    await joinQueue(db, clerk.actor, second.encounter.id, LATER);
    await expectCarried(first.encounter.id, second.encounter.id, vitals.id, ortho2.doctorId);
  });

  it("a correction with no vitals changes nothing and writes no event", async () => {
    const wrong = await openVisit(db, clerk.actor, { patientId: patient.id, departmentId: deptId, doctorId: ortho.doctorId }, MON);
    const r = await moveVisitDepartment(db, clerk.actor, wrong.encounter.id, { departmentId: dept2Id, doctorId: medic.doctorId, reason: "booked in the wrong room" }, LATER);
    expect(r.to.encounter.status).toBe("registered");
    const entries = await db.select().from(opdQueueEntries).where(eq(opdQueueEntries.encounterId, r.to.encounter.id));
    expect(entries.map((e) => e.status)).toEqual(["waiting_vitals"]);
    expect(await moved()).toHaveLength(0);
  });

  it("a patient who left (not a correction): the vitals stay on the visit they were taken on", async () => {
    const left = await openVisit(db, clerk.actor, { patientId: patient.id, departmentId: deptId, doctorId: ortho.doctorId }, MON);
    const { vitals } = await recordVitals(db, vd.actor, left.encounter.id, adultOk, MON);
    await abandonVisit(db, clerk.actor, left.encounter.id, "left before the doctor", LATER);
    // Another patient's visit opened later the same day is no replacement for this one.
    const other = await mkPatient(db, clerk.actor);
    const theirs = await openVisit(db, clerk.actor, { patientId: other.id, departmentId: deptId, doctorId: ortho.doctorId }, LATER);
    expect(await activeOn(left.encounter.id)).toEqual([vitals.id]);
    expect(theirs.encounter.status).toBe("registered");
    expect(await moved()).toHaveLength(0);
  });
});
