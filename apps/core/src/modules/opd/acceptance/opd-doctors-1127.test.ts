import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { activateOpdVisitDefinition, mkDoctor, mkPatient, mkUser, seedOpdBase, seedOpdMasters } from "../../../../test/helpers/opd";
import { withTx } from "../../../kernel/db/client";
import { opdAppointments, opdDepartments, opdDoctors, users } from "../../../kernel/db/schema";
import { newId } from "@hmis/contracts";
import { bookAppointment, listAppointments } from "../appointments";
import { doctorCandidates, doctorChangeImpact, doctorHistory, listDoctorsForAdmin } from "../doctor-admin";
import { openVisit } from "../encounters";
import { updateDoctor } from "../masters";
import { setSecondaryDepartment } from "../secondary";
import type { Db } from "../../../kernel/db/client";

/**
 * ACCEPTANCE — issue #1127, spec docs/specs/1127-opd-doctors-panel.md (owner APPROVED 2026-11-19): the server half.
 * OPD Admin → Doctors rebuilt on the Users screen's pattern; the Doctor ID fixed once minted.
 */
const MON = new Date("2026-08-17T04:00:00.000Z"); // Monday 2026-08-17, 09:30 IST
const TUE_0930 = new Date("2026-08-18T04:00:00.000Z");
const NEXT_MON_0930 = new Date("2026-08-24T04:00:00.000Z");
const NEXT_MON_1130 = new Date("2026-08-24T06:00:00.000Z");

