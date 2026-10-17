import { and, eq, inArray } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { opdAppointments, opdDoctorLeaves, opdDoctorSchedules, opdDoctors, resources } from "../../kernel/db/schema";
import { KERNEL_RESOURCE_KINDS, findKindDecl } from "../../kernel/resources";
import { OpdError } from "./errors";
import { loadOpdConfig } from "./config";
import { currentSecondary, doctorServesDepartment } from "./secondary";
import { slotsForDate } from "./slots";
import { istDate } from "./time";
import type { Actor } from "@hmis/contracts";
import type { Db, Tx } from "../../kernel/db/client";
import type { Slot } from "./slots";

/** DD2's one predicate, read from the kernel declaration — never a `"retired"` string literal. */
const ROOM_RETIRED = findKindDecl(KERNEL_RESOURCE_KINDS, "room")!.retired;

export type ScheduleInput = {
  weekday: number; startTime: string; endTime: string; roomId: string;
  slotMinutes?: number | null; validFrom: string; validTo?: string | null;
  /** #914 — the department this session serves: the primary or the current secondary. Omitted/null ⇒ either. */
  departmentId?: string | null;
};

const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function overlaps(a: ScheduleInput, b: ScheduleInput): boolean {
  return a.startTime < b.endTime && b.startTime < a.endTime;
}

/** Pure: HH:MM regex, start < end, weekday 0–6, validFrom ≤ validTo, no same-weekday overlap. */
export function validateScheduleSet(items: ScheduleInput[]): void {
  for (const item of items) {
    if (!Number.isInteger(item.weekday) || item.weekday < 0 || item.weekday > 6) {
      throw new OpdError("invalid_schedule", `weekday ${item.weekday} out of range 0-6`);
    }
    if (!HHMM_RE.test(item.startTime) || !HHMM_RE.test(item.endTime)) {
      throw new OpdError("invalid_schedule", `startTime/endTime must be HH:MM (got "${item.startTime}"-"${item.endTime}")`);
    }
    if (item.startTime >= item.endTime) {
      throw new OpdError("invalid_schedule", `startTime must be before endTime ("${item.startTime}"-"${item.endTime}")`);
    }
    if (item.validTo != null && item.validFrom > item.validTo) {
      throw new OpdError("invalid_schedule", "validFrom must be <= validTo");
    }
  }
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      if (items[i]!.weekday === items[j]!.weekday && overlaps(items[i]!, items[j]!)) {
        throw new OpdError("invalid_schedule", `overlapping templates on weekday ${items[i]!.weekday}`);
      }
    }
  }
}

/** Replaces a doctor's weekly template: deactivates the previous active set, inserts the new one. No delete path. */
export async function replaceDoctorSchedules(
  tx: Tx,
  actor: Actor,
  doctorId: string,
  items: ScheduleInput[],
  now: Date = new Date(),
): Promise<{ scheduleIds: string[] }> {
  if (actor.type !== "user") throw new OpdError("user_actor_required", "only a user actor may write OPD masters");
  validateScheduleSet(items);

  const roomIds = [...new Set(items.map((i) => i.roomId))];
  if (roomIds.length > 0) {
    // PLAN 13 T6 — the room book is the REGISTRY now. `kind = 'room'` is part of the predicate and
    // not decoration: `resources` holds beds and floors too, and a schedule pointing at a floor
    // would otherwise resolve happily.
    const rooms = await tx.select().from(resources)
      .where(and(eq(resources.kind, "room"), inArray(resources.id, roomIds)));
    const byId = new Map(rooms.map((r) => [r.id, r]));
    for (const roomId of roomIds) {
      const room = byId.get(roomId);
      // DD2 — there is no `active` boolean any more; "inactive" IS the kind's declared `retired`
      // status, read from the ONE declaration rather than restated as a string literal here.
      if (!room || room.status === ROOM_RETIRED) {
        throw new OpdError("unknown_room", `room ${roomId} not found or inactive`);
      }
    }
  }

  const named = [...new Set(items.map((i) => i.departmentId ?? null).filter((d): d is string => d !== null))];
  if (named.length > 0) {
    const doctor = (await tx.select().from(opdDoctors).where(eq(opdDoctors.id, doctorId)))[0];
    if (!doctor) throw new OpdError("unknown_doctor");
    const secondary = await currentSecondary(tx, doctorId, istDate(now));
    for (const departmentId of named) {
      if (departmentId !== doctor.departmentId && departmentId !== secondary?.departmentId) {
        throw new OpdError("invalid_schedule", `department ${departmentId} is neither this doctor's primary nor secondary`);
      }
    }
  }

  await tx.update(opdDoctorSchedules).set({ active: false }).where(eq(opdDoctorSchedules.doctorId, doctorId));

  const ids = items.map(() => newId());
  if (items.length > 0) {
    await tx.insert(opdDoctorSchedules).values(
      items.map((item, i) => ({
        id: ids[i]!,
        doctorId,
        weekday: item.weekday,
        startTime: item.startTime,
        endTime: item.endTime,
        roomId: item.roomId,
        departmentId: item.departmentId ?? null,
        slotMinutes: item.slotMinutes ?? null,
        validFrom: item.validFrom,
        validTo: item.validTo ?? null,
        active: true,
        createdBy: actor.id,
      })),
    );
  }
  return { scheduleIds: ids };
}

