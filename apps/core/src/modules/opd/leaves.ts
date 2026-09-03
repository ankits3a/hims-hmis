import { and, asc, eq, gte, inArray, lte } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import { appendEvent } from "../../kernel/events/append";
import { withTx } from "../../kernel/db/client";
import { opdAppointments, opdDoctorLeaves, opdDoctors, opdQueueEntries, opdQueueSessions } from "../../kernel/db/schema";
import { LIVE_ENTRY_STATUSES } from "./encounters";
import { OpdError } from "./errors";
import { doctorLeaveScheduled } from "./events";
import { istDate } from "./time";
import type { Db } from "../../kernel/db/client";

export type LeaveRow = typeof opdDoctorLeaves.$inferSelect;

/**
 * §11.5 cascade: marks BOOKED appointments inside [fromDate, toDate] needs_rebooking in the SAME transaction as the
 * leave row, so a reader never observes a leave without its cascade applied. Cancelling the leave restores them.
 *
 * ═══ FD-7 T8 — AND IT REPORTS THE PEOPLE ALREADY SITTING IN THE WAITING ROOM ═══
 *
 * The cascade has always handled APPOINTMENTS and has never looked at the QUEUE. A doctor who goes
 * on leave in the middle of their duty — the owner's own edge case, 03-Sep — leaves behind live
 * `opd_queue_entries`: people who are physically in the building, hold a printed token, and in a
 * bill-first hospital have already paid. Nothing told anybody they were stranded.
 *
 * `strandedEntryIds` is a REPORT, not a cascade, and the difference is deliberate. Moving a patient
 * to a different doctor without asking them is precisely what `transferQueue`'s consent guard (E2)
 * exists to prevent, and a leave is not a reason to weaken it — the patient chose that doctor, and
 * the choice in front of them is another doctor or coming back tomorrow. So this hands the desk the
 * list, the desk proposes the shortest line, and the clerk asks. The re-seating itself goes through
 * `transferQueue` exactly as a supervisor's transfer does, consent and reason included.
 */
export async function scheduleDoctorLeave(
  db: Db,
  actor: Actor,
  input: { doctorId: string; fromDate: string; toDate: string; reason: string },
  now: Date = new Date(),
): Promise<{ leaveId: string; affectedAppointmentIds: string[]; strandedEntryIds: string[] }> {
  if (actor.type !== "user") throw new OpdError("user_actor_required");
  if (input.reason.trim() === "") throw new OpdError("reason_required", "a doctor leave records why");
  if (input.fromDate > input.toDate) throw new OpdError("invalid_leave_range", "fromDate must be <= toDate");
  if (input.toDate < istDate(now)) throw new OpdError("invalid_leave_range", "toDate is in the past");
  return withTx(db, async (tx) => {
    const doctor = (await tx.select().from(opdDoctors).where(eq(opdDoctors.id, input.doctorId)))[0];
    if (!doctor) throw new OpdError("unknown_doctor");

    const leaveId = newId();
    await tx.insert(opdDoctorLeaves).values({
      id: leaveId, doctorId: input.doctorId, fromDate: input.fromDate, toDate: input.toDate, reason: input.reason,
      status: "scheduled", createdBy: actor.id,
    });

    const affected = await tx
      .update(opdAppointments)
      .set({ status: "needs_rebooking", leaveId, updatedBy: actor.id, updatedAt: now })
      .where(and(
        eq(opdAppointments.doctorId, input.doctorId), eq(opdAppointments.status, "booked"),
        gte(opdAppointments.serviceDate, input.fromDate), lte(opdAppointments.serviceDate, input.toDate),
      ))
      .returning({ id: opdAppointments.id });

    const affectedAppointmentIds = affected.map((a) => a.id).sort();

    /*
     * The live queue inside the leave window. Read INSIDE the same transaction as the leave row, so
     * a caller can never observe the leave without also being able to see who it stranded — the same
     * reason the appointment cascade is in here.
     *
     * `LIVE_ENTRY_STATUSES` is `transferQueue`'s own set, imported rather than re-listed: a queue
     * entry this reports and that refuses to move would be worse than not reporting it.
     */
    const stranded = await tx
      .select({ id: opdQueueEntries.id })
      .from(opdQueueEntries)
      .innerJoin(opdQueueSessions, eq(opdQueueSessions.id, opdQueueEntries.sessionId))
      .where(and(
        eq(opdQueueSessions.doctorId, input.doctorId),
        gte(opdQueueSessions.serviceDate, input.fromDate), lte(opdQueueSessions.serviceDate, input.toDate),
        inArray(opdQueueEntries.status, [...LIVE_ENTRY_STATUSES]),
      ));
    const strandedEntryIds = stranded.map((e) => e.id).sort();

    await appendEvent(tx, doctorLeaveScheduled.make({
      actor,
      payload: {
        leaveId, doctorId: input.doctorId, fromDate: input.fromDate, toDate: input.toDate, reason: input.reason,
        affectedAppointmentIds,
      },
    }));
    return { leaveId, affectedAppointmentIds, strandedEntryIds };
  });
}

/**
 * Conditional cancel, then restore every appointment this leave pushed to needs_rebooking. No event on cancel — no
 * catalog name covers it (disclosed in D9's spirit); the leave row's cancelled_at is the record.
 */
export async function cancelDoctorLeave(db: Db, actor: Actor, leaveId: string, now: Date = new Date()): Promise<{ restored: number }> {
  if (actor.type !== "user") throw new OpdError("user_actor_required");
  return withTx(db, async (tx) => {
    const cancelled = await tx
      .update(opdDoctorLeaves)
      .set({ status: "cancelled", cancelledBy: actor.id, cancelledAt: now })
      .where(and(eq(opdDoctorLeaves.id, leaveId), eq(opdDoctorLeaves.status, "scheduled")))
      .returning();
    if (cancelled.length === 0) throw new OpdError("leave_not_scheduled", `leave ${leaveId} is not scheduled`);

    const restored = await tx
      .update(opdAppointments)
      .set({ status: "booked", leaveId: null, updatedBy: actor.id, updatedAt: now })
      .where(and(eq(opdAppointments.leaveId, leaveId), eq(opdAppointments.status, "needs_rebooking")))
      .returning({ id: opdAppointments.id });
    return { restored: restored.length };
  });
}

export async function listLeaves(
  db: Db,
  filter: { doctorId?: string; from?: string; to?: string; status?: "scheduled" | "cancelled" },
): Promise<LeaveRow[]> {
  const clauses = [
    filter.doctorId === undefined ? undefined : eq(opdDoctorLeaves.doctorId, filter.doctorId),
    filter.from === undefined ? undefined : gte(opdDoctorLeaves.toDate, filter.from),
    filter.to === undefined ? undefined : lte(opdDoctorLeaves.fromDate, filter.to),
    filter.status === undefined ? undefined : eq(opdDoctorLeaves.status, filter.status),
  ].filter((c) => c !== undefined);
  return db.select().from(opdDoctorLeaves).where(clauses.length === 0 ? undefined : and(...clauses)).orderBy(asc(opdDoctorLeaves.fromDate));
}
