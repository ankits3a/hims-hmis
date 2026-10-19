import { eq, inArray } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { activateOpdVisitDefinition, mkDoctor, mkPatient, mkUser, seedOpdBase, seedOpdMasters } from "../../../test/helpers/opd";
import { withTx } from "../../kernel/db/client";
import { events, opdAppointments, opdDepartments, opdQueueEntries } from "../../kernel/db/schema";
import { bookAppointment } from "./appointments";
import { getEncounter, openVisit } from "./encounters";
import { listDoctors } from "./masters";
import { listQueue, summaryByDoctor } from "./queue";
import { availableSlots, replaceDoctorSchedules } from "./schedules";
import { endSecondaryDepartment, setSecondaryDepartment } from "./secondary";
import type { Db } from "../../kernel/db/client";

/**
 * #914 (owner 2026-10-17) — a doctor consults in a SECONDARY department until a specialist fills it.
 * Each `it` is one of the issue's "done means" checks, plus the guards around them.
 */
const MON = new Date("2026-08-17T04:00:00.000Z"); // Monday 2026-08-17, 09:30 IST
const TUE = new Date("2026-08-18T04:00:00.000Z"); // the day after
const NEXT_MON_0930 = new Date("2026-08-24T04:00:00.000Z"); // a future Monday slot, 09:30 IST
const NEXT_MON_1130 = new Date("2026-08-24T06:00:00.000Z"); // 11:30 IST

