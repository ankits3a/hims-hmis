import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { hasPermission } from "../../kernel/auth/permissions";
import { labBookingSettings, labBookings, labOrderables } from "../../kernel/db/schema";
import { istDayString, istDayWindow } from "../../kernel/approvals/cumulative";
import { appendEvent } from "../../kernel/events/append";
import { getPatientSummaries, resolvePatientId } from "../patients";
import { LabError } from "./errors";
import { labBookingClosed, labBookingHoursChanged, labBookingMade } from "./events";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * OWNER 2026-10-11 — FUTURE LAB BOOKINGS, by date and time slot (spec
 * `SPEC-lab-desk-flow-2026-10-11.md`, the owner's answer "Date + time slots").
 *
 * A booking holds a person, a day, a slot and the tests they will have. It is not an order: nothing
 * is billed or drawn until they arrive, and on that day the desk's Arrived places the order through
 * the ordinary desk path with `bookingId`, which closes the booking in the order's own transaction.
 *
 * The hours are the lab's own (`lab_booking_settings`, edited on the desk's Booking hours panel by
 * whoever holds `lab.catalogue.manage`). Until somebody saves them, the DECIDED defaults below hold:
 * collection 07:30–12:30 IST, 15-minute slots, 4 patients a slot, closed on Sunday, 30 days ahead.
 */
export type LabBookingRules = {
  open: string; close: string; slotMinutes: number; perSlot: number; daysAhead: number; closedWeekdays: readonly number[];
};
export const LAB_BOOKING_RULES: LabBookingRules = {
  open: "07:30",
  close: "12:30",
  slotMinutes: 15,
  perSlot: 4,
  daysAhead: 30,
  closedWeekdays: [0],
};

/** The lab's saved hours, or the defaults when nobody has saved any. */
export async function bookingRules(exec: Db | Tx): Promise<LabBookingRules & { saved: { by: string; at: string } | null }> {
  const [row] = await (exec as Db).select().from(labBookingSettings).where(eq(labBookingSettings.id, "main"));
  if (!row) return { ...LAB_BOOKING_RULES, saved: null };
  return {
    open: row.openAt, close: row.closeAt, slotMinutes: row.slotMinutes, perSlot: row.perSlot,
    daysAhead: row.daysAhead, closedWeekdays: row.closedWeekdays, saved: { by: row.updatedBy, at: row.updatedAt.toISOString() },
  };
}

const HHMM = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

/**
 * SAVE THE HOURS. Bookings already made are never moved or cancelled by a change: a slot that is no
 * longer offered keeps its patients, and the desk still shows them on their day.
 */
export async function saveBookingHours(tx: Tx, actor: Actor, input: LabBookingRules, now: Date = new Date()): Promise<void> {
  if (actor.type !== "user" || !(await hasPermission(tx, actor.id, "lab.catalogue.manage", "hospital"))) {
    throw new LabError("permission_denied", "the lab's booking hours are set by the lab's administrator (lab.catalogue.manage)");
  }
  const bad = (why: string): never => { throw new LabError("catalogue_invalid", `booking hours: ${why}`, { reason: why }); };
  if (!HHMM.test(input.open) || !HHMM.test(input.close)) bad("open and close are HH:MM");
  if (toMinutes(input.open) >= toMinutes(input.close)) bad("the lab must open before it closes");
  if (![5, 10, 15, 20, 30, 45, 60].includes(input.slotMinutes)) bad("a slot is 5, 10, 15, 20, 30, 45 or 60 minutes");
  if (!Number.isInteger(input.perSlot) || input.perSlot < 1 || input.perSlot > 100) bad("1 to 100 patients a slot");
  if (!Number.isInteger(input.daysAhead) || input.daysAhead < 1 || input.daysAhead > 365) bad("bookable 1 to 365 days ahead");
  const closed = [...new Set(input.closedWeekdays)].sort();
  if (closed.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) bad("closed days are 0 (Sunday) to 6 (Saturday)");
  if (closed.length === 7) bad("the lab cannot be closed every day");
  const values = {
    openAt: input.open, closeAt: input.close, slotMinutes: input.slotMinutes, perSlot: input.perSlot,
    daysAhead: input.daysAhead, closedWeekdays: closed, updatedBy: actor.id, updatedAt: now,
  };
  await tx.insert(labBookingSettings).values({ id: "main", ...values })
    .onConflictDoUpdate({ target: labBookingSettings.id, set: values });
  await appendEvent(tx, labBookingHoursChanged.make({
    actor, payload: { open: input.open, close: input.close, slotMinutes: input.slotMinutes, perSlot: input.perSlot, daysAhead: input.daysAhead, closedWeekdays: closed },
  }));
}

