import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { activateOpdVisitDefinition, mkDoctor, mkPatient, mkUser, seedOpdBase, seedOpdMasters } from "../../../test/helpers/opd";
import { events, opdAppointments, opdEncounters } from "../../kernel/db/schema";
import { appointmentForList, bookAppointment, checkInAppointment, listAppointments, rescheduleAppointment } from "./appointments";
import type { Db } from "../../kernel/db/client";

/**
 * TELE-CALL, SLICE 1 (owner 2026-10-09): an appointment may be booked as a tele-call with the
 * number to ring. Nothing else about a tele-call exists yet, so the desk's check-in refuses it.
 */
const S0930 = new Date("2026-08-17T04:00:00.000Z"); // Monday 09:30 IST
const S1000 = new Date("2026-08-17T04:30:00.000Z");
const S1010 = new Date("2026-08-17T04:40:00.000Z");
const NOW_SUN = new Date("2026-08-16T04:00:00.000Z");
const MON_0920 = new Date("2026-08-17T03:50:00.000Z");

describe("opd appointments — tele-call (slice 1)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let clerk: Awaited<ReturnType<typeof mkUser>>;
  let dra: Awaited<ReturnType<typeof mkDoctor>>;
  let p1: { id: string; uhid: string };

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    await seedOpdBase(db);
    await activateOpdVisitDefinition(db);
    const masters = await seedOpdMasters(db);
    dra = await mkDoctor(db, { username: "dra", departmentId: masters.deptId, roomId: masters.roomId });
    clerk = await mkUser(db, "clerk", ["front_office"]);
    p1 = await mkPatient(db, clerk.actor, { phone: "9876500001" });
  });
  const book = (extra: Record<string, unknown>, slotStart: Date = S0930) =>
    bookAppointment(db, clerk.actor, { patientId: p1.id, doctorId: dra.doctorId, slotStart, ...extra }, NOW_SUN);

  it("a tele-call without a usable Indian mobile number is refused by name, and nothing is booked", async () => {
    for (const telePhone of [undefined, "", "   ", "12345", "5876543021", "98765 4302", "+1 98765 43021", "98765x43021"]) {
      await expect(book({ mode: "tele", ...(telePhone === undefined ? {} : { telePhone }) })).rejects.toMatchObject({ code: "tele_phone_required" });
    }
    expect(await db.select().from(opdAppointments)).toHaveLength(0);
  });

  it("the number is kept as ten digits however it was typed", async () => {
    const { appointment } = await book({ mode: "tele", telePhone: "+91 98765 43021" });
    expect(appointment.mode).toBe("tele");
    expect(appointment.telePhone).toBe("9876543021");
    const stored = (await db.select().from(opdAppointments).where(eq(opdAppointments.id, appointment.id)))[0]!;
    expect({ mode: stored.mode, telePhone: stored.telePhone }).toEqual({ mode: "tele", telePhone: "9876543021" });
    expect((await book({ mode: "tele", telePhone: "098765-43022" }, S1000)).appointment.telePhone).toBe("9876543022");
    expect((await book({ mode: "tele", telePhone: "919876543023" }, S1010)).appointment.telePhone).toBe("9876543023");
  });

  it("a reschedule carries the mode and the number to the new row", async () => {
    const { appointment } = await book({ mode: "tele", telePhone: "9876543021" });
    const { from, to } = await rescheduleAppointment(db, clerk.actor, appointment.id, { slotStart: S1000 }, NOW_SUN);
    expect(from.status).toBe("rescheduled");
    expect({ mode: to.mode, telePhone: to.telePhone, status: to.status }).toEqual({ mode: "tele", telePhone: "9876543021", status: "booked" });
    // …and an in-person booking stays in person.
    const walk = await book({}, S1010);
    const moved = await rescheduleAppointment(db, clerk.actor, walk.appointment.id, { slotStart: S0930 }, NOW_SUN);
    expect({ mode: moved.to.mode, telePhone: moved.to.telePhone }).toEqual({ mode: "in_person", telePhone: null });
  });

  it("the desk's check-in refuses a tele-call in the desk's words, and writes nothing", async () => {
    const { appointment } = await book({ mode: "tele", telePhone: "9876543021" });
    await expect(checkInAppointment(db, clerk.actor, appointment.id, MON_0920)).rejects.toMatchObject({
      code: "tele_call_opens_at_slot", message: "Tele-call · opens at slot time",
    });
    expect((await db.select().from(opdAppointments).where(eq(opdAppointments.id, appointment.id)))[0]!.status).toBe("booked");
    expect(await db.select().from(opdEncounters)).toHaveLength(0);
  });

  it("an in-person booking is what it was — the same row, the same event, the same check-in — plus mode 'in_person'", async () => {
    const { appointment } = await book({});
    expect(Object.keys(appointment).sort()).toEqual([
      "appointmentNo", "bookedAt", "bookedBy", "cancelReason", "departmentId", "doctorId", "encounterId", "id", "leaveId",
      "mode", "note", "patientId", "rescheduledFromId", "rescheduledToId", "serviceDate", "slotEnd", "slotStart", "source",
      "status", "telePhone", "updatedAt", "updatedBy",
    ]);
    expect({ mode: appointment.mode, telePhone: appointment.telePhone, source: appointment.source, status: appointment.status })
      .toEqual({ mode: "in_person", telePhone: null, source: "desk", status: "booked" });
    // a number sent with an in-person booking is not kept
    expect((await book({ mode: "in_person", telePhone: "9876543021" }, S1000)).appointment.telePhone).toBeNull();

    const listed = await listAppointments(db, { doctorId: dra.doctorId, serviceDate: "2026-08-17" });
    expect(listed[0]).toEqual(appointment);

    const booked = await db.select().from(events).where(eq(events.name, "appointment.booked"));
    expect(Object.keys(booked[0]!.payload as object).sort()).toEqual(["appointmentId", "departmentId", "doctorId", "patientId", "serviceDate", "slotStart", "source"]);

    const result = await checkInAppointment(db, clerk.actor, appointment.id, MON_0920);
    expect(result.tokenNo).toBe(1);
  });

  it("the list hands the tele number only where it hands the patient's own — the audited contact read, and never for a sealed record", async () => {
    const { appointment } = await book({ mode: "tele", telePhone: "9876543021" });
    const open = { restricted: false };
    expect(appointmentForList(appointment, open, false)).toEqual({ ...appointment, telePhone: null });
    expect(appointmentForList(appointment, open, false).mode).toBe("tele");
    expect(appointmentForList(appointment, open, true).telePhone).toBe("9876543021");
    expect(appointmentForList(appointment, { restricted: true }, true).telePhone).toBeNull();
    expect(appointmentForList(appointment, null, true).telePhone).toBeNull();
  });

  it("the database refuses a tele row with no number, and a mode it does not know", async () => {
    const { appointment } = await book({});
    await expect(db.update(opdAppointments).set({ mode: "tele" }).where(eq(opdAppointments.id, appointment.id))).rejects.toThrow();
    await expect(db.update(opdAppointments).set({ mode: "video" }).where(eq(opdAppointments.id, appointment.id))).rejects.toThrow();
  });
});