describe("OPD — a doctor's secondary department (#914)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let medId: string; // primary: General Medicine
  let pedId: string; // the vacant department the doctor covers: Paediatrics
  let entId: string; // a third department the doctor does NOT sit in
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
    const m = await seedOpdMasters(db);
    medId = m.deptId; pedId = m.dept2Id; roomId = m.roomId;
    entId = newId();
    await db.insert(opdDepartments).values({ id: entId, code: "ENT", name: "ENT", createdBy: "t", updatedBy: "t" });
    doctor = await mkDoctor(db, { username: "drsec", departmentId: medId, roomId, weekdays: [0, 1, 2, 3, 4, 5, 6] });
    admin = await mkUser(db, "sec_admin", []);
    clerk = await mkUser(db, "sec_clerk", ["front_office"]);
    patient = await mkPatient(db, clerk.actor);
  });

  const cover = () => setSecondaryDepartment(db, admin.actor, doctor.doctorId, { departmentId: pedId }, MON);
  const listedIn = async (departmentId: string, date: string) =>
    (await summaryByDoctor(db, departmentId, date, MON)).map((s) => s.doctor.id);

  it("is listed under both departments and opens a visit in the secondary one", async () => {
    await cover();

    expect(await listedIn(medId, "2026-08-17")).toEqual([doctor.doctorId]);
    expect(await listedIn(pedId, "2026-08-17")).toEqual([doctor.doctorId]);
    const ped = (await summaryByDoctor(db, pedId, "2026-08-17", MON))[0]!;
    expect(ped.secondaryDepartmentId).toBe(pedId);
    const picker = await listDoctors(db, { departmentId: pedId }, MON);
    expect(picker.map((d) => d.id)).toEqual([doctor.doctorId]);
    expect(picker[0]!.secondary).toEqual({ departmentId: pedId, fromDate: "2026-08-17", toDate: null });

    const r = await openVisit(db, clerk.actor, { patientId: patient.id, departmentId: pedId, doctorId: doctor.doctorId }, MON);
    expect(r.encounter.departmentId).toBe(pedId);
    expect(r.tokenNo).toBe(1);

    const set = await db.select().from(events).where(eq(events.name, "doctor.secondary_department_set"));
    expect(set).toHaveLength(1);
  });

  it("the doctor's one line tags each patient with the department they came to", async () => {
    await cover();
    const other = await mkPatient(db, clerk.actor, { name: "Ravi Kumar", phone: "9876500000" });
    const a = await openVisit(db, clerk.actor, { patientId: patient.id, departmentId: medId, doctorId: doctor.doctorId }, MON);
    const b = await openVisit(db, clerk.actor, { patientId: other.id, departmentId: pedId, doctorId: doctor.doctorId }, MON);
    // TEST SHAPING (queue.test.ts's own): vitals put an entry in the waiting line; written directly here.
    await db.update(opdQueueEntries).set({ status: "waiting", eligibleAt: MON })
      .where(inArray(opdQueueEntries.id, [a.queueEntry!.id, b.queueEntry!.id]));

    const view = await listQueue(db, doctor.actor, doctor.doctorId, "2026-08-17", MON);
    const departments = view!.ordered.map((e) => e.encounter.departmentId).sort();
    expect(departments).toEqual([medId, pedId].sort());
  });

  it("a third department is still refused", async () => {
    await cover();
    await expect(openVisit(db, clerk.actor, { patientId: patient.id, departmentId: entId, doctorId: doctor.doctorId }, MON))
      .rejects.toMatchObject({ code: "doctor_department_mismatch" });
    expect(await listedIn(entId, "2026-08-17")).toEqual([]);
  });

  it("after the last day: gone from the list, visits refused, past visits kept, later bookings flagged", async () => {
    await cover();
    const seen = await openVisit(db, clerk.actor, { patientId: patient.id, departmentId: pedId, doctorId: doctor.doctorId }, MON);
    const pedBooking = await bookAppointment(db, clerk.actor, { patientId: patient.id, doctorId: doctor.doctorId, slotStart: NEXT_MON_0930, departmentId: pedId }, MON);
    const medBooking = await bookAppointment(db, clerk.actor, { patientId: patient.id, doctorId: doctor.doctorId, slotStart: NEXT_MON_1130 }, MON);
    expect(pedBooking.appointment.departmentId).toBe(pedId);
    expect(medBooking.appointment.departmentId).toBe(medId);

    const ended = await endSecondaryDepartment(db, admin.actor, doctor.doctorId, {}, MON);
    expect(ended.secondary.toDate).toBe("2026-08-17");
    expect(ended.affectedAppointmentIds).toEqual([pedBooking.appointment.id]);

    expect(await listedIn(pedId, "2026-08-18")).toEqual([]);
    expect(await listedIn(medId, "2026-08-18")).toEqual([doctor.doctorId]);
    await expect(openVisit(db, clerk.actor, { patientId: patient.id, departmentId: pedId, doctorId: doctor.doctorId }, TUE))
      .rejects.toMatchObject({ code: "doctor_department_mismatch" });
    expect((await getEncounter(db, seen.encounter.id))!.departmentId).toBe(pedId);

    const status = async (id: string) => (await db.select().from(opdAppointments).where(eq(opdAppointments.id, id)))[0]!.status;
    expect(await status(pedBooking.appointment.id)).toBe("needs_rebooking");
    expect(await status(medBooking.appointment.id)).toBe("booked");
  });

  it("a session named for the secondary department gives slots only in that department's book", async () => {
    await cover();
    await withTx(db, (tx) => replaceDoctorSchedules(tx, admin.actor, doctor.doctorId, [
      { weekday: 1, startTime: "09:00", endTime: "11:00", roomId, validFrom: "2026-01-01", departmentId: pedId },
      { weekday: 1, startTime: "11:00", endTime: "13:00", roomId, validFrom: "2026-01-01", departmentId: medId },
    ], MON));

    const med = await availableSlots(db, doctor.doctorId, "2026-08-24", MON, { departmentId: medId });
    const ped = await availableSlots(db, doctor.doctorId, "2026-08-24", MON, { departmentId: pedId });
    expect(med.length).toBeGreaterThan(0);
    expect(ped.length).toBeGreaterThan(0);
    expect(med.every((s) => s.departmentId === medId)).toBe(true);
    expect(ped.every((s) => s.departmentId === pedId)).toBe(true);
    expect(await availableSlots(db, doctor.doctorId, "2026-08-24", MON, { departmentId: entId })).toEqual([]);

    await expect(bookAppointment(db, clerk.actor, { patientId: patient.id, doctorId: doctor.doctorId, slotStart: NEXT_MON_0930, departmentId: medId }, MON))
      .rejects.toMatchObject({ code: "invalid_slot" });
    const booked = await bookAppointment(db, clerk.actor, { patientId: patient.id, doctorId: doctor.doctorId, slotStart: NEXT_MON_0930 }, MON);
    expect(booked.appointment.departmentId).toBe(pedId); // the session's own department
  });

  it("refuses the primary as secondary, a second secondary, and a session named for a department the doctor is not in", async () => {
    await expect(setSecondaryDepartment(db, admin.actor, doctor.doctorId, { departmentId: medId }, MON))
      .rejects.toMatchObject({ code: "invalid_secondary_department" });
    await cover();
    await expect(setSecondaryDepartment(db, admin.actor, doctor.doctorId, { departmentId: entId }, MON))
      .rejects.toMatchObject({ code: "secondary_department_state_conflict" });
    await expect(withTx(db, (tx) => replaceDoctorSchedules(tx, admin.actor, doctor.doctorId, [
      { weekday: 1, startTime: "09:00", endTime: "11:00", roomId, validFrom: "2026-01-01", departmentId: entId },
    ], MON))).rejects.toMatchObject({ code: "invalid_schedule" });
  });

  it("a secondary withdrawn before its first day serves no day and frees the doctor for another", async () => {
    await setSecondaryDepartment(db, admin.actor, doctor.doctorId, { departmentId: pedId, fromDate: "2026-08-20" }, MON);
    const ended = await endSecondaryDepartment(db, admin.actor, doctor.doctorId, {}, MON);
    expect(ended.secondary.toDate).toBe("2026-08-19");
    expect(await listedIn(pedId, "2026-08-20")).toEqual([]);
    await setSecondaryDepartment(db, admin.actor, doctor.doctorId, { departmentId: entId }, MON);
    expect(await listedIn(entId, "2026-08-17")).toEqual([doctor.doctorId]);
  });
});