const DAY_MS = 86_400_000;

function istToday(now: Date): string {
  return istDayString(now);
}
function istMinutesNow(now: Date): number {
  return Math.floor((now.getTime() - istDayWindow(now).start.getTime()) / 60_000);
}
function weekday(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}
function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}
const toMinutes = (hhmm: string): number => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const toHhmm = (m: number): string => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

/** Every slot start of a working day, in order. */
export function slotStarts(rules: LabBookingRules = LAB_BOOKING_RULES): string[] {
  const out: string[] = [];
  for (let m = toMinutes(rules.open); m < toMinutes(rules.close); m += rules.slotMinutes) {
    out.push(toHhmm(m));
  }
  return out;
}

/** Why a day takes no bookings, or null when it does. The screen says the reason in words. */
export function dayClosedReason(date: string, now: Date, rules: LabBookingRules = LAB_BOOKING_RULES): "past" | "too_far" | "closed_day" | null {
  const today = istToday(now);
  const ahead = daysBetween(today, date);
  if (ahead < 0) return "past";
  if (ahead > rules.daysAhead) return "too_far";
  if (rules.closedWeekdays.includes(weekday(date))) return "closed_day";
  return null;
}

async function assertMayBook(exec: Db | Tx, actor: Actor): Promise<void> {
  if (actor.type !== "user" || !(await hasPermission(exec, actor.id, "lab.desk.operate", "hospital"))) {
    throw new LabError("permission_denied", "booking a lab visit is the lab desk's act (lab.desk.operate)");
  }
}

export type LabSlot = { start: string; booked: number; free: number; past: boolean };
export type LabDaySlots = {
  serviceDate: string; closed: "past" | "too_far" | "closed_day" | null; perSlot: number; slots: LabSlot[];
  /** The hours the slots were cut from — the screen's date strip greys the closed weekdays. */
  rules: LabBookingRules;
};

export async function slotsForDay(db: Db, actor: Actor, serviceDate: string, now: Date = new Date()): Promise<LabDaySlots> {
  await assertMayBook(db, actor);
  const rules: LabBookingRules = await bookingRules(db);
  const closed = dayClosedReason(serviceDate, now, rules);
  if (closed !== null) return { serviceDate, closed, perSlot: rules.perSlot, slots: [], rules };
  const counts = await db
    .select({ slotStart: labBookings.slotStart, n: sql<number>`count(*)::int` })
    .from(labBookings)
    .where(and(eq(labBookings.serviceDate, serviceDate), eq(labBookings.status, "booked")))
    .groupBy(labBookings.slotStart);
  const byStart = new Map(counts.map((c) => [c.slotStart, c.n]));
  const isToday = serviceDate === istToday(now);
  const nowMin = istMinutesNow(now);
  return {
    serviceDate, closed: null, perSlot: rules.perSlot, rules,
    slots: slotStarts(rules).map((start) => {
      const booked = byStart.get(start) ?? 0;
      return { start, booked, free: Math.max(0, rules.perSlot - booked), past: isToday && toMinutes(start) <= nowMin };
    }),
  };
}

export type BookLabInput = { patientId: string; serviceDate: string; slotStart: string; serviceIds: string[]; note?: string | null };

