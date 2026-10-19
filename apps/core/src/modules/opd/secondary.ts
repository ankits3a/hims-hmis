import { and, eq, gt, gte, inArray, isNull, lte, or } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import { appendEvent } from "../../kernel/events/append";
import { withTx } from "../../kernel/db/client";
import { opdAppointments, opdDepartments, opdDoctorSecondaryDepartments, opdDoctors } from "../../kernel/db/schema";
import { OpdError } from "./errors";
import { doctorSecondaryDepartmentEnded, doctorSecondaryDepartmentSet } from "./events";
import { addDays, istDate } from "./time";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * ═══ #914 — A DOCTOR'S SECONDARY OPD DEPARTMENT (owner 2026-10-17) ═══
 *
 * Owner: a doctor consults in two departments "till I find specialist of the vacant department".
 * One primary (`opd_doctors.department_id`, unchanged) and at most one secondary, held here with a
 * first day and an optional last day.
 *
 * What the secondary reaches, and only that: the front desk's department lists, opening a visit,
 * an internal referral, the doctor search and the appointment book. The visit's own department
 * then decides everything after it (queue token series, consult screen per 0009 D11, reports,
 * fee visit type). Lab, radiology, roster units, pace and bench read the primary and are left alone.
 */

export type SecondaryRow = typeof opdDoctorSecondaryDepartments.$inferSelect;
type Exec = Db | Tx;

/** The row in force on `date`: started on or before it, not ended before it. */
function inForce(date: string) {
  return and(
    lte(opdDoctorSecondaryDepartments.fromDate, date),
    or(isNull(opdDoctorSecondaryDepartments.toDate), gte(opdDoctorSecondaryDepartments.toDate, date)),
  );
}

/** doctorId → secondary departmentId, for the doctors given (all doctors when omitted), on `date`. */
export async function secondaryDepartmentsOn(exec: Exec, date: string, doctorIds?: string[]): Promise<Map<string, string>> {
  if (doctorIds !== undefined && doctorIds.length === 0) return new Map();
  const rows = await exec
    .select({ doctorId: opdDoctorSecondaryDepartments.doctorId, departmentId: opdDoctorSecondaryDepartments.departmentId })
    .from(opdDoctorSecondaryDepartments)
    .where(doctorIds === undefined ? inForce(date) : and(inForce(date), inArray(opdDoctorSecondaryDepartments.doctorId, doctorIds)));
  return new Map(rows.map((r) => [r.doctorId, r.departmentId]));
}

/** The doctors whose SECONDARY is `departmentId` on `date` (their primary is elsewhere). */
export async function secondaryDoctorIdsIn(exec: Exec, departmentId: string, date: string): Promise<string[]> {
  const rows = await exec
    .select({ doctorId: opdDoctorSecondaryDepartments.doctorId })
    .from(opdDoctorSecondaryDepartments)
    .where(and(eq(opdDoctorSecondaryDepartments.departmentId, departmentId), inForce(date)));
  return rows.map((r) => r.doctorId);
}

/** True when the doctor sits in `departmentId` on `date`, as primary or as secondary. */
export async function doctorServesDepartment(
  exec: Exec, doctor: { id: string; departmentId: string }, departmentId: string, date: string,
): Promise<boolean> {
  if (doctor.departmentId === departmentId) return true;
  return (await secondaryDepartmentsOn(exec, date, [doctor.id])).get(doctor.id) === departmentId;
}

/**
 * Running or still to come: last day today or later, or open. A row withdrawn before its first day
 * (`to_date = from_date - 1`) serves no day and is not current.
 */
function current(today: string) {
  return or(isNull(opdDoctorSecondaryDepartments.toDate), and(
    gte(opdDoctorSecondaryDepartments.toDate, today),
    gte(opdDoctorSecondaryDepartments.toDate, opdDoctorSecondaryDepartments.fromDate),
  ));
}

/** Every doctor's current secondary (see `current`), by doctor id — the admin screen's column. */
export async function currentSecondaries(exec: Exec, today: string): Promise<Map<string, SecondaryRow>> {
  const rows = await exec.select().from(opdDoctorSecondaryDepartments).where(current(today));
  return new Map(rows.map((r) => [r.doctorId, r]));
}

