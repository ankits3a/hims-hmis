import { and, asc, count, desc, eq, gte, ilike, inArray, isNull, lte, notExists, or, sql } from "drizzle-orm";
import { events, opdAppointments, opdDoctorSchedules, opdDoctors, roleAssignments, users } from "../../kernel/db/schema";
import { strandedBookings, waitingTodayFor } from "./doctor-cascade";
import { OpdError } from "./errors";
import { listDoctors } from "./masters";
import { addDays, istDate, istWeekday } from "./time";
import type { Db } from "../../kernel/db/client";
import type { DoctorListRow } from "./masters";

/**
 * ═══ #1127 — OPD ADMIN → DOCTORS, THE READS BEHIND THE USERS-SCREEN PATTERN (owner 2026-11-19) ═══
 *
 * The owner could not edit a doctor's name and had to copy a username from the Users screen to add
 * one. These are the four reads the rebuilt tab needs; every write stays in `masters.ts`.
 */

/** The admin list: the shared doctor row, plus the login it belongs to and whether it sits this week. */
export type DoctorAdminRow = DoctorListRow & { username: string; scheduledThisWeek: boolean; updatedByName: string | null };

/** Monday..Sunday (IST) of the week holding `today`. */
function weekOf(today: string): { from: string; to: string } {
  const back = (istWeekday(today) + 6) % 7; // Monday = 0 days back
  const from = addDays(today, -back);
  return { from, to: addDays(from, 6) };
}

export async function listDoctorsForAdmin(db: Db, now: Date = new Date()): Promise<DoctorAdminRow[]> {
  const rows = await listDoctors(db, {}, now);
  if (rows.length === 0) return [];
  // The doctor's own login, and who last changed the row (the panel's "last changed by" before #1127's history).
  const people = await db.select({ id: users.id, username: users.username, fullName: users.fullName }).from(users)
    .where(inArray(users.id, [...new Set(rows.flatMap((r) => [r.userId, r.updatedBy]))]));
  const person = new Map(people.map((u) => [u.id, u]));
  // "No schedule this week" = no active weekly row valid on any day of this IST week.
  const week = weekOf(istDate(now));
  const sitting = await db.selectDistinct({ doctorId: opdDoctorSchedules.doctorId }).from(opdDoctorSchedules)
    .where(and(
      eq(opdDoctorSchedules.active, true), lte(opdDoctorSchedules.validFrom, week.to),
      or(isNull(opdDoctorSchedules.validTo), gte(opdDoctorSchedules.validTo, week.from)),
    ));
  const sits = new Set(sitting.map((s) => s.doctorId));
  return rows.map((r) => ({
    ...r, username: person.get(r.userId)?.username ?? "", scheduledThisWeek: sits.has(r.id), updatedByName: person.get(r.updatedBy)?.fullName ?? null,
  }));
}

/**
 * The New doctor panel's staff search: ACTIVE users with no doctor profile whose name, username or
 * staff code holds the text, doctor-role holders first. Two letters at least — one letter would list
 * half the hospital. Only what the panel shows leaves the server: no roles beyond the doctor flag,
 * no phone, no credential state (spec #1127: an OPD admin does not hold user administration).
 */
export type DoctorCandidate = { userId: string; username: string; fullName: string; staffCode: string; isDoctorRole: boolean };

export async function doctorCandidates(db: Db, query: string, limit = 20): Promise<DoctorCandidate[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const rows = await db.select({ userId: users.id, username: users.username, fullName: users.fullName, staffCode: users.staffCode })
    .from(users)
    .where(and(
      eq(users.active, true),
      notExists(db.select({ one: sql`1` }).from(opdDoctors).where(eq(opdDoctors.userId, users.id))),
      or(ilike(users.fullName, like), ilike(users.username, like), ilike(users.staffCode, like)),
    ))
    .orderBy(asc(users.fullName))
    .limit(200);
  if (rows.length === 0) return [];
  // The role is read as its own query rather than a correlated EXISTS inside the select: drizzle
  // renders a column in a raw `sql` fragment unqualified, and `id` inside a subquery binds to the
  // subquery's own table — a doctor flag that was quietly false for everyone.
  const holders = await db.selectDistinct({ userId: roleAssignments.userId }).from(roleAssignments)
    .where(and(eq(roleAssignments.roleKey, "doctor"), inArray(roleAssignments.userId, rows.map((r) => r.userId))));
  const doctors = new Set(holders.map((h) => h.userId));
  return rows
    .map((r) => ({ ...r, isDoctorRole: doctors.has(r.userId) }))
    .sort((a, b) => Number(b.isDoctorRole) - Number(a.isDoctorRole) || a.fullName.localeCompare(b.fullName))
    .slice(0, limit);
}