export async function bookLab(tx: Tx, actor: Actor, input: BookLabInput, now: Date = new Date()): Promise<{ bookingId: string }> {
  await assertMayBook(tx, actor);
  const patientId = await resolvePatientId(tx, input.patientId);
  if (!patientId) throw new LabError("unknown_patient", `no patient ${input.patientId}`);
  const rules = await bookingRules(tx);
  const closed = dayClosedReason(input.serviceDate, now, rules);
  if (closed !== null) {
    throw new LabError("booking_slot_unavailable", `the lab takes no bookings for ${input.serviceDate} (${closed})`, { reason: closed });
  }
  if (!slotStarts(rules).includes(input.slotStart)) {
    throw new LabError("booking_slot_unavailable", `${input.slotStart} is not a lab slot`, { reason: "not_a_slot" });
  }
  if (input.serviceDate === istToday(now) && toMinutes(input.slotStart) <= istMinutesNow(now)) {
    throw new LabError("booking_slot_unavailable", `${input.slotStart} today has already gone`, { reason: "past" });
  }
  const serviceIds = [...new Set(input.serviceIds)];
  if (serviceIds.length === 0) throw new LabError("unknown_service", "a booking with no tests books nothing");
  const known = await tx.select({ serviceId: labOrderables.serviceId }).from(labOrderables)
    .where(and(inArray(labOrderables.serviceId, serviceIds), eq(labOrderables.active, true)));
  const missing = serviceIds.filter((id) => !known.some((k) => k.serviceId === id));
  if (missing.length > 0) throw new LabError("unknown_service", `not an active lab test: ${missing.join(", ")}`);

  /** One writer per slot at a time, so the fifth patient cannot slip in beside the fourth. */
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`lab_booking:${input.serviceDate}:${input.slotStart}`}))`);
  const [taken] = await tx.select({ n: sql<number>`count(*)::int` }).from(labBookings)
    .where(and(eq(labBookings.serviceDate, input.serviceDate), eq(labBookings.slotStart, input.slotStart), eq(labBookings.status, "booked")));
  if ((taken?.n ?? 0) >= rules.perSlot) {
    throw new LabError("booking_slot_unavailable", `${input.slotStart} on ${input.serviceDate} is full`, { reason: "full" });
  }
  const [same] = await tx.select({ id: labBookings.id, slotStart: labBookings.slotStart }).from(labBookings)
    .where(and(eq(labBookings.patientId, patientId), eq(labBookings.serviceDate, input.serviceDate), eq(labBookings.status, "booked")));
  if (same) {
    throw new LabError("booking_slot_unavailable", `already booked on ${input.serviceDate} at ${same.slotStart}`, { reason: "already_booked", bookingId: same.id });
  }

  const id = newId();
  await tx.insert(labBookings).values({
    id, patientId, serviceDate: input.serviceDate, slotStart: input.slotStart, serviceIds,
    note: input.note?.trim() || null, status: "booked", createdBy: actor.id, createdAt: now,
  });
  await appendEvent(tx, labBookingMade.make({
    actor, patientId, correlationId: id,
    payload: { bookingId: id, patientId, serviceDate: input.serviceDate, slotStart: input.slotStart, testCount: serviceIds.length },
  }));
  return { bookingId: id };
}

export type LabBookingRow = {
  id: string; serviceDate: string; slotStart: string; status: string; note: string | null;
  orderId: string | null; createdAt: string;
  patient: { id: string; uhid: string; display: string; restricted: boolean };
  tests: { serviceId: string; code: string; nameEn: string }[];
};

/**
 * A day's bookings (the desk's list for that morning) or one person's (their history panel). Test
 * names travel because the clerk has to read them back to the patient; nothing clinical does.
 */
export async function listBookings(
  db: Db, actor: Actor, by: { serviceDate: string } | { patientId: string },
): Promise<LabBookingRow[]> {
  await assertMayBook(db, actor);
  const where = "serviceDate" in by
    ? eq(labBookings.serviceDate, by.serviceDate)
    : eq(labBookings.patientId, (await resolvePatientId(db, by.patientId)) ?? by.patientId);
  const rows = await db.select().from(labBookings).where(where)
    .orderBy("serviceDate" in by ? asc(labBookings.slotStart) : desc(labBookings.serviceDate), asc(labBookings.createdAt));
  if (rows.length === 0) return [];
  const summaries = await getPatientSummaries(db, actor, [...new Set(rows.map((r) => r.patientId))]);
  const byPatient = new Map(summaries.map((s) => [s.id, s]));
  const ids = [...new Set(rows.flatMap((r) => r.serviceIds))];
  const tests = ids.length === 0 ? [] : await db
    .select({ serviceId: labOrderables.serviceId, code: labOrderables.code, nameEn: labOrderables.nameEn })
    .from(labOrderables).where(inArray(labOrderables.serviceId, ids));
  const byService = new Map(tests.map((t) => [t.serviceId, t]));
  return rows.map((r) => {
    const s = byPatient.get(r.patientId);
    return {
      id: r.id, serviceDate: r.serviceDate, slotStart: r.slotStart, status: r.status, note: r.note,
      orderId: r.orderId, createdAt: r.createdAt.toISOString(),
      patient: {
        id: r.patientId, uhid: s?.uhid ?? "",
        display: s === undefined ? "—" : s.restricted ? (s.alias ?? "—") : (s.name ?? "—"),
        restricted: s?.restricted ?? false,
      },
      tests: r.serviceIds.map((id) => byService.get(id) ?? { serviceId: id, code: "?", nameEn: id }),
    };
  });
}

/** Cancel or no-show. The row stays; the reason is the record. */
export async function closeBooking(
  tx: Tx, actor: Actor, bookingId: string, outcome: "cancelled" | "no_show", reason: string | null, now: Date = new Date(),
): Promise<void> {
  await assertMayBook(tx, actor);
  const [row] = await tx.select().from(labBookings).where(eq(labBookings.id, bookingId)).for("update");
  if (!row) throw new LabError("unknown_booking", `no lab booking ${bookingId}`);
  if (row.status !== "booked") throw new LabError("booking_not_open", `booking ${bookingId} is already ${row.status}`, { status: row.status });
  await tx.update(labBookings).set({ status: outcome, closedBy: actor.id, closedAt: now, closeReason: reason?.trim() || null })
    .where(eq(labBookings.id, bookingId));
  await appendEvent(tx, labBookingClosed.make({
    actor, patientId: row.patientId, correlationId: bookingId,
    payload: { bookingId, patientId: row.patientId, outcome, orderId: null },
  }));
}

/**
 * ARRIVED — called by the desk's order path inside the order's own transaction, so a booking is
 * closed exactly when its order exists and never otherwise. The order must be for the booked person.
 */
export async function fulfilBookingInTx(
  tx: Tx, actor: Actor, bookingId: string, patientId: string, orderId: string, now: Date = new Date(),
): Promise<void> {
  const [row] = await tx.select().from(labBookings).where(eq(labBookings.id, bookingId)).for("update");
  if (!row) throw new LabError("unknown_booking", `no lab booking ${bookingId}`);
  if (row.status !== "booked") throw new LabError("booking_not_open", `booking ${bookingId} is already ${row.status}`, { status: row.status });
  const canonical = (await resolvePatientId(tx, patientId)) ?? patientId;
  if (row.patientId !== canonical) {
    throw new LabError("booking_not_open", `booking ${bookingId} is for another patient`, { status: row.status });
  }
  await tx.update(labBookings).set({ status: "fulfilled", orderId, closedBy: actor.id, closedAt: now })
    .where(eq(labBookings.id, bookingId));
  await appendEvent(tx, labBookingClosed.make({
    actor, patientId: row.patientId, correlationId: bookingId,
    payload: { bookingId, patientId: row.patientId, outcome: "fulfilled", orderId },
  }));
}
