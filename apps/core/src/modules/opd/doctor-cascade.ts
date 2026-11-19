import { and, eq, gte, inArray } from "drizzle-orm";
import { opdAppointments, opdQueueEntries, opdQueueSessions } from "../../kernel/db/schema";
import { LIVE_ENTRY_STATUSES } from "./encounters";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * #1127 (owner 2026-11-19) — what a doctor-master change strands, shared by the change itself
 * (`masters.ts` `updateDoctor`) and the check the admin sees before it (`doctor-admin.ts`), so the
 * screen's preview and the cascade can never count different rows.
 *
 * Deactivating strands every BOOKED appointment of the doctor from today on; a department change
 * strands only those in the department being left (the second department's bookings stay). They go
 * to `needs_rebooking`, the leave cascade's rule (leaves.ts): nobody is moved to another doctor
 * without being asked. The live queue is a REPORT, as in a leave — the desk asks those patients.
 */
type Exec = Db | Tx;

export function strandedBookings(doctorId: string, today: string, departmentId?: string) {
  return and(
    eq(opdAppointments.doctorId, doctorId), eq(opdAppointments.status, "booked"), gte(opdAppointments.serviceDate, today),
    departmentId === undefined ? undefined : eq(opdAppointments.departmentId, departmentId),
  );
}

/** Patients in the doctor's queue today who have not been seen (`transferQueue`'s live set). */
export async function waitingTodayFor(exec: Exec, doctorId: string, today: string): Promise<number> {
  const rows = await exec.select({ id: opdQueueEntries.id }).from(opdQueueEntries)
    .innerJoin(opdQueueSessions, eq(opdQueueSessions.id, opdQueueEntries.sessionId))
    .where(and(
      eq(opdQueueSessions.doctorId, doctorId), eq(opdQueueSessions.serviceDate, today),
      inArray(opdQueueEntries.status, [...LIVE_ENTRY_STATUSES]),
    ));
  return rows.length;
}
