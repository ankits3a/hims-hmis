import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { activateOpdVisitDefinition, mkDoctor, mkPatient, mkUser, seedOpdBase, seedOpdMasters } from "../../../test/helpers/opd";
import { events, opdAppointments, opdEncounters } from "../../kernel/db/schema";
import {
  bookAppointment, cancelAppointment, checkInAppointment, listAppointments, rescheduleAppointment, sweepAppointmentNoShows,
} from "./appointments";
import { cancelDoctorLeave, scheduleDoctorLeave } from "./leaves";
import { availableSlots } from "./schedules";
import type { Db } from "../../kernel/db/client";

/** Monday 2026-08-17, 09:30 IST — a template slot boundary (dra/drb: Mon–Sat 09:00–13:00, 10-min slots). */
const S0930 = new Date("2026-08-17T04:00:00.000Z");
/** Monday 09:35 IST — NOT a slot boundary. */
const S0935 = new Date("2026-08-17T04:05:00.000Z");
/** Monday 10:00 IST. */
const S1000 = new Date("2026-08-17T04:30:00.000Z");
/** Sunday 2026-08-16, 09:30 IST — the booking instant, the day before MON. */
const NOW_SUN = new Date("2026-08-16T04:00:00.000Z");

describe("opd appointments (book / reschedule / cancel / check-in / no-show sweep / leave cascade)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let clerk: Awaited<ReturnType<typeof mkUser>>;
  let dra: Awaited<ReturnType<typeof mkDoctor>>;
  let drb: Awaited<ReturnType<typeof mkDoctor>>;
  let deptId: string;
  let roomId: string;
  let p1: { id: string; uhid: string };
  let p2: { id: string; uhid: string };
  let p3: { id: string; uhid: string };

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    await seedOpdBase(db);
    await activateOpdVisitDefinition(db);
    const masters = await seedOpdMasters(db);
    deptId = masters.deptId;
    roomId = masters.roomId;
    dra = await mkDoctor(db, { username: "dra", departmentId: deptId, roomId: masters.roomId });
    drb = await mkDoctor(db, { username: "drb", departmentId: deptId, roomId: masters.room2Id });
    clerk = await mkUser(db, "clerk", ["front_office"]);
    p1 = await mkPatient(db, clerk.actor, { phone: "9876500001" });
    p2 = await mkPatient(db, clerk.actor, { phone: "9876500002" });
    p3 = await mkPatient(db, clerk.actor, { phone: "9876500003" });
  });

  it("books a slot with the exact row and event, and refuses an off-grid slot, a past slot, an unknown patient, and a non-user actor", async () => {
    const { appointment } = await bookAppointment(db, clerk.actor, { patientId: p1.id, doctorId: dra.doctorId, slotStart: S0930 }, NOW_SUN);
    expect(appointment.status).toBe("booked");
    expect(appointment.serviceDate).toBe("2026-08-17");
    expect(appointment.departmentId).toBe(deptId);
    expect(appointment.slotEnd.toISOString()).toBe("2026-08-17T04:10:00.000Z");
    expect(appointment.source).toBe("desk");

    const booked = await db.select().from(events).where(eq(events.name, "appointment.booked"));
    expect(booked).toHaveLength(1);
    expect(booked[0]!.patientId).toBe(p1.id);
    expect(booked[0]!.payload).toEqual({
      appointmentId: appointment.id, patientId: p1.id, doctorId: dra.doctorId, departmentId: deptId,
      serviceDate: "2026-08-17", slotStart: "2026-08-17T04:00:00.000Z", source: "desk",
    });

    await expect(
      bookAppointment(db, clerk.actor, { patientId: p2.id, doctorId: dra.doctorId, slotStart: S0935 }, NOW_SUN),
    ).rejects.toMatchObject({ code: "invalid_slot" });

    await expect(
      bookAppointment(db, clerk.actor, { patientId: p2.id, doctorId: dra.doctorId, slotStart: S0930 }, new Date(S0930.getTime() + 60_000)),
    ).rejects.toMatchObject({ code: "slot_in_past" });

    await expect(
      bookAppointment(db, clerk.actor, { patientId: "01NOSUCHPATIENT000000000A", doctorId: dra.doctorId, slotStart: new Date("2026-08-17T04:10:00.000Z") }, NOW_SUN),
    ).rejects.toMatchObject({ code: "patient_not_found" });

    await expect(
      bookAppointment(db, { type: "system", id: "sys" }, { patientId: p1.id, doctorId: dra.doctorId, slotStart: new Date("2026-08-17T04:20:00.000Z") }, NOW_SUN),
    ).rejects.toMatchObject({ code: "user_actor_required" });
  });

  it("the slot race: the partial unique index is the sole arbiter — slot_taken on every interleaving, exactly one live row, five iterations, no early bail", async () => {
    let priorBookedEvents = 0;
    for (let k = 0; k < 5; k++) {
      const slotStart = new Date(S0930.getTime() + k * 10 * 60_000);
      const results = await Promise.allSettled([
        bookAppointment(db, clerk.actor, { patientId: p1.id, doctorId: dra.doctorId, slotStart }, NOW_SUN),
        bookAppointment(db, clerk.actor, { patientId: p2.id, doctorId: dra.doctorId, slotStart }, NOW_SUN),
      ]);
      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]!.reason).toMatchObject({ code: "slot_taken" });

      const live = await db.select().from(opdAppointments).where(eq(opdAppointments.doctorId, dra.doctorId));
      const liveForSlot = live.filter((a) => a.slotStart.getTime() === slotStart.getTime() && ["booked", "checked_in", "needs_rebooking"].includes(a.status));
      expect(liveForSlot).toHaveLength(1);

      const bookedEvents = await db.select().from(events).where(eq(events.name, "appointment.booked"));
      expect(bookedEvents.length).toBe(priorBookedEvents + 1);
      priorBookedEvents = bookedEvents.length;
    }

    const lastSlot = new Date(S0930.getTime() + 4 * 10 * 60_000);
    await expect(
      bookAppointment(db, clerk.actor, { patientId: p3.id, doctorId: dra.doctorId, slotStart: lastSlot }, NOW_SUN),
    ).rejects.toMatchObject({ code: "slot_taken" });
  });

  it("reschedules atomically: cancel-as-rescheduled + a new booked row; a slot conflict rolls the whole tx back; can move doctors; a cancelled one refuses", async () => {
    const { appointment: original } = await bookAppointment(db, clerk.actor, { patientId: p1.id, doctorId: dra.doctorId, slotStart: S0930 }, NOW_SUN);

    const { from, to } = await rescheduleAppointment(db, clerk.actor, original.id, { slotStart: S1000 }, NOW_SUN);
    expect(from.status).toBe("rescheduled");
    expect(from.rescheduledToId).toBe(to.id);
    expect(to.status).toBe("booked");
    expect(to.slotStart.toISOString()).toBe("2026-08-17T04:30:00.000Z");
    expect(to.rescheduledFromId).toBe(original.id);
    expect(to.patientId).toBe(p1.id);

    const rescheduledEvents = await db.select().from(events).where(eq(events.name, "appointment.rescheduled"));
    expect(rescheduledEvents).toHaveLength(1);
    expect(rescheduledEvents[0]!.payload).toEqual({
      fromAppointmentId: original.id, toAppointmentId: to.id, patientId: p1.id, doctorId: dra.doctorId, departmentId: deptId,
      serviceDate: "2026-08-17", slotStart: "2026-08-17T04:30:00.000Z", previousDoctorId: dra.doctorId, previousSlotStart: "2026-08-17T04:00:00.000Z",
    });

    // A slot p2 holds → slot_taken, and the whole transaction rolls back (the old row stays booked).
    const { appointment: p1Second } = await bookAppointment(db, clerk.actor, { patientId: p1.id, doctorId: dra.doctorId, slotStart: new Date("2026-08-17T04:40:00.000Z") }, NOW_SUN);
    await bookAppointment(db, clerk.actor, { patientId: p2.id, doctorId: dra.doctorId, slotStart: new Date("2026-08-17T04:50:00.000Z") }, NOW_SUN);
    await expect(
      rescheduleAppointment(db, clerk.actor, p1Second.id, { slotStart: new Date("2026-08-17T04:50:00.000Z") }, NOW_SUN),
    ).rejects.toMatchObject({ code: "slot_taken" });
    const stillBooked = (await db.select().from(opdAppointments).where(eq(opdAppointments.id, p1Second.id)))[0]!;
    expect(stillBooked.status).toBe("booked");

    // Reschedule to a different doctor (drb, same department).
    const { to: underDrb } = await rescheduleAppointment(db, clerk.actor, p1Second.id, { slotStart: S0930, doctorId: drb.doctorId }, NOW_SUN);
    expect(underDrb.doctorId).toBe(drb.doctorId);
    const drbEvent = (await db.select().from(events).where(eq(events.name, "appointment.rescheduled")))
      .find((e) => (e.payload as { toAppointmentId: string }).toAppointmentId === underDrb.id)!;
    expect((drbEvent.payload as { previousDoctorId: string }).previousDoctorId).toBe(dra.doctorId);

    // A cancelled appointment cannot be rescheduled.
    const { appointment: toCancel } = await bookAppointment(db, clerk.actor, { patientId: p3.id, doctorId: dra.doctorId, slotStart: new Date("2026-08-17T05:00:00.000Z") }, NOW_SUN);
    await cancelAppointment(db, clerk.actor, toCancel.id, "no longer needed", NOW_SUN);
    await expect(
      rescheduleAppointment(db, clerk.actor, toCancel.id, { slotStart: new Date("2026-08-17T05:10:00.000Z") }, NOW_SUN),
    ).rejects.toMatchObject({ code: "appointment_state_conflict" });
  });

  it("cancels: freed slot is bookable again; a blank reason and a repeat cancel are refused", async () => {
    const { appointment } = await bookAppointment(db, clerk.actor, { patientId: p1.id, doctorId: dra.doctorId, slotStart: S0930 }, NOW_SUN);

    await expect(cancelAppointment(db, clerk.actor, appointment.id, "  ", NOW_SUN)).rejects.toMatchObject({ code: "reason_required" });

    const { appointment: cancelled } = await cancelAppointment(db, clerk.actor, appointment.id, "patient called", NOW_SUN);
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.cancelReason).toBe("patient called");

    const cancelledEvents = await db.select().from(events).where(eq(events.name, "appointment.cancelled"));
    expect(cancelledEvents).toHaveLength(1);
    expect((cancelledEvents[0]!.payload as { reason: string }).reason).toBe("patient called");

    await expect(cancelAppointment(db, clerk.actor, appointment.id, "again", NOW_SUN)).rejects.toMatchObject({ code: "appointment_state_conflict" });

    const { appointment: rebooked } = await bookAppointment(db, clerk.actor, { patientId: p2.id, doctorId: dra.doctorId, slotStart: S0930 }, NOW_SUN);
    expect(rebooked.status).toBe("booked");
  });

  it("check-in claims the appointment then opens the visit; a wrong day and a repeat check-in refuse; the claim wins the race (five iterations)", async () => {
    const { appointment } = await bookAppointment(db, clerk.actor, { patientId: p1.id, doctorId: dra.doctorId, slotStart: S0930 }, NOW_SUN);
    const checkInAt = new Date("2026-08-17T03:50:00.000Z"); // 09:20 IST, ten minutes early

    const result = await checkInAppointment(db, clerk.actor, appointment.id, checkInAt);
    expect(result.tokenNo).toBe(1);
    expect(result.visitType).toBe("new");
    expect(result.encounter.appointmentId).toBe(appointment.id);
    expect(result.encounter.doctorId).toBe(dra.doctorId);
    expect(result.encounter.departmentId).toBe(deptId);
    expect(result.queueEntry.kind).toBe("appointment");
    expect(result.queueEntry.appointmentAt?.toISOString()).toBe(S0930.toISOString());
    expect(result.queueEntry.status).toBe("waiting_vitals");

    const updatedAppt = (await db.select().from(opdAppointments).where(eq(opdAppointments.id, appointment.id)))[0]!;
    expect(updatedAppt.status).toBe("checked_in");
    expect(updatedAppt.encounterId).toBe(result.encounter.id);

    const openedForThis = (await db.select().from(events).where(eq(events.name, "visit.opened")))
      .find((e) => (e.payload as { appointmentId: string | null }).appointmentId === appointment.id)!;
    expect((openedForThis.payload as { kind: string }).kind).toBe("appointment");

    // Wrong day: NO encounter written.
    const { appointment: wrongDayAppt } = await bookAppointment(db, clerk.actor, { patientId: p2.id, doctorId: dra.doctorId, slotStart: new Date("2026-08-17T04:10:00.000Z") }, NOW_SUN);
    await expect(
      checkInAppointment(db, clerk.actor, wrongDayAppt.id, new Date("2026-08-18T04:00:00.000Z")),
    ).rejects.toMatchObject({ code: "appointment_not_today" });
    const noEncounter = await db.select().from(opdEncounters).where(eq(opdEncounters.appointmentId, wrongDayAppt.id));
    expect(noEncounter).toHaveLength(0);

    // Repeat check-in.
    await expect(checkInAppointment(db, clerk.actor, appointment.id, checkInAt)).rejects.toMatchObject({ code: "appointment_state_conflict" });

    // The race: five fresh appointments, two concurrent check-ins each, invariant asserted every iteration, no early bail.
    for (let k = 0; k < 5; k++) {
      const slotStart = new Date(S0930.getTime() + (k + 1) * 20 * 60_000);
      const { appointment: raceAppt } = await bookAppointment(db, clerk.actor, { patientId: p3.id, doctorId: dra.doctorId, slotStart }, NOW_SUN);
      const results = await Promise.allSettled([
        checkInAppointment(db, clerk.actor, raceAppt.id, checkInAt),
        checkInAppointment(db, clerk.actor, raceAppt.id, checkInAt),
      ]);
      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]!.reason).toMatchObject({ code: "appointment_state_conflict" });
      const encsForAppt = await db.select().from(opdEncounters).where(eq(opdEncounters.appointmentId, raceAppt.id));
      expect(encsForAppt).toHaveLength(1);
    }
  });

  it("a needs_rebooking appointment cannot check in: doctor_on_leave", async () => {
    const { appointment } = await bookAppointment(db, clerk.actor, { patientId: p1.id, doctorId: dra.doctorId, slotStart: S0930 }, NOW_SUN);
    await scheduleDoctorLeave(db, clerk.actor, { doctorId: dra.doctorId, fromDate: "2026-08-17", toDate: "2026-08-17", reason: "conference" }, NOW_SUN);
    const marked = (await db.select().from(opdAppointments).where(eq(opdAppointments.id, appointment.id)))[0]!;
    expect(marked.status).toBe("needs_rebooking");
    await expect(
      checkInAppointment(db, clerk.actor, appointment.id, new Date("2026-08-17T03:50:00.000Z")),
    ).rejects.toMatchObject({ code: "doctor_on_leave" });
  });

  it("a leave cascades to booked appointments inside its range only, and cancelling it restores them", async () => {
    const { appointment: monAppt } = await bookAppointment(db, clerk.actor, { patientId: p1.id, doctorId: dra.doctorId, slotStart: S0930 }, NOW_SUN);
    const { appointment: tueAppt } = await bookAppointment(db, clerk.actor, { patientId: p2.id, doctorId: dra.doctorId, slotStart: new Date("2026-08-18T04:00:00.000Z") }, NOW_SUN);
    const { appointment: thuAppt } = await bookAppointment(db, clerk.actor, { patientId: p3.id, doctorId: dra.doctorId, slotStart: new Date("2026-08-20T04:00:00.000Z") }, NOW_SUN);

    const { leaveId, affectedAppointmentIds } = await scheduleDoctorLeave(
      db, clerk.actor, { doctorId: dra.doctorId, fromDate: "2026-08-17", toDate: "2026-08-18", reason: "conference" }, NOW_SUN,
    );
    expect([...affectedAppointmentIds].sort()).toEqual([monAppt.id, tueAppt.id].sort());

    const monRow = (await db.select().from(opdAppointments).where(eq(opdAppointments.id, monAppt.id)))[0]!;
    const tueRow = (await db.select().from(opdAppointments).where(eq(opdAppointments.id, tueAppt.id)))[0]!;
    const thuRow = (await db.select().from(opdAppointments).where(eq(opdAppointments.id, thuAppt.id)))[0]!;
    expect(monRow.status).toBe("needs_rebooking");
    expect(monRow.leaveId).toBe(leaveId);
    expect(tueRow.status).toBe("needs_rebooking");
    expect(tueRow.leaveId).toBe(leaveId);
    expect(thuRow.status).toBe("booked");

    const leaveEvents = await db.select().from(events).where(eq(events.name, "doctor_leave.scheduled"));
    expect(leaveEvents).toHaveLength(1);
    const payload = leaveEvents[0]!.payload as { affectedAppointmentIds: string[]; fromDate: string; toDate: string; reason: string };
    expect(payload.affectedAppointmentIds).toEqual([monAppt.id, tueAppt.id].sort());
    expect(payload.fromDate).toBe("2026-08-17");
    expect(payload.toDate).toBe("2026-08-18");
    expect(payload.reason).toBe("conference");

    expect(await availableSlots(db, dra.doctorId, "2026-08-17", NOW_SUN)).toEqual([]);

    const rebookingList = await listAppointments(db, { doctorId: dra.doctorId, needsRebooking: true });
    expect(rebookingList.map((a) => a.id).sort()).toEqual([monAppt.id, tueAppt.id].sort());

    // Rescheduling the Mon one to Thu 10:00 works.
    const { from: rescheduledFrom, to: rescheduledTo } = await rescheduleAppointment(
      db, clerk.actor, monAppt.id, { slotStart: new Date("2026-08-20T04:30:00.000Z") }, NOW_SUN,
    );
    expect(rescheduledFrom.status).toBe("rescheduled");
    expect(rescheduledTo.status).toBe("booked");

    const { restored } = await cancelDoctorLeave(db, clerk.actor, leaveId, NOW_SUN);
    expect(restored).toBe(1);
    const tueRestored = (await db.select().from(opdAppointments).where(eq(opdAppointments.id, tueAppt.id)))[0]!;
    expect(tueRestored.status).toBe("booked");
    expect(tueRestored.leaveId).toBeNull();
    const monUntouched = (await db.select().from(opdAppointments).where(eq(opdAppointments.id, monAppt.id)))[0]!;
    expect(monUntouched.status).toBe("rescheduled"); // the reschedule already moved it off needs_rebooking

    await expect(cancelDoctorLeave(db, clerk.actor, leaveId, NOW_SUN)).rejects.toMatchObject({ code: "leave_not_scheduled" });
    await expect(
      scheduleDoctorLeave(db, clerk.actor, { doctorId: dra.doctorId, fromDate: "2026-08-20", toDate: "2026-08-17", reason: "x" }, NOW_SUN),
    ).rejects.toMatchObject({ code: "invalid_leave_range" });
    await expect(
      scheduleDoctorLeave(db, clerk.actor, { doctorId: dra.doctorId, fromDate: "2026-08-10", toDate: "2026-08-10", reason: "x" }, NOW_SUN),
    ).rejects.toMatchObject({ code: "invalid_leave_range" });
    await expect(
      scheduleDoctorLeave(db, clerk.actor, { doctorId: dra.doctorId, fromDate: "2026-08-25", toDate: "2026-08-26", reason: "  " }, NOW_SUN),
    ).rejects.toMatchObject({ code: "reason_required" });
  });

  it("the no-show sweep claims yesterday's booked appointments per row, leaving today's alone", async () => {
    const { appointment: mon1 } = await bookAppointment(db, clerk.actor, { patientId: p1.id, doctorId: dra.doctorId, slotStart: S0930 }, NOW_SUN);
    const { appointment: mon2 } = await bookAppointment(db, clerk.actor, { patientId: p2.id, doctorId: dra.doctorId, slotStart: new Date("2026-08-17T04:10:00.000Z") }, NOW_SUN);
    const { appointment: tue1 } = await bookAppointment(db, clerk.actor, { patientId: p3.id, doctorId: dra.doctorId, slotStart: new Date("2026-08-18T04:00:00.000Z") }, NOW_SUN);

    // Still Monday IST: no-op.
    expect(await sweepAppointmentNoShows(db, new Date("2026-08-17T18:29:59.000Z"))).toBe(0);

    // Tuesday 00:00 IST: Monday's two rows fire, Tuesday's does not.
    expect(await sweepAppointmentNoShows(db, new Date("2026-08-17T18:30:00.000Z"))).toBe(2);

    const mon1Row = (await db.select().from(opdAppointments).where(eq(opdAppointments.id, mon1.id)))[0]!;
    const mon2Row = (await db.select().from(opdAppointments).where(eq(opdAppointments.id, mon2.id)))[0]!;
    const tue1Row = (await db.select().from(opdAppointments).where(eq(opdAppointments.id, tue1.id)))[0]!;
    expect(mon1Row.status).toBe("no_show");
    expect(mon2Row.status).toBe("no_show");
    expect(tue1Row.status).toBe("booked");

    const noShowEvents = await db.select().from(events).where(eq(events.name, "appointment.no_show"));
    expect(noShowEvents).toHaveLength(2);

    // Idempotent: a second sweep at the same instant fires nothing.
    expect(await sweepAppointmentNoShows(db, new Date("2026-08-17T18:30:00.000Z"))).toBe(0);
  });

  it("lists appointments by doctor+date ordered by slotStart, by patient, and by status", async () => {
    const { appointment: a1 } = await bookAppointment(db, clerk.actor, { patientId: p1.id, doctorId: dra.doctorId, slotStart: new Date("2026-08-17T04:10:00.000Z") }, NOW_SUN);
    const { appointment: a2 } = await bookAppointment(db, clerk.actor, { patientId: p1.id, doctorId: dra.doctorId, slotStart: S0930 }, NOW_SUN);
    const { appointment: a3 } = await bookAppointment(db, clerk.actor, { patientId: p2.id, doctorId: dra.doctorId, slotStart: new Date("2026-08-18T04:00:00.000Z") }, NOW_SUN);

    const byDoctorDate = await listAppointments(db, { doctorId: dra.doctorId, serviceDate: "2026-08-17" });
    expect(byDoctorDate.map((a) => a.id)).toEqual([a2.id, a1.id]);

    const byPatient = await listAppointments(db, { patientId: p1.id });
    expect(byPatient.map((a) => a.id).sort()).toEqual([a1.id, a2.id].sort());

    await cancelAppointment(db, clerk.actor, a1.id, "test", NOW_SUN);
    const byStatus = await listAppointments(db, { status: ["booked"] });
    expect(byStatus.map((a) => a.id).sort()).toEqual([a2.id, a3.id].sort());
  });
});
