import { and, asc, eq, gte, lte } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import { appendEvent } from "../../kernel/events/append";
import { withTx } from "../../kernel/db/client";
import { opdAppointments, opdDoctorLeaves, opdDoctors } from "../../kernel/db/schema";
import { OpdError } from "./errors";
import { doctorLeaveScheduled } from "./events";
import { istDate } from "./time";
import type { Db } from "../../kernel/db/client";

export type LeaveRow = typeof opdDoctorLeaves.$inferSelect;

/**
 * §11.5 cascade: marks BOOKED appointments inside [fromDate, toDate] needs_rebooking in the SAME transaction as the
 * leave row, so a reader never observes a leave without its cascade applied. Cancelling the leave restores them.
 */
export async function scheduleDoctorLeave(
  db: Db,
  actor: Actor,
  input: { doctorId: string; fromDate: string; toDate: string; reason: string },
  now: Date = new Date(),
): Promise<{ leaveId: string; affectedAppointmentIds: string[] }> {
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
    await appendEvent(tx, doctorLeaveScheduled.make({
      actor,
      payload: {
        leaveId, doctorId: input.doctorId, fromDate: input.fromDate, toDate: input.toDate, reason: input.reason,
        affectedAppointmentIds,
      },
    }));
    return { leaveId, affectedAppointmentIds };
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
