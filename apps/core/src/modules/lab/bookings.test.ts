import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { seedLabDeskBase, serviceIdForLabCode } from "../../../test/helpers/lab";
import { withTx } from "../../kernel/db/client";
import { billingConfig, events, labBookings, opdDepartments, opdDoctors } from "../../kernel/db/schema";
import { grantPermissionToRole } from "../../kernel/auth/permissions";
import { bookingRules, bookLab, closeBooking, LAB_BOOKING_RULES, listBookings, saveBookingHours, slotsForDay } from "./bookings";
import { deskOrder } from "./desk";
import { commonOrderables, labFeeFree, walkInReadiness } from "./desk-picker";
import { LabError } from "./errors";
import type { LabDeskFixture } from "../../../test/helpers/lab";
import type { DeskOrderInput } from "./desk";
import type { Db } from "../../kernel/db/client";
import type { feeOffNow } from "../billing";

/**
 * OWNER 2026-10-11 — the lab desk's new flow (spec `SPEC-lab-desk-flow-2026-10-11.md`): future
 * bookings by date and time slot, the lab-fee boolean the desk skips its money step on, and the
 * picker's common tests.
 *
 * The clock is a parameter everywhere here, so no row depends on the day the suite runs.
 * 2026-11-02 is a Monday; 08:00 IST on the Sunday before is `NOW`.
 */
const NOW = new Date("2026-11-01T02:30:00Z"); // Sun 2026-11-01 08:00 IST
const MONDAY = "2026-11-02";