/**
 * The check the admin sees BEFORE a deactivation or a department change: the bookings it would send
 * to `needs_rebooking` (counted per day — a masters screen carries no patient names) and today's
 * waiting patients. Counted with the cascade's own predicate (`doctor-cascade.ts`).
 */
export type DoctorChange = { kind: "deactivate" } | { kind: "department"; departmentId: string };
export type DoctorImpact = { booked: number; bookedByDate: { date: string; count: number }[]; waitingToday: number };

export async function doctorChangeImpact(db: Db, doctorId: string, change: DoctorChange, now: Date = new Date()): Promise<DoctorImpact> {
  const doctor = (await db.select().from(opdDoctors).where(eq(opdDoctors.id, doctorId)))[0];
  if (!doctor) throw new OpdError("unknown_doctor", `doctor ${doctorId} not found`);
  const today = istDate(now);
  const leaving = change.kind === "department" ? doctor.departmentId : undefined;
  const moves = change.kind === "deactivate" ? doctor.active : change.departmentId !== doctor.departmentId;
  const byDate = !moves ? [] : await db.select({ date: opdAppointments.serviceDate, count: count() }).from(opdAppointments)
    .where(strandedBookings(doctorId, today, leaving))
    .groupBy(opdAppointments.serviceDate)
    .orderBy(asc(opdAppointments.serviceDate));
  const bookedByDate = byDate.map((r) => ({ date: r.date, count: Number(r.count) }));
  return {
    booked: bookedByDate.reduce((n, r) => n + r.count, 0),
    bookedByDate,
    waitingToday: await waitingTodayFor(db, doctorId, today),
  };
}

/**
 * The panel's history, read from the event log: every master change since #1127, plus the second
 * department's start and end (#914). Newest first. Changes made before #1127 wrote no event, so the
 * panel shows only the row's "last changed by, on" for them.
 */
export type DoctorHistoryLine = {
  at: string; actorName: string;
  kind: "created" | "changed" | "secondary_set" | "secondary_ended";
  changes: { field: string; from: string | null; to: string | null }[];
};
const HISTORY_EVENTS = ["doctor.created", "doctor.profile_changed", "doctor.secondary_department_set", "doctor.secondary_department_ended"] as const;

export async function doctorHistory(db: Db, doctorId: string, limit = 100): Promise<DoctorHistoryLine[]> {
  const rows = await db.select({
    name: events.name, at: events.occurredAt, payload: events.payload, actorName: users.fullName, actorId: events.actorId,
  }).from(events)
    .leftJoin(users, eq(users.id, events.actorId))
    .where(and(inArray(events.name, [...HISTORY_EVENTS]), sql`${events.payload}->>'doctorId' = ${doctorId}`))
    .orderBy(desc(events.seq))
    .limit(limit);
  return rows.map((r) => {
    const p = r.payload as Record<string, unknown>;
    const base = { at: r.at.toISOString(), actorName: r.actorName ?? r.actorId };
    switch (r.name) {
      case "doctor.created":
        return { ...base, kind: "created" as const, changes: [
          { field: "displayName", from: null, to: String(p.displayName) },
          { field: "departmentId", from: null, to: String(p.departmentId) },
        ] };
      case "doctor.secondary_department_set":
        return { ...base, kind: "secondary_set" as const, changes: [{ field: "secondaryDepartmentId", from: null, to: String(p.departmentId) }] };
      case "doctor.secondary_department_ended":
        return { ...base, kind: "secondary_ended" as const, changes: [{ field: "secondaryDepartmentId", from: String(p.departmentId), to: null }] };
      default:
        return { ...base, kind: "changed" as const, changes: (p.changes ?? []) as DoctorHistoryLine["changes"] };
    }
  });
}
