import { and, eq, isNull, lte, or, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import { opdDoctorSchedules, opdQueueSessions } from "../../kernel/db/schema";
import { OpdError } from "./errors";
import { istWeekday } from "./time";
import type { Tx } from "../../kernel/db/client";

export type SessionRow = typeof opdQueueSessions.$inferSelect;
export type SessionStatus = "not_started" | "in" | "out" | "closed";

/** The room of the doctor's first active template for that IST date (null when unscheduled — walk-ins are still allowed). */
export async function roomForDoctorDay(tx: Tx, doctorId: string, serviceDate: string): Promise<string | null> {
  const weekday = istWeekday(serviceDate);
  const rows = await tx
    .select({ roomId: opdDoctorSchedules.roomId, startTime: opdDoctorSchedules.startTime })
    .from(opdDoctorSchedules)
    .where(and(
      eq(opdDoctorSchedules.doctorId, doctorId), eq(opdDoctorSchedules.active, true), eq(opdDoctorSchedules.weekday, weekday),
      lte(opdDoctorSchedules.validFrom, serviceDate),
      or(isNull(opdDoctorSchedules.validTo), sql`${opdDoctorSchedules.validTo} >= ${serviceDate}`),
    ));
  if (rows.length === 0) return null;
  return [...rows].sort((a, b) => (a.startTime < b.startTime ? -1 : 1))[0]!.roomId;
}

/** Lazily creates the doctor-day row; the (doctor_id, service_date) unique index makes concurrent creators converge on one row. */
export async function getOrCreateSession(tx: Tx, doctorId: string, serviceDate: string, roomId: string | null): Promise<SessionRow> {
  await tx.insert(opdQueueSessions).values({ id: newId(), doctorId, serviceDate, roomId }).onConflictDoNothing();
  const rows = await tx.select().from(opdQueueSessions).where(and(eq(opdQueueSessions.doctorId, doctorId), eq(opdQueueSessions.serviceDate, serviceDate)));
  return rows[0]!;
}

/** Atomic counter — never read-then-write. Gaps are fine (a rolled-back visit skips a number); order is what matters. */
export async function allocateToken(tx: Tx, sessionId: string): Promise<number> {
  const rows = await tx
    .update(opdQueueSessions)
    .set({ nextToken: sql`${opdQueueSessions.nextToken} + 1` })
    .where(eq(opdQueueSessions.id, sessionId))
    .returning({ next: opdQueueSessions.nextToken });
  if (rows.length === 0) throw new OpdError("unknown_session");
  return rows[0]!.next - 1;
}

export async function setSessionStatus(tx: Tx, actor: Actor, sessionId: string, status: Exclude<SessionStatus, "not_started">, now: Date = new Date()): Promise<SessionRow> {
  if (actor.type !== "user") throw new OpdError("user_actor_required");
  const rows = await tx.select().from(opdQueueSessions).where(eq(opdQueueSessions.id, sessionId));
  const s = rows[0];
  if (!s) throw new OpdError("unknown_session");
  if (s.status === "closed") throw new OpdError("session_closed");
  const updated = await tx
    .update(opdQueueSessions)
    .set({ status, openedAt: s.openedAt ?? (status === "in" ? now : null), closedAt: status === "closed" ? now : null })
    .where(and(eq(opdQueueSessions.id, sessionId), eq(opdQueueSessions.status, s.status)))
    .returning();
  if (updated.length === 0) throw new OpdError("session_closed", "session moved concurrently");
  return updated[0]!;
}