describe("lab bookings, the fee boolean and the common tests (owner 2026-10-11)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: LabDeskFixture;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });
  beforeEach(async () => { await truncateAll(db); fx = await seedLabDeskBase(db); });
  afterEach(() => { fx.unregister(); });

  const book = (over: Partial<Parameters<typeof bookLab>[2]> = {}, patientId = fx.patientId) =>
    withTx(db, (tx) => bookLab(tx, fx.desk.actor, {
      patientId, serviceDate: MONDAY, slotStart: "08:00", serviceIds: [serviceIdForLabCode("CBC")], ...over,
    }, NOW));

  async function refusal(p: Promise<unknown>): Promise<[string, unknown]> {
    const e = await p.then(() => null, (err: unknown) => err);
    expect(e).toBeInstanceOf(LabError);
    return [(e as LabError).code, (e as LabError).detail?.reason];
  }

  it("a slot takes four; the fifth is refused as full, a cancelled booking frees its place, and one person books once a day", async () => {
    await book();
    for (const n of [2, 3, 4]) {
      await db.insert(labBookings).values({
        id: `seed-${String(n)}`, patientId: fx.patientId, serviceDate: MONDAY, slotStart: "08:00",
        serviceIds: [serviceIdForLabCode("CBC")], status: "booked", createdBy: fx.desk.id,
      });
    }
    expect((await slotsForDay(db, fx.desk.actor, MONDAY, NOW)).slots.find((s) => s.start === "08:00"))
      .toEqual({ start: "08:00", booked: 4, free: 0, past: false });
    /** The mutant does not count, or counts per patient. */
    expect(await refusal(book({}, fx.otherPatientId))).toEqual(["booking_slot_unavailable", "full"]);
    /** The mutant counts cancelled rows. */
    await db.update(labBookings).set({ status: "cancelled" }).where(eq(labBookings.id, "seed-4"));
    await book({}, fx.otherPatientId);
    expect(await refusal(book({ slotStart: "09:00" }, fx.otherPatientId))).toEqual(["booking_slot_unavailable", "already_booked"]);
    expect(LAB_BOOKING_RULES.perSlot).toBe(4);
  });

  it("a closed day, a past slot, a day too far and a time that is not a slot are each refused by name", async () => {
    expect(await refusal(book({ serviceDate: "2026-11-08" }))).toEqual(["booking_slot_unavailable", "closed_day"]); // a Sunday
    expect(await refusal(book({ serviceDate: "2026-10-31" }))).toEqual(["booking_slot_unavailable", "past"]);
    expect(await refusal(book({ serviceDate: "2026-12-15" }))).toEqual(["booking_slot_unavailable", "too_far"]);
    expect(await refusal(book({ slotStart: "08:07" }))).toEqual(["booking_slot_unavailable", "not_a_slot"]);
    expect((await slotsForDay(db, fx.desk.actor, "2026-11-08", NOW)).closed).toBe("closed_day");
    expect(await db.select().from(labBookings)).toHaveLength(0);
  });

  it("a booking lists by day and by person with its test names, and cancel closes it without deleting it", async () => {
    const { bookingId } = await book({ serviceIds: [serviceIdForLabCode("CBC"), serviceIdForLabCode("LFT")] });
    const byDay = await listBookings(db, fx.desk.actor, { serviceDate: MONDAY });
    expect(byDay.map((b) => [b.slotStart, b.status, b.tests.map((t) => t.code)])).toEqual([["08:00", "booked", ["CBC", "LFT"]]]);
    expect((await listBookings(db, fx.desk.actor, { patientId: fx.patientId })).map((b) => b.id)).toEqual([bookingId]);
    await withTx(db, (tx) => closeBooking(tx, fx.desk.actor, bookingId, "cancelled", "patient travelling", NOW));
    const [row] = await db.select().from(labBookings).where(eq(labBookings.id, bookingId));
    expect([row?.status, row?.closeReason]).toEqual(["cancelled", "patient travelling"]);
    expect(await refusal(withTx(db, (tx) => closeBooking(tx, fx.desk.actor, bookingId, "no_show", null, NOW))))
      .toEqual(["booking_not_open", undefined]);
    const names = (await db.select().from(events)).map((e) => e.name).filter((n) => n.startsWith("lab.booking"));
    expect(names).toEqual(["lab.booking_made", "lab.booking_closed"]);
  });

  it("ARRIVED: the order placed with bookingId closes the booking in its own transaction; a refused order leaves it open", async () => {
    const { bookingId } = await book();
    const order = (over: Partial<DeskOrderInput> = {}) => withTx(db, (tx) => deskOrder(tx, fx.desk.actor, fx.decls, {
      patientId: fx.patientId, encounterNo: fx.encounterNo, serviceDate: fx.serviceDate,
      orderingClinicianId: fx.pathologist.id, items: [{ serviceId: serviceIdForLabCode("CBC") }],
      credit: { reason: "counter order, paid at collection" }, bookingId, ...over,
    } as DeskOrderInput));
    /** Another patient's order cannot close this booking, and the order rolls back with the refusal. */
    await expect(order({ patientId: fx.otherPatientId, encounterNo: fx.otherEncounterNo })).rejects.toThrow();
    expect((await db.select().from(labBookings))[0]?.status).toBe("booked");
    const placed = await order();
    const [row] = await db.select().from(labBookings).where(eq(labBookings.id, bookingId));
    expect([row?.status, row?.orderId]).toEqual(["fulfilled", placed.orderId]);
  });

  it("the lab fee boolean follows the switch; a missing config reads as charged", async () => {
    expect(await labFeeFree(db)).toBe(false);
    const [cfg] = await db.select().from(billingConfig);
    const rules = cfg!.chargeRules as Parameters<typeof feeOffNow>[0];
    await db.update(billingConfig).set({
      chargeRules: { ...rules, feeSwitches: { ...rules.feeSwitches, lab: [{ at: NOW.toISOString(), off: true, by: fx.desk.id }] } },
    });
    expect(await labFeeFree(db)).toBe(true);
    await db.delete(billingConfig);
    expect(await labFeeFree(db)).toBe(false);
  });

  it("the common tests start from the starter list on a new lab and rank what the lab orders", async () => {
    const fresh = await commonOrderables(db, NOW);
    expect(fresh.map((c) => c.code).slice(0, 1)).toEqual(["CBC"]);
    await withTx(db, (tx) => deskOrder(tx, fx.desk.actor, fx.decls, {
      patientId: fx.patientId, encounterNo: fx.encounterNo, serviceDate: fx.serviceDate,
      orderingClinicianId: fx.pathologist.id, items: [{ serviceId: serviceIdForLabCode("LFT") }],
      credit: { reason: "counter order, paid at collection" },
    } as DeskOrderInput));
    expect((await commonOrderables(db))[0]?.code).toBe("LFT");
  });

  it("BOOKING HOURS: the lab's own hours cut the slots and the capacity; only lab.catalogue.manage may set them; bad hours are refused", async () => {
    const hours = { open: "08:00", close: "09:00", slotMinutes: 30, perSlot: 2, daysAhead: 7, closedWeekdays: [0, 6] };
    /** A person without the lab's administration grant cannot set its hours. */
    await expect(withTx(db, (tx) => saveBookingHours(tx, { type: "user", id: "u-no-grant" }, hours, NOW))).rejects.toMatchObject({ code: "permission_denied" });
    await grantPermissionToRole(db, fx.registry, "lab_reception", "lab.catalogue.manage");
    expect(await refusal(withTx(db, (tx) => saveBookingHours(tx, fx.desk.actor, { ...hours, open: "10:00" }, NOW))))
      .toEqual(["catalogue_invalid", "the lab must open before it closes"]);
    await withTx(db, (tx) => saveBookingHours(tx, fx.desk.actor, hours, NOW));
    const day = await slotsForDay(db, fx.desk.actor, MONDAY, NOW);
    expect([day.perSlot, day.slots.map((s) => s.start)]).toEqual([2, ["08:00", "08:30"]]);
    /** Saturday is now closed, and 08:00 is a slot where 07:30 no longer is. */
    expect((await slotsForDay(db, fx.desk.actor, "2026-11-07", NOW)).closed).toBe("closed_day");
    expect(await refusal(book({ slotStart: "07:30" }))).toEqual(["booking_slot_unavailable", "not_a_slot"]);
    expect((await bookingRules(db)).saved?.by).toBe(fx.desk.id);
    expect((await db.select().from(events)).some((e) => e.name === "lab.booking_hours_changed")).toBe(true);
  });

  it("WALK-IN READINESS says what is missing — the department, then a doctor in it", async () => {
    expect(await walkInReadiness(db)).toEqual({ ready: true, problem: null });
    const [lab] = await db.select().from(opdDepartments).where(eq(opdDepartments.code, "LAB"));
    await db.update(opdDoctors).set({ active: false }).where(eq(opdDoctors.departmentId, lab!.id));
    expect(await walkInReadiness(db)).toEqual({ ready: false, problem: "no_pathologist" });
    await db.update(opdDepartments).set({ active: false }).where(eq(opdDepartments.id, lab!.id));
    expect(await walkInReadiness(db)).toEqual({ ready: false, problem: "lab_department_inactive" });
  });

});
