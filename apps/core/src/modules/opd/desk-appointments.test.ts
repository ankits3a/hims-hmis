import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { activateOpdVisitDefinition, mkDoctor, mkPatient, mkUser, seedOpdBase, seedOpdMasters } from "../../../test/helpers/opd";
import { opdAppointments } from "../../kernel/db/schema";
import { bookAppointment, checkInAppointment } from "./appointments";
import { opdAppointmentsDeskProvider } from "./desk-provider";
import type { DeskProviderCtx } from "../../kernel/desk/types";
import type { Db } from "../../kernel/db/client";

/**
 * FD-1 T2 — the appointments tile against seeded bookings across the statuses; a doctor on leave
 * produces a ROW (a doctor, never a patient); nobody else's day is counted.
 */
const NOW_SUN = new Date("2026-08-16T04:00:00.000Z");   // booking day
const DATE = "2026-08-17";                              // Monday — the slot day
const S0930 = new Date("2026-08-17T04:00:00.000Z");
const S0940 = new Date("2026-08-17T04:10:00.000Z");   // ten-minute slots (seedOpdBase default)
const S1000 = new Date("2026-08-17T04:30:00.000Z");
const T0 = new Date("2026-08-17T04:12:00.000Z");        // 09:42 IST: the 09:30 slot has ended, 09:40 and 10:00 have not

describe("opd appointments desk provider (FD-1 T2)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let clerk: Awaited<ReturnType<typeof mkUser>>;
  let dra: Awaited<ReturnType<typeof mkDoctor>>;
  let drb: Awaited<ReturnType<typeof mkDoctor>>;
  let deptId: string;
  let roomId: string;
  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    await seedOpdBase(db);
    await activateOpdVisitDefinition(db);
    ({ deptId, roomId } = await seedOpdMasters(db));
    dra = await mkDoctor(db, { username: "dra", departmentId: deptId, roomId });
    drb = await mkDoctor(db, { username: "drb", departmentId: deptId, roomId });
    clerk = await mkUser(db, "clerk1", ["front_office"]);
  });
  const ctx = (): DeskProviderCtx => ({ db, actor: clerk.actor, reader: clerk.actor, date: DATE, now: T0 });
  const stat = (card: { stats?: { key: string; value: string }[] }, key: string): string => card.stats!.find((s) => s.key === key)!.value;

  it("due today · checked in · missed so far (no-show marked, or booked with the slot already ended) · needs rebooking with a DOCTOR row", async () => {
    const p1 = await mkPatient(db, clerk.actor, { name: "P1", phone: "9000000001" });
    const p2 = await mkPatient(db, clerk.actor, { name: "P2", phone: "9000000002" });
    const p3 = await mkPatient(db, clerk.actor, { name: "P3", phone: "9000000003" });
    const p4 = await mkPatient(db, clerk.actor, { name: "P4", phone: "9000000004" });
    const p5 = await mkPatient(db, clerk.actor, { name: "P5", phone: "9000000005" });
    const a1 = await bookAppointment(db, clerk.actor, { patientId: p1.id, doctorId: dra.doctorId, slotStart: S0930 }, NOW_SUN);   // slot ended, still booked → missed
    const a2 = await bookAppointment(db, clerk.actor, { patientId: p2.id, doctorId: dra.doctorId, slotStart: S0940 }, NOW_SUN);   // checked in
    await bookAppointment(db, clerk.actor, { patientId: p3.id, doctorId: drb.doctorId, slotStart: S1000 }, NOW_SUN);              // due, later
    const a4 = await bookAppointment(db, clerk.actor, { patientId: p4.id, doctorId: drb.doctorId, slotStart: S0930 }, NOW_SUN);   // marked no-show
    const a5 = await bookAppointment(db, clerk.actor, { patientId: p5.id, doctorId: drb.doctorId, slotStart: S0940 }, NOW_SUN);   // leave cascade → needs rebooking
    await checkInAppointment(db, clerk.actor, a2.appointment.id, T0);
    await db.update(opdAppointments).set({ status: "no_show" }).where(eq(opdAppointments.id, a4.appointment.id));
    await db.update(opdAppointments).set({ status: "needs_rebooking" }).where(eq(opdAppointments.id, a5.appointment.id));
    // a rebooking left over from LAST WEEK is history, not today's list — the desk clears from today on
    const p6 = await mkPatient(db, clerk.actor, { name: "P6", phone: "9000000006" });
    const a6 = await bookAppointment(db, clerk.actor, { patientId: p6.id, doctorId: dra.doctorId, slotStart: new Date("2026-08-18T04:00:00.000Z") }, NOW_SUN);
    await db.update(opdAppointments).set({ status: "needs_rebooking", serviceDate: "2026-08-10" }).where(eq(opdAppointments.id, a6.appointment.id));
    void a1;
    const [card] = await opdAppointmentsDeskProvider.load(ctx());
    expect(card!.key).toBe("opd.appointments");
    expect(stat(card!, "desk.appointments.dueToday")).toBe("4");          // a1 a2 a3 a4; a5 left the day for the rebooking list
    expect(stat(card!, "desk.appointments.checkedIn")).toBe("1");
    expect(stat(card!, "desk.appointments.missed")).toBe("2");            // a1 (slot ended, unswept) + a4 (marked)
    expect(stat(card!, "desk.appointments.needsRebooking")).toBe("1");
    expect(card!.rows).toEqual([{ id: drb.doctorId, badge: "1", title: expect.any(String), subtitle: "desk.appointments.rebookRow", severity: "warn", href: "/opd/appointments" }]);
    expect(JSON.stringify(card)).not.toContain("P5");                     // a doctor, never a patient
    expect(card!.topics).toBeUndefined();   // CLOSE pass 1: no topic this permission cannot subscribe to
    // DECIDED: the card is hospital-wide — a second clerk sees the same bookings
    const other = await mkUser(db, "clerk2", ["front_office"]);
    const [same] = await opdAppointmentsDeskProvider.load({ db, actor: other.actor, reader: other.actor, date: DATE, now: T0 });
    expect(same!.stats!.map((s) => s.value)).toEqual(card!.stats!.map((s) => s.value));
    expect(card!.stats!.every((s) => s.href === "/opd/appointments")).toBe(true);
  });

  it("another day's bookings are not today's; an empty day is a card of zeros with no rows", async () => {
    const p1 = await mkPatient(db, clerk.actor, { name: "P1", phone: "9000000001" });
    await bookAppointment(db, clerk.actor, { patientId: p1.id, doctorId: dra.doctorId, slotStart: new Date("2026-08-18T04:00:00.000Z") }, NOW_SUN);
    const [card] = await opdAppointmentsDeskProvider.load(ctx());
    expect(card!.stats!.map((s) => s.value)).toEqual(["0", "0", "0", "0"]);
    expect(card!.rows).toEqual([]);
  });
});