export async function listDoctorSchedules(
  db: Db,
  doctorId: string,
  opts: { activeOnly?: boolean } = {},
): Promise<(typeof opdDoctorSchedules.$inferSelect)[]> {
  const rows = await db.select().from(opdDoctorSchedules).where(eq(opdDoctorSchedules.doctorId, doctorId));
  return opts.activeOnly ? rows.filter((r) => r.active) : rows;
}

const LIVE_APPOINTMENT_STATUSES: string[] = ["booked", "checked_in", "needs_rebooking"];

/**
 * Slots of one date for one doctor: config + active templates + scheduled leaves + live bookings → slotsForDate.
 *
 * #914 — with `departmentId`, only that department's book: none when the doctor does not sit there
 * that day, else the sessions named for it plus the sessions that name no department.
 */
export async function availableSlots(
  db: Db | Tx, doctorId: string, date: string, now: Date = new Date(), opts: { departmentId?: string } = {},
): Promise<Slot[]> {
  const cfg = await loadOpdConfig(db);
  if (opts.departmentId !== undefined) {
    const doctor = (await db.select().from(opdDoctors).where(eq(opdDoctors.id, doctorId)))[0];
    if (!doctor || !await doctorServesDepartment(db, doctor, opts.departmentId, date)) return [];
  }
  const templates = await db
    .select()
    .from(opdDoctorSchedules)
    .where(and(eq(opdDoctorSchedules.doctorId, doctorId), eq(opdDoctorSchedules.active, true)));
  const leaveRows = await db
    .select()
    .from(opdDoctorLeaves)
    .where(and(eq(opdDoctorLeaves.doctorId, doctorId), eq(opdDoctorLeaves.status, "scheduled")));
  const bookedRows = await db
    .select({ slotStart: opdAppointments.slotStart })
    .from(opdAppointments)
    .where(
      and(
        eq(opdAppointments.doctorId, doctorId),
        eq(opdAppointments.serviceDate, date),
        inArray(opdAppointments.status, LIVE_APPOINTMENT_STATUSES),
      ),
    );

  const slots = slotsForDate({
    date,
    templates: templates.map((t) => ({
      id: t.id, weekday: t.weekday, startTime: t.startTime, endTime: t.endTime, roomId: t.roomId,
      slotMinutes: t.slotMinutes, validFrom: t.validFrom, validTo: t.validTo, active: t.active, departmentId: t.departmentId,
    })),
    leaves: leaveRows.map((l) => ({ fromDate: l.fromDate, toDate: l.toDate, status: l.status })),
    bookedStarts: bookedRows.map((r) => r.slotStart.getTime()),
    defaultSlotMinutes: cfg.slotMinutes,
    now,
  });
  return opts.departmentId === undefined ? slots : slots.filter((x) => x.departmentId === null || x.departmentId === opts.departmentId);
}
