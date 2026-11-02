import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { activateOpdVisitDefinition, mkDoctor, mkPatient, mkUser, seedOpdBase, seedOpdMasters } from "../../../../test/helpers/opd";
import { withTx } from "../../../kernel/db/client";
import { events, opdDoctorLeaves, opdQueueEntries, opdVitals } from "../../../kernel/db/schema";
import { ROLE_MODEL } from "../../../../scripts/seed-roles";
import { changeVisitDoctor, doctorsForChange } from "../change-doctor";
import { getEncounter, moveEncounter, openVisit } from "../encounters";
import type { Db } from "../../../kernel/db/client";

/** Spec #1025 — a patient's doctor changed from the vitals screen, owner 2026-11-02. */
const MON = new Date("2026-08-17T04:00:00.000Z"); // Monday 09:30 IST
const LATER = new Date(MON.getTime() + 60_000);

describe("change a patient's doctor from vitals (spec #1025)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let dra: Awaited<ReturnType<typeof mkDoctor>>;
  let drb: Awaited<ReturnType<typeof mkDoctor>>;
  let vd: Awaited<ReturnType<typeof mkUser>>;
  let clerk: Awaited<ReturnType<typeof mkUser>>;
  let deptId: string;
  let dept2Id: string;
  let room2Id: string;
  let patient: { id: string };

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    await seedOpdBase(db);
    await activateOpdVisitDefinition(db);
    let roomId: string;
    ({ deptId, dept2Id, roomId, room2Id } = await seedOpdMasters(db));
    dra = await mkDoctor(db, { username: "dra", departmentId: deptId, roomId });
    drb = await mkDoctor(db, { username: "drb", departmentId: deptId, roomId: room2Id });
    clerk = await mkUser(db, "clerk", ["front_office"]);
    vd = await mkUser(db, "vd", ["vitals_desk"]);
    patient = await mkPatient(db, clerk.actor);
  });

  const open = async () => openVisit(db, clerk.actor, { patientId: patient.id, departmentId: deptId, doctorId: dra.doctorId }, MON);
  const change = (encounterId: string, toDoctorId = drb.doctorId) =>
    changeVisitDoctor(db, vd.actor, encounterId, { toDoctorId, consented: true, reason: "Patient asked" }, LATER);

  it("spec #1025 D1: a change moves one patient to the new doctor with the same token and queue place", async () => {
    const first = await open();
    const p2 = await mkPatient(db, clerk.actor, { phone: "9876530001" });
    const other = await openVisit(db, clerk.actor, { patientId: p2.id, departmentId: deptId, doctorId: dra.doctorId }, MON);
    const eligibleAt = new Date(MON.getTime() + 5_000);
    await db.update(opdQueueEntries).set({ eligibleAt }).where(eq(opdQueueEntries.id, first.queueEntry.id));
    await change(first.encounter.id);
    expect((await getEncounter(db, first.encounter.id))!.doctorId).toBe(drb.doctorId);
    expect((await getEncounter(db, other.encounter.id))!.doctorId).toBe(dra.doctorId);
    const entries = await db.select().from(opdQueueEntries).where(eq(opdQueueEntries.encounterId, first.encounter.id));
    const live = entries.find((e) => e.status !== "transferred")!;
    expect(live.tokenNo).toBe(first.queueEntry.tokenNo);
    expect(live.eligibleAt).toEqual(eligibleAt);
  });

  it("spec #1025 D2: the old doctor's line no longer shows the patient, and the new doctor's line does", async () => {
    const r = await open();
    const out = await change(r.encounter.id);
    const entries = await db.select().from(opdQueueEntries).where(eq(opdQueueEntries.encounterId, r.encounter.id));
    expect(entries.find((e) => e.sessionId === r.sessionId)!.status).toBe("transferred");
    expect(entries.find((e) => e.sessionId === out.toSessionId)).toBeDefined();
  });

  it("spec #1025 D3: vitals already saved stay on the visit", async () => {
    const r = await open();
    await db.insert(opdVitals).values({ id: "V1", encounterId: r.encounter.id, patientId: patient.id, tempC: 37, weightKg: 60, recordedBy: vd.id });
    await change(r.encounter.id);
    expect(await db.select().from(opdVitals).where(eq(opdVitals.encounterId, r.encounter.id))).toHaveLength(1);
  });

  it("spec #1025 D4: a change is refused once the consultation has begun", async () => {
    const r = await open();
    let enc = await withTx(db, (tx) => moveEncounter(tx, vd.actor, r.encounter, "waiting", {}, MON));
    enc = await withTx(db, (tx) => moveEncounter(tx, dra.actor, enc, "in_consultation", {}, MON));
    await db.update(opdQueueEntries).set({ status: "in_consult" }).where(eq(opdQueueEntries.id, r.queueEntry.id));
    await expect(change(enc.id)).rejects.toMatchObject({ code: "invalid_transfer" });
    expect((await getEncounter(db, enc.id))!.doctorId).toBe(dra.doctorId);
  });

  it("spec #1025 D5: vitals_desk holds the narrow permission and not opd.queue.transfer", () => {
    const held = ROLE_MODEL.find((r) => r.roleKey === "vitals_desk")!.permissions;
    expect(held).toContain("opd.vitals.change_doctor");
    expect(held).not.toContain("opd.queue.transfer");
  });

  it("spec #1025 D6: each change is audited with who, from, to and reason", async () => {
    const r = await open();
    await change(r.encounter.id);
    const audit = await db.select().from(events).where(eq(events.name, "visit.transferred"));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actorId: vd.id, payload: { fromDoctorId: dra.doctorId, toDoctorId: drb.doctorId, reason: "Patient asked", consented: true },
    });
  });

  it("spec #1025 D7: the list holds only active doctors of the department who sit today and are not on leave", async () => {
    const r = await open();
    const room = room2Id;
    await mkDoctor(db, { username: "offday", departmentId: deptId, roomId: room, weekdays: [3] });
    await mkDoctor(db, { username: "elsewhere", departmentId: dept2Id, roomId: room });
    const leave = await mkDoctor(db, { username: "onleave", departmentId: deptId, roomId: room });
    await db.insert(opdDoctorLeaves).values({ id: "L1", doctorId: leave.doctorId, fromDate: "2026-08-17", toDate: "2026-08-17", reason: "t", createdBy: "t" });
    const items = await doctorsForChange(db, r.encounter.id);
    expect(items.map((d) => d.id)).toEqual([drb.doctorId]);
  });
});
