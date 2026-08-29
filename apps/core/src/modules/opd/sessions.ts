import { and, count, eq, isNull, lte, or, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import { opdDoctorSchedules, opdEncounters, opdQueueSessions } from "../../kernel/db/schema";
import { appendEvent } from "../../kernel/events/append";
import { OpdError } from "./errors";
import { queueSessionClosed, queueSessionOpened } from "./events";
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

/**
 * PLAN 07c T6 — the schedule's own start time for a doctor-day, or null when it is unscheduled.
 *
 * It rides the OPENED event so a consumer can say "forty minutes late" without a second query, and
 * it is deliberately null rather than a default when there is no template: an unscheduled doctor
 * cannot be late, and inventing a start time would manufacture a lateness figure out of nothing —
 * DD8's rule about baselines, one module over.
 */
async function scheduledStartFor(tx: Tx, doctorId: string, serviceDate: string): Promise<string | null> {
  const weekday = istWeekday(serviceDate);
  const rows = await tx
    .select({ startTime: opdDoctorSchedules.startTime })
    .from(opdDoctorSchedules)
    .where(and(
      eq(opdDoctorSchedules.doctorId, doctorId), eq(opdDoctorSchedules.active, true), eq(opdDoctorSchedules.weekday, weekday),
      lte(opdDoctorSchedules.validFrom, serviceDate),
      or(isNull(opdDoctorSchedules.validTo), sql`${opdDoctorSchedules.validTo} >= ${serviceDate}`),
    ));
  if (rows.length === 0) return null;
  return [...rows].sort((a, b) => (a.startTime < b.startTime ? -1 : 1))[0]!.startTime;
}

/**
 * PLAN 07c T6 — THE DOCTOR-DAY'S STATUS, NOW WITH AN ACTOR AND AN EVENT.
 *
 * This has always been the ONLY writer of `opd_queue_sessions.status`, and until this task it
 * stamped WHEN and never WHO and appended nothing at all. Two consequences, and the second is the
 * expensive one:
 *
 *   1. "Who opened Dr Rao's queue this morning" was unanswerable from any table.
 *   2. **A session that never opened raised nothing.** Every other alarm in the hall is driven by
 *      somebody waiting, and nobody waits on a queue that does not exist yet — so the most useful
 *      signal a supervisor's desk can carry, a doctor-day that is late with no delay declared, had
 *      no fact to be computed from.
 *
 * The stamp is IDEMPOTENT with respect to opening: `openedBy` is written once, on the first
 * transition into `in`, and an `in → out → in` day does not rewrite it. The person who opened the
 * queue is a fact about the morning, not about the most recent time somebody came back from lunch.
 */
export async function setSessionStatus(tx: Tx, actor: Actor, sessionId: string, status: Exclude<SessionStatus, "not_started">, now: Date = new Date()): Promise<SessionRow> {
  if (actor.type !== "user") throw new OpdError("user_actor_required");
  const rows = await tx.select().from(opdQueueSessions).where(eq(opdQueueSessions.id, sessionId));
  const s = rows[0];
  if (!s) throw new OpdError("unknown_session");
  if (s.status === "closed") throw new OpdError("session_closed");
  const firstOpen = status === "in" && s.openedAt === null;
  const updated = await tx
    .update(opdQueueSessions)
    .set({
      status,
      openedAt: s.openedAt ?? (status === "in" ? now : null),
      closedAt: status === "closed" ? now : null,
      openedBy: s.openedBy ?? (firstOpen ? actor.id : null),
      closedBy: status === "closed" ? actor.id : null,
    })
    .where(and(eq(opdQueueSessions.id, sessionId), eq(opdQueueSessions.status, s.status)))
    .returning();
  if (updated.length === 0) throw new OpdError("session_closed", "session moved concurrently");
  const row = updated[0]!;

  /*
   * APPENDED IN THE SAME TRANSACTION as the status write, and AFTER the compare-and-set above — so
   * a losing concurrent caller has already thrown and cannot emit an event for a move it did not
   * make. An `in → out → in` day emits ONE `opened`, matching the column.
   */
  if (firstOpen) {
    await appendEvent(tx, queueSessionOpened.make({
      actor,
      payload: {
        sessionId: row.id, doctorId: row.doctorId, serviceDate: row.serviceDate, roomId: row.roomId,
        openedAt: (row.openedAt ?? now).toISOString(),
        scheduledStart: await scheduledStartFor(tx, row.doctorId, row.serviceDate),
      },
    }));
  }
  if (status === "closed") {
    const seen = await tx
      .select({ n: count() })
      .from(opdEncounters)
      .where(and(
        eq(opdEncounters.doctorId, row.doctorId),
        eq(opdEncounters.serviceDate, row.serviceDate),
        eq(opdEncounters.status, "completed"),
      ));
    await appendEvent(tx, queueSessionClosed.make({
      actor,
      payload: {
        sessionId: row.id, doctorId: row.doctorId, serviceDate: row.serviceDate, roomId: row.roomId,
        closedAt: (row.closedAt ?? now).toISOString(), seen: seen[0]?.n ?? 0,
      },
    }));
  }
  return row;
}