/** One doctor's current secondary (see `current`), if any. */
export async function currentSecondary(exec: Exec, doctorId: string, today: string): Promise<SecondaryRow | null> {
  const rows = await exec.select().from(opdDoctorSecondaryDepartments)
    .where(and(eq(opdDoctorSecondaryDepartments.doctorId, doctorId), current(today)));
  return rows[0] ?? null;
}

/** Admin: the doctor starts serving `departmentId` from `fromDate` (default today). */
export async function setSecondaryDepartment(
  db: Db, actor: Actor, doctorId: string, input: { departmentId: string; fromDate?: string }, now: Date = new Date(),
): Promise<SecondaryRow> {
  if (actor.type !== "user") throw new OpdError("user_actor_required");
  const today = istDate(now);
  const fromDate = input.fromDate ?? today;
  if (fromDate < today) throw new OpdError("invalid_secondary_department", "a secondary department cannot start in the past");
  return withTx(db, async (tx) => {
    const doctor = (await tx.select().from(opdDoctors).where(eq(opdDoctors.id, doctorId)))[0];
    if (!doctor) throw new OpdError("unknown_doctor");
    const dept = (await tx.select().from(opdDepartments).where(eq(opdDepartments.id, input.departmentId)))[0];
    if (!dept) throw new OpdError("unknown_department");
    if (!dept.active) throw new OpdError("department_inactive");
    if (dept.id === doctor.departmentId) throw new OpdError("invalid_secondary_department", "that is the doctor's primary department");
    if (await currentSecondary(tx, doctorId, today) !== null) {
      throw new OpdError("secondary_department_state_conflict", "this doctor already has a secondary department; end it first");
    }
    const [row] = await tx.insert(opdDoctorSecondaryDepartments).values({
      id: newId(), doctorId, departmentId: dept.id, fromDate, createdBy: actor.id,
    }).returning();
    await appendEvent(tx, doctorSecondaryDepartmentSet.make({
      actor, payload: { secondaryId: row!.id, doctorId, departmentId: dept.id, fromDate },
    }));
    return row!;
  });
}

/**
 * Admin: the secondary's last day is `lastDate` (default today). Visits already seen there stay
 * where they were seen. Booked appointments in that department AFTER the last day go to
 * `needs_rebooking` in the same transaction — the leave cascade's rule (leaves.ts), without a
 * `leaveId`, because no leave caused it and there is nothing to restore.
 *
 * A secondary that has not started yet ends by closing it on the day before its first day, so the
 * row stays as history and no longer counts as running.
 */
export async function endSecondaryDepartment(
  db: Db, actor: Actor, doctorId: string, input: { lastDate?: string }, now: Date = new Date(),
): Promise<{ secondary: SecondaryRow; affectedAppointmentIds: string[] }> {
  if (actor.type !== "user") throw new OpdError("user_actor_required");
  const today = istDate(now);
  const asked = input.lastDate ?? today;
  if (asked < today) throw new OpdError("invalid_secondary_department", "the last day cannot be in the past");
  return withTx(db, async (tx) => {
    const running = await currentSecondary(tx, doctorId, today);
    if (running === null) throw new OpdError("secondary_department_state_conflict", "this doctor has no secondary department to end");
    if (running.toDate !== null && asked > running.toDate) {
      throw new OpdError("invalid_secondary_department", "the last day cannot move later");
    }
    const lastDate = asked < running.fromDate ? addDays(running.fromDate, -1) : asked;
    const [secondary] = await tx.update(opdDoctorSecondaryDepartments)
      .set({ toDate: lastDate, endedBy: actor.id, endedAt: now })
      .where(eq(opdDoctorSecondaryDepartments.id, running.id))
      .returning();
    const affected = await tx.update(opdAppointments)
      .set({ status: "needs_rebooking", updatedBy: actor.id, updatedAt: now })
      .where(and(
        eq(opdAppointments.doctorId, doctorId), eq(opdAppointments.departmentId, running.departmentId),
        eq(opdAppointments.status, "booked"), gt(opdAppointments.serviceDate, lastDate),
      ))
      .returning({ id: opdAppointments.id });
    const affectedAppointmentIds = affected.map((a) => a.id).sort();
    await appendEvent(tx, doctorSecondaryDepartmentEnded.make({
      actor, payload: { secondaryId: running.id, doctorId, departmentId: running.departmentId, lastDate, affectedAppointmentIds },
    }));
    return { secondary: secondary!, affectedAppointmentIds };
  });
}
