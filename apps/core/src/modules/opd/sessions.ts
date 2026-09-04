import { and, count, eq, isNull, lte, or, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import { opdDoctorSchedules, opdEncounters, opdQueueSessions, opdDepartmentTokens,
} from "../../kernel/db/schema";
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
/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * FD-20 — ONE SERIES PER DEPARTMENT PER DAY, because that is what a patient is holding
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Owner, 2026-09-04: *"the token number should be not according to the doctor but Department. For
 * Example it should be 'MED - 4', 'PED - 290'."*
 *
 * This counted per SESSION, and a session is a doctor-day — so three doctors sitting in Medicine
 * each issued a token 1, and the hall heard "number four" called three times for three different
 * people. The slip in a patient's hand did not identify them. The counter moves to where the series
 * actually is; `opd_departments.code` supplies the prefix it was written for.
 *
 * THE UPSERT IS THE LOCK. `INSERT … ON CONFLICT DO UPDATE SET next_token = next_token + 1
 * RETURNING` takes the row lock on conflict, so two counters registering the same department at the
 * same instant serialise on it and cannot hand out one number twice — the same property the
 * per-session `UPDATE … RETURNING` had, and the reason both return the POST-increment minus one
 * rather than reading and then writing (`billing/series.ts` cites this function for exactly that).
 *
 * The first patient of a day inserts the row and takes 1; every later one hits the conflict.
 */
export async function allocateToken(tx: Tx, departmentId: string, serviceDate: string): Promise<number> {
  /*
    ═══ FD-23 CLOSE REVIEW — THE SEED, BECAUSE A NEW SERIES MEETS A DAY ALREADY IN PROGRESS ═══

    The insert branch used to store a flat 2, meaning "1 was taken". That is right on any day this
    table has always existed, and WRONG on exactly one day: the morning the department series is
    deployed. Until that deploy the numbers came from `opd_queue_sessions.next_token`, a doctor-day
    counter — so a department can already have handed out 1..5 that morning, on slips patients are
    physically holding, printed with the same `MED-n` label this series mints. Starting at 1 hands
    the next walk-in a number somebody is already standing in the hall with, and
    `opd_queue_entries` carries no unique index on `(session_id, token_no)` to refuse it.

    So the insert branch SEEDS from the day's own high-water mark instead of assuming one. The
    aggregate runs over zero rows on an ordinary day — `max()` of nothing is NULL, `coalesce` makes
    it 0, and the first patient still takes 1, which is why this is not a special case with a
    branch but the same statement stated properly.

    THE LOCK IS UNCHANGED and it is the whole point of the shape: `INSERT … ON CONFLICT DO UPDATE …
    RETURNING` takes the row lock on conflict, so two counters registering the same department at
    the same instant serialise on it. Two concurrent FIRST inserts are safe for the same reason —
    one wins with the seeded value, the other conflicts and increments off the row that landed.
  */
  /*
    THE FAST PATH IS THE ONLY PATH MOST PATIENTS TAKE, so it stays a single upsert and nothing else.

    The first draft of this fix wrote the seed as `INSERT … SELECT max(token_no) … ON CONFLICT DO
    UPDATE`, which is wrong for a reason Postgres does not warn about: **the SELECT is evaluated to
    build the candidate row on EVERY call, conflict or not.** That put an aggregate over the day's
    queue entries — joined to `opd_encounters`, 200 000 rows deep in the perf fixture — in front of
    every token this hospital issues, and `test/perf-opd-queue.test.ts` caught it in CI at 107 ms
    against a 100 ms budget. Measured, not guessed.

    `xmax = 0` is the standard "this row was INSERTed, not UPDATEd" test on an upsert's RETURNING.
    The seed lookup therefore runs once per department per DAY — the only moment it can matter — and
    every patient after the first pays exactly what they paid before this fix existed.
  */
  const res = await tx.execute(sql`
    insert into opd_department_tokens (department_id, service_date, next_token)
    values (${departmentId}, ${serviceDate}, 2)
    on conflict (department_id, service_date)
      do update set next_token = opd_department_tokens.next_token + 1
    returning next_token, (xmax = 0) as inserted
  `);
  const row = res.rows[0]!;
  const next = Number(row.next_token);
  if (!Number.isSafeInteger(next) || next < 2) {
    throw new Error(`opd_department_tokens returned unusable next_token: ${String(row.next_token)}`);
  }
  // The conflict branch — every patient but the day's first in this department. Nothing to seed.
  if (row.inserted !== true) return next - 1;

  /*
    THE DAY'S FIRST TOKEN IN THIS DEPARTMENT, and the only place the cut-over can bite: until FD-20
    deployed, the numbers came from `opd_queue_sessions.next_token`, a DOCTOR-day counter. A
    department can therefore already have handed out 1..5 this morning, on slips patients are
    holding, printed with the same `MED-n` label this series mints — and `opd_queue_entries` has no
    unique index on `(session_id, token_no)` to refuse a repeat.

    SAFE UNDER CONCURRENCY because this runs inside the caller's transaction and the upsert above
    already took the row lock: a second counter registering the same department blocks on that lock
    until this transaction commits, so it increments off the CORRECTED value and never off the 2.
  */
  const high = await tx.execute(sql`
    select coalesce(max(q.token_no), 0) as hi
      from opd_queue_entries q
      join opd_encounters e on e.id = q.encounter_id
     where e.department_id = ${departmentId} and e.service_date = ${serviceDate}
  `);
  const hi = Number(high.rows[0]!.hi);
  if (!Number.isSafeInteger(hi) || hi < 1) return next - 1; // an ordinary day: nothing issued yet, take 1

  await tx
    .update(opdDepartmentTokens)
    .set({ nextToken: hi + 2 })
    .where(and(eq(opdDepartmentTokens.departmentId, departmentId), eq(opdDepartmentTokens.serviceDate, serviceDate)));
  return hi + 1;
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
