import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { hasPermission } from "../../kernel/auth/permissions";
import { labBookings, labOrderables } from "../../kernel/db/schema";
import { appendEvent } from "../../kernel/events/append";
import { getPatientSummaries, resolvePatientId } from "../patients";
import { LabError } from "./errors";
import { labBookingClosed, labBookingMade } from "./events";
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
 * DECIDED, until the lab sets its own hours (a settings screen is owed): collection 07:30–12:30 IST,
 * 15-minute slots, 4 patients a slot, closed on Sunday, bookable from today up to 30 days ahead.
 */
export const LAB_BOOKING_RULES = {
  open: "07:30",
  close: "12:30",
  slotMinutes: 15,
  perSlot: 4,
  daysAhead: 30,
  closedWeekdays: [0] as readonly number[],
} as const;

const IST_OFFSET_MS = 330 * 60_000;
const DAY_MS = 86_400_000;

function istToday(now: Date): string {
  return new Date(now.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}
function istMinutesNow(now: Date): number {
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  return ist.getUTCHours() * 60 + ist.getUTCMinutes();
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
export function slotStarts(): string[] {
  const out: string[] = [];
  for (let m = toMinutes(LAB_BOOKING_RULES.open); m < toMinutes(LAB_BOOKING_RULES.close); m += LAB_BOOKING_RULES.slotMinutes) {
    out.push(toHhmm(m));
  }
  return out;
}

/** Why a day takes no bookings, or null when it does. The screen says the reason in words. */
export function dayClosedReason(date: string, now: Date): "past" | "too_far" | "closed_day" | null {
  const today = istToday(now);
  const ahead = daysBetween(today, date);
  if (ahead < 0) return "past";
  if (ahead > LAB_BOOKING_RULES.daysAhead) return "too_far";
  if (LAB_BOOKING_RULES.closedWeekdays.includes(weekday(date))) return "closed_day";
  return null;
}

async function assertMayBook(exec: Db | Tx, actor: Actor): Promise<void> {
  if (actor.type !== "user" || !(await hasPermission(exec, actor.id, "lab.desk.operate", "hospital"))) {
    throw new LabError("permission_denied", "booking a lab visit is the lab desk's act (lab.desk.operate)");
  }
}

export type LabSlot = { start: string; booked: number; free: number; past: boolean };
export type LabDaySlots = { serviceDate: string; closed: "past" | "too_far" | "closed_day" | null; perSlot: number; slots: LabSlot[] };

export async function slotsForDay(db: Db, actor: Actor, serviceDate: string, now: Date = new Date()): Promise<LabDaySlots> {
  await assertMayBook(db, actor);
  const closed = dayClosedReason(serviceDate, now);
  if (closed !== null) return { serviceDate, closed, perSlot: LAB_BOOKING_RULES.perSlot, slots: [] };
  const counts = await db
    .select({ slotStart: labBookings.slotStart, n: sql<number>`count(*)::int` })
    .from(labBookings)
    .where(and(eq(labBookings.serviceDate, serviceDate), eq(labBookings.status, "booked")))
    .groupBy(labBookings.slotStart);
  const byStart = new Map(counts.map((c) => [c.slotStart, c.n]));
  const isToday = serviceDate === istToday(now);
  const nowMin = istMinutesNow(now);
  return {
    serviceDate, closed: null, perSlot: LAB_BOOKING_RULES.perSlot,
    slots: slotStarts().map((start) => {
      const booked = byStart.get(start) ?? 0;
      return { start, booked, free: Math.max(0, LAB_BOOKING_RULES.perSlot - booked), past: isToday && toMinutes(start) <= nowMin };
    }),
  };
}

export type BookLabInput = { patientId: string; serviceDate: string; slotStart: string; serviceIds: string[]; note?: string | null };

export async function bookLab(tx: Tx, actor: Actor, input: BookLabInput, now: Date = new Date()): Promise<{ bookingId: string }> {
  await assertMayBook(tx, actor);
  const patientId = await resolvePatientId(tx, input.patientId);
  if (!patientId) throw new LabError("unknown_patient", `no patient ${input.patientId}`);
  const closed = dayClosedReason(input.serviceDate, now);
  if (closed !== null) {
    throw new LabError("booking_slot_unavailable", `the lab takes no bookings for ${input.serviceDate} (${closed})`, { reason: closed });
  }
  if (!slotStarts().includes(input.slotStart)) {
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
  if ((taken?.n ?? 0) >= LAB_BOOKING_RULES.perSlot) {
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