describe("OPD Admin → Doctors (spec #1127)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let deptId: string;
  let dept2Id: string;
  let entId: string;
  let roomId: string;
  let doctor: Awaited<ReturnType<typeof mkDoctor>>;
  let admin: Awaited<ReturnType<typeof mkUser>>;
  let clerk: Awaited<ReturnType<typeof mkUser>>;
  let patient: { id: string };

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    await seedOpdBase(db);
    await activateOpdVisitDefinition(db);
    ({ deptId, dept2Id, roomId } = await seedOpdMasters(db));
    entId = newId();
    await db.insert(opdDepartments).values({ id: entId, code: "ENT", name: "ENT", createdBy: "t", updatedBy: "t" });
    doctor = await mkDoctor(db, { username: "rajdoc", departmentId: deptId, roomId, weekdays: [0, 1, 2, 3, 4, 5, 6] });
    admin = await mkUser(db, "opd_admin_1127", []);
    await db.update(users).set({ fullName: "Admin One" }).where(eq(users.id, admin.id));
    clerk = await mkUser(db, "clerk_1127", ["front_office"]);
    patient = await mkPatient(db, clerk.actor);
  });

  const statusOf = async (id: string) => (await db.select().from(opdAppointments).where(eq(opdAppointments.id, id)))[0]!.status;
  const book = (slotStart: Date, departmentId?: string) =>
    bookAppointment(db, clerk.actor, { patientId: patient.id, doctorId: doctor.doctorId, slotStart, ...(departmentId === undefined ? {} : { departmentId }) }, MON);

  it("spec #1127 D1: the admin list carries each doctor's username and whether they have a schedule this week", async () => {
    const idle = await mkDoctor(db, { username: "idledoc", departmentId: deptId, roomId, weekdays: [] });
    const rows = await listDoctorsForAdmin(db, MON);
    const busy = rows.find((r) => r.id === doctor.doctorId)!;
    const none = rows.find((r) => r.id === idle.doctorId)!;
    expect(busy.username).toBe("rajdoc");
    expect(busy.scheduledThisWeek).toBe(true);
    expect(none.username).toBe("idledoc");
    expect(none.scheduledThisWeek).toBe(false);
  });

  it("spec #1127 D3: the server rejects any change to a Doctor ID and keeps the old one", async () => {
    const before = (await db.select().from(opdDoctors).where(eq(opdDoctors.id, doctor.doctorId)))[0]!.code;
    await expect(withTx(db, (tx) => updateDoctor(tx, admin.actor, doctor.doctorId, { code: "FAC-77" }, MON)))
      .rejects.toMatchObject({ code: "doctor_id_fixed" });
    const after = (await db.select().from(opdDoctors).where(eq(opdDoctors.id, doctor.doctorId)))[0]!.code;
    expect(after).toBe(before);
  });

  it("spec #1127 D4: staff search lists active non-doctors from two letters, doctor-role first, never an existing doctor", async () => {
    const ravi = await mkUser(db, "ravi", ["doctor"]);
    await db.update(users).set({ fullName: "Ravi Kumar" }).where(eq(users.id, ravi.id));
    const rahul = await mkUser(db, "rahul", ["front_office"]);
    await db.update(users).set({ fullName: "Rahul Sinha" }).where(eq(users.id, rahul.id));
    const rani = await mkUser(db, "rani", ["doctor"]);
    await db.update(users).set({ fullName: "Rani Devi", active: false }).where(eq(users.id, rani.id));

    expect(await doctorCandidates(db, "r")).toEqual([]);
    const found = await doctorCandidates(db, "ra");
    expect(found.map((c) => c.username)).toEqual(["ravi", "rahul"]);
    expect(found[0]).toMatchObject({ username: "ravi", fullName: "Ravi Kumar", isDoctorRole: true });
    expect(typeof found[0]!.staffCode).toBe("string");
    expect(found.map((c) => c.username)).not.toContain("rajdoc");

    const rahulCode = (await db.select().from(users).where(eq(users.id, rahul.id)))[0]!.staffCode;
    expect((await doctorCandidates(db, rahulCode)).map((c) => c.username)).toEqual(["rahul"]);
  });

  it("spec #1127 D5: deactivating lists future bookings and today's waiting patients, then marks the bookings needs rebooking", async () => {
    const tue = await book(TUE_0930);
    const nextMon = await book(NEXT_MON_0930);
    await openVisit(db, clerk.actor, { patientId: patient.id, departmentId: deptId, doctorId: doctor.doctorId }, MON);

    const impact = await doctorChangeImpact(db, doctor.doctorId, { kind: "deactivate" }, MON);
    expect(impact.booked).toBe(2);
    expect(impact.bookedByDate).toEqual([{ date: "2026-08-18", count: 1 }, { date: "2026-08-24", count: 1 }]);
    expect(impact.waitingToday).toBe(1);

    const out = await withTx(db, (tx) => updateDoctor(tx, admin.actor, doctor.doctorId, { active: false }, MON));
    expect(out.needsRebooking.sort()).toEqual([tue.appointment.id, nextMon.appointment.id].sort());
    expect(out.waitingToday).toBe(1);
    expect(await statusOf(tue.appointment.id)).toBe("needs_rebooking");
    expect(await statusOf(nextMon.appointment.id)).toBe("needs_rebooking");
    const deskList = await listAppointments(db, { needsRebooking: true });
    expect(deskList.map((a) => a.id).sort()).toEqual([tue.appointment.id, nextMon.appointment.id].sort());
  });

  it("spec #1127 D6: a department change shows the same check, then marks only old-department bookings needs rebooking", async () => {
    await setSecondaryDepartment(db, admin.actor, doctor.doctorId, { departmentId: dept2Id }, MON);
    const primary = await book(NEXT_MON_0930);
    const secondary = await book(NEXT_MON_1130, dept2Id);
    expect(secondary.appointment.departmentId).toBe(dept2Id);

    const impact = await doctorChangeImpact(db, doctor.doctorId, { kind: "department", departmentId: entId }, MON);
    expect(impact.booked).toBe(1);
    expect(impact.bookedByDate).toEqual([{ date: "2026-08-24", count: 1 }]);

    await expect(withTx(db, (tx) => updateDoctor(tx, admin.actor, doctor.doctorId, { departmentId: dept2Id }, MON)))
      .rejects.toMatchObject({ code: "invalid_department_change" });

    const out = await withTx(db, (tx) => updateDoctor(tx, admin.actor, doctor.doctorId, { departmentId: entId }, MON));
    expect(out.needsRebooking).toEqual([primary.appointment.id]);
    expect(await statusOf(primary.appointment.id)).toBe("needs_rebooking");
    expect(await statusOf(secondary.appointment.id)).toBe("booked");
  });

  it("spec #1127 D7: the history lists each change: field, old → new, who and when", async () => {
    const LATER = new Date(MON.getTime() + 60_000);
    await withTx(db, (tx) => updateDoctor(tx, admin.actor, doctor.doctorId, { displayName: "Dr. Raj Kumar", registrationNo: "BMC/999" }, LATER));
    const lines = await doctorHistory(db, doctor.doctorId);
    expect(lines[0]).toMatchObject({
      kind: "changed",
      actorName: "Admin One",
      changes: expect.arrayContaining([
        { field: "displayName", from: "Dr rajdoc", to: "Dr. Raj Kumar" },
        { field: "registrationNo", from: "BMC/12345", to: "BMC/999" },
      ]),
    });
    expect(typeof lines[0]!.at).toBe("string");
  });
});
