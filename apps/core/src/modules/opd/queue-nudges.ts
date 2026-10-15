import { and, eq, inArray, isNotNull, ne } from "drizzle-orm";
import { opdDoctors, opdQueueEntries, opdQueueSessions } from "../../kernel/db/schema/opd";
import { noticeHistory, raiseNotice } from "../../kernel/alerts/notices";
import { istDate } from "./time";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ MOBILE §3i (owner 2026-10-07) — "PATIENTS ARE WAITING AND YOU ARE NOT IN" ═══
 *
 * The doctor's line on the phone (M3) shows who is waiting — to a doctor who is looking at it. This
 * is for the one who is not: a patient is READY (vitals done, `waiting`) and the doctor's day is
 * `not_started` or `out`. Until now the only person who knew was the patient.
 *
 * TWO NOTICES, BOTH ABOUT COUNTS AND MINUTES. No token, no name, no UHID: the row is a per-user
 * surface (GC6) and the phone is told a fixed sentence regardless.
 *
 *  · `opd_not_in` — somebody has been ready for `NOT_IN_AFTER_MIN` and the doctor is not in. Repeats
 *    at most every `NOT_IN_REPEAT_MIN`, at most `NOT_IN_MAX_PER_DAY` times, and STOPS the moment
 *    the doctor steps in (the predicate is read every tick; nothing has to be cancelled).
 *  · `opd_long_wait` — somebody has been ready longer than `LONG_WAIT_MIN`. Once per doctor-day:
 *    the doctor in the room already sees the red number on the line; this is the one buzz that says
 *    it crossed.
 *
 * DECIDED (owner's delegation): 10 / 20 / 40 minutes, six repeats. A doctor on leave whose line was
 * never moved hears six and then silence — the supervisor's desk owns that day, not a seventh buzz.
 */
export const OPD_NOT_IN_KIND = "opd_not_in";
export const OPD_LONG_WAIT_KIND = "opd_long_wait";
export const OPD_QUEUE_REF_TYPE = "opd_queue_session";
export const NOT_IN_AFTER_MIN = 10;
export const NOT_IN_REPEAT_MIN = 20;
export const NOT_IN_MAX_PER_DAY = 6;
export const LONG_WAIT_MIN = 40;
const MIN = 60_000;

export type QueueNudge = {
  kind: typeof OPD_NOT_IN_KIND | typeof OPD_LONG_WAIT_KIND;
  sessionId: string; userId: string;
  /** How many are ready (not_in), or how many have waited past the line (long_wait). */
  count: number;
  /** The longest ready wait, whole minutes. */
  longestMin: number;
};

/** What today's doctor-days warrant at `now` — before pacing. Pure of history, so it is the testable rule. */
export async function queueNudgesAt(db: Db, now: Date): Promise<QueueNudge[]> {
  const sessions = await db.select({ id: opdQueueSessions.id, status: opdQueueSessions.status, userId: opdDoctors.userId })
    .from(opdQueueSessions).innerJoin(opdDoctors, eq(opdDoctors.id, opdQueueSessions.doctorId))
    .where(and(eq(opdQueueSessions.serviceDate, istDate(now)), ne(opdQueueSessions.status, "closed")));
  if (sessions.length === 0) return [];
  const ready = await db.select({ sessionId: opdQueueEntries.sessionId, eligibleAt: opdQueueEntries.eligibleAt }).from(opdQueueEntries)
    .where(and(inArray(opdQueueEntries.sessionId, sessions.map((s) => s.id)), eq(opdQueueEntries.status, "waiting"), isNotNull(opdQueueEntries.eligibleAt)));
  const out: QueueNudge[] = [];
  for (const s of sessions) {
    const waits = ready.filter((r) => r.sessionId === s.id && r.eligibleAt !== null).map((r) => Math.floor((now.getTime() - r.eligibleAt!.getTime()) / MIN));
    if (waits.length === 0) continue;
    const longestMin = Math.max(...waits);
    const notIn = s.status === "not_started" || s.status === "out";
    if (notIn && longestMin >= NOT_IN_AFTER_MIN) out.push({ kind: OPD_NOT_IN_KIND, sessionId: s.id, userId: s.userId, count: waits.length, longestMin });
    const long = waits.filter((w) => w >= LONG_WAIT_MIN).length;
    if (long > 0) out.push({ kind: OPD_LONG_WAIT_KIND, sessionId: s.id, userId: s.userId, count: long, longestMin });
  }
  return out;
}

/** The clock's half: pace what `queueNudgesAt` found against what this doctor was already told today. Returns how many were new. */
export async function sweepQueueNudges(db: Db, now: Date = new Date()): Promise<number> {
  let raised = 0;
  for (const n of await queueNudgesAt(db, now)) {
    const dayStart = new Date(now.getTime() - 18 * 60 * MIN); // a doctor-day is one IST date; eighteen hours covers it and no other
    const people = n.count === 1 ? "1 patient is" : `${n.count} patients are`;
    if (n.kind === OPD_LONG_WAIT_KIND) {
      const won = await raiseNotice(db, {
        userId: n.userId, kind: n.kind, refType: OPD_QUEUE_REF_TYPE, refId: n.sessionId,
        title: `${n.count === 1 ? "A patient has" : `${n.count} patients have`} waited over ${LONG_WAIT_MIN} minutes`,
        body: `The longest wait in your OPD line is ${n.longestMin} min. Open your queue.`,
        sourceKey: `opd-long-wait:${n.sessionId}`, at: now,
      });
      if (won) raised += 1;
      continue;
    }
    const h = await noticeHistory(db, n.userId, n.kind, n.sessionId, dayStart);
    if (h.count >= NOT_IN_MAX_PER_DAY) continue;
    if (h.lastAt !== null && now.getTime() - h.lastAt.getTime() < NOT_IN_REPEAT_MIN * MIN) continue;
    const won = await raiseNotice(db, {
      userId: n.userId, kind: n.kind, refType: OPD_QUEUE_REF_TYPE, refId: n.sessionId,
      title: "Patients are waiting and you are not in",
      body: `${people} ready in your OPD line; the first has waited ${n.longestMin} min. Step in, or tell the desk.`,
      // The minute is in the key so a repeat is a NEW row; the pacing above is what keeps repeats apart.
      sourceKey: `opd-not-in:${n.sessionId}:${Math.floor(now.getTime() / MIN)}`, at: now,
    });
    if (won) raised += 1;
  }
  return raised;
}
