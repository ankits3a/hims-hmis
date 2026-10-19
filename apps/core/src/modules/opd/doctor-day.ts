import { and, asc, desc, eq, inArray, lt } from "drizzle-orm";
import { opdDoctors, opdEncounters, opdPrescriptions, opdQueueEntries, opdQueueSessions } from "../../kernel/db/schema";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * DOCTOR DESK DD-0 (#626, plan §4.4) — WHAT OPD TELLS THE DOCTOR DESK, AND NOTHING ABOUT MONEY.
 *
 * Three narrow readers for the Tower. They select no fee, bypass, override or payer column, so a
 * doctor screen built on them cannot show money by construction (decision 0058) — the line is
 * counted from the queue entries the doctor's own queue shows (a tele-call or appointment that was
 * not paid has no token, and so is simply absent).
 */

/** One doctor's OPD line for one IST day: counts only. */
export type DoctorDayLine = {
  userId: string;
  doctorId: string;
  displayName: string;
  /** `opd_queue_sessions.status`, or `none` when the doctor has no session that day. */
  session: "none" | "not_started" | "in" | "out" | "closed";
  /** Every token of the day that was not cancelled or moved to another doctor. */
  booked: number;
  seen: number;
  /** At the vitals bay, waiting for the doctor, or called. */
  waiting: number;
  inConsult: number;
  /** Minutes the longest-waiting token has waited for the doctor, or null when nobody is waiting. */
  longestWaitMinutes: number | null;
};

const WAITING = new Set(["waiting_vitals", "waiting", "called"]);
const NOT_BOOKED = new Set(["cancelled", "transferred"]);

export async function doctorDayLines(
  exec: Db | Tx, userIds: readonly string[], serviceDate: string, now: Date,
): Promise<DoctorDayLine[]> {
  if (userIds.length === 0) return [];
  const doctors = await (exec as Db).select({ id: opdDoctors.id, userId: opdDoctors.userId, displayName: opdDoctors.displayName })
    .from(opdDoctors).where(and(inArray(opdDoctors.userId, [...userIds]), eq(opdDoctors.active, true)));
  if (doctors.length === 0) return [];
  const sessions = await (exec as Db).select({ id: opdQueueSessions.id, doctorId: opdQueueSessions.doctorId, status: opdQueueSessions.status })
    .from(opdQueueSessions)
    .where(and(inArray(opdQueueSessions.doctorId, doctors.map((d) => d.id)), eq(opdQueueSessions.serviceDate, serviceDate)));
  const entries = sessions.length === 0 ? [] : await (exec as Db)
    .select({ sessionId: opdQueueEntries.sessionId, encounterId: opdQueueEntries.encounterId, status: opdQueueEntries.status, eligibleAt: opdQueueEntries.eligibleAt })
    .from(opdQueueEntries).where(inArray(opdQueueEntries.sessionId, sessions.map((s) => s.id)));
  return doctors.map((d): DoctorDayLine => {
    const session = sessions.find((s) => s.doctorId === d.id);
    // A re-entry reuses its token, so a patient is counted once per encounter, by their latest row.
    const byEncounter = new Map<string, (typeof entries)[number]>();
    for (const e of entries.filter((x) => x.sessionId === session?.id)) byEncounter.set(e.encounterId, e);
    const rows = [...byEncounter.values()].filter((e) => !NOT_BOOKED.has(e.status));
    const waitingSince = rows.filter((e) => WAITING.has(e.status) && e.eligibleAt !== null).map((e) => e.eligibleAt!.getTime());
    const oldest = waitingSince.length === 0 ? null : Math.min(...waitingSince);
    return {
      userId: d.userId, doctorId: d.id, displayName: d.displayName,
      session: (session?.status as DoctorDayLine["session"] | undefined) ?? "none",
      booked: rows.length,
      seen: rows.filter((e) => e.status === "done").length,
      waiting: rows.filter((e) => WAITING.has(e.status)).length,
      inConsult: rows.filter((e) => e.status === "in_consult").length,
      longestWaitMinutes: oldest === null ? null : Math.max(0, Math.floor((now.getTime() - oldest) / 60_000)),
    };
  });
}

/** A visit of mine from an earlier day that was never completed — "papers to sign". */
export type OpenVisitRow = { encounterId: string; patientId: string; visitNo: string; serviceDate: string; status: string; startedAt: Date | null };

/** The doctor's visits from IST days before `beforeDate` still `in_consultation` or `awaiting_results`, oldest first. */
export async function openVisitsForDoctor(exec: Db | Tx, userId: string, beforeDate: string): Promise<OpenVisitRow[]> {
  return (exec as Db).select({
    encounterId: opdEncounters.id, patientId: opdEncounters.patientId, visitNo: opdEncounters.visitNo,
    serviceDate: opdEncounters.serviceDate, status: opdEncounters.status, startedAt: opdEncounters.consultStartedAt,
  })
    .from(opdEncounters)
    .innerJoin(opdDoctors, eq(opdDoctors.id, opdEncounters.doctorId))
    .where(and(
      eq(opdDoctors.userId, userId), lt(opdEncounters.serviceDate, beforeDate),
      inArray(opdEncounters.status, ["in_consultation", "awaiting_results"]),
    ))
    .orderBy(asc(opdEncounters.serviceDate), asc(opdEncounters.visitNo));
}

/** Of these visit numbers, the ones whose visit is over (completed or abandoned) — "she has gone home". */
export async function closedVisitNos(exec: Db | Tx, visitNos: readonly string[]): Promise<Set<string>> {
  if (visitNos.length === 0) return new Set();
  const rows = await (exec as Db).select({ visitNo: opdEncounters.visitNo }).from(opdEncounters)
    .where(and(inArray(opdEncounters.visitNo, [...new Set(visitNos)]), inArray(opdEncounters.status, ["completed", "abandoned"])));
  return new Set(rows.map((r) => r.visitNo));
}

/**
 * DD-0.8 — THE DOCTOR'S PACE TODAY, from the queue's own facts: how many were seen (`done` tokens of
 * the day) and when the first consultation of the day started. The Desk divides; nothing is guessed.
 */
export type DoctorPaceToday = { seen: number; firstStartedAt: Date | null };

export async function doctorPaceToday(exec: Db | Tx, userId: string, serviceDate: string): Promise<DoctorPaceToday> {
  const rows = await (exec as Db).select({ status: opdQueueEntries.status, startedAt: opdEncounters.consultStartedAt })
    .from(opdQueueEntries)
    .innerJoin(opdQueueSessions, eq(opdQueueSessions.id, opdQueueEntries.sessionId))
    .innerJoin(opdDoctors, eq(opdDoctors.id, opdQueueSessions.doctorId))
    .innerJoin(opdEncounters, eq(opdEncounters.id, opdQueueEntries.encounterId))
    .where(and(eq(opdDoctors.userId, userId), eq(opdQueueSessions.serviceDate, serviceDate)));
  const starts = rows.map((r) => r.startedAt).filter((d): d is Date => d !== null).map((d) => d.getTime());
  return { seen: rows.filter((r) => r.status === "done").length, firstStartedAt: starts.length === 0 ? null : new Date(Math.min(...starts)) };
}

/** The visit, if it is this doctor's (`opd_encounters.doctor_id` → `opd_doctors.user_id`), else null. */
export async function visitOfDoctor(exec: Db | Tx, userId: string, encounterId: string): Promise<null | {
  id: string; patientId: string; visitNo: string; serviceDate: string; visitType: string;
  deskComplaint: string | null; deskComplaintBy: string | null; deskComplaintAt: Date | null;
}> {
  const row = (await (exec as Db).select({
    id: opdEncounters.id, patientId: opdEncounters.patientId, visitNo: opdEncounters.visitNo, serviceDate: opdEncounters.serviceDate,
    visitType: opdEncounters.visitType, deskComplaint: opdEncounters.deskComplaint, deskComplaintBy: opdEncounters.deskComplaintBy,
    deskComplaintAt: opdEncounters.deskComplaintAt,
  }).from(opdEncounters).innerJoin(opdDoctors, eq(opdDoctors.id, opdEncounters.doctorId))
    .where(and(eq(opdEncounters.id, encounterId), eq(opdDoctors.userId, userId))))[0];
  return row ?? null;
}

/** The patient's earlier OPD visits (before `serviceDate`), newest first: the ordinal and "since you saw him". */
export async function earlierVisits(exec: Db | Tx, patientIds: readonly string[], serviceDate: string): Promise<{ serviceDate: string; doctorUserId: string | null }[]> {
  return (exec as Db).select({ serviceDate: opdEncounters.serviceDate, doctorUserId: opdDoctors.userId })
    .from(opdEncounters).leftJoin(opdDoctors, eq(opdDoctors.id, opdEncounters.doctorId))
    .where(and(inArray(opdEncounters.patientId, [...patientIds]), eq(opdEncounters.type, "opd"), lt(opdEncounters.serviceDate, serviceDate),
      inArray(opdEncounters.status, ["completed", "awaiting_results", "in_consultation"])))
    .orderBy(desc(opdEncounters.serviceDate));
}

/** "He is on": the last prescription this doctor issued for this patient before `serviceDate`. */
export async function lastPrescriptionBy(exec: Db | Tx, userId: string, patientIds: readonly string[], serviceDate: string): Promise<null | { issuedAt: Date; lines: unknown }> {
  const row = (await (exec as Db).select({ issuedAt: opdPrescriptions.issuedAt, lines: opdPrescriptions.lines })
    .from(opdPrescriptions).innerJoin(opdEncounters, eq(opdEncounters.id, opdPrescriptions.encounterId))
    .where(and(inArray(opdPrescriptions.patientId, [...patientIds]), eq(opdPrescriptions.issuedBy, userId), eq(opdPrescriptions.status, "active"), lt(opdEncounters.serviceDate, serviceDate)))
    .orderBy(desc(opdPrescriptions.issuedAt)).limit(1))[0];
  return row ?? null;
}

/**
 * DOCTOR DESK DD-1.7 — visits these doctors FINISHED on these IST days: the work a senior may rate.
 * No fee column, as every reader here.
 */
export type CompletedVisitRow = { encounterId: string; patientId: string; visitNo: string; serviceDate: string; userId: string; completedAt: Date | null };

export async function completedVisitsOf(exec: Db | Tx, userIds: readonly string[], serviceDates: readonly string[]): Promise<CompletedVisitRow[]> {
  if (userIds.length === 0 || serviceDates.length === 0) return [];
  const rows = await (exec as Db).select({
    encounterId: opdEncounters.id, patientId: opdEncounters.patientId, visitNo: opdEncounters.visitNo,
    serviceDate: opdEncounters.serviceDate, userId: opdDoctors.userId, completedAt: opdEncounters.consultCompletedAt,
  })
    .from(opdEncounters)
    .innerJoin(opdDoctors, eq(opdDoctors.id, opdEncounters.doctorId))
    .where(and(inArray(opdDoctors.userId, [...userIds]), inArray(opdEncounters.serviceDate, [...serviceDates]), eq(opdEncounters.status, "completed")))
    .orderBy(desc(opdEncounters.serviceDate), desc(opdEncounters.consultCompletedAt));
  return rows.filter((r): r is CompletedVisitRow => r.userId !== null);
}

/** One finished visit by id, whoever's it is — the rating act re-checks the doctor's unit itself. */
export async function completedVisitById(exec: Db | Tx, encounterId: string): Promise<CompletedVisitRow | null> {
  const row = (await (exec as Db).select({
    encounterId: opdEncounters.id, patientId: opdEncounters.patientId, visitNo: opdEncounters.visitNo,
    serviceDate: opdEncounters.serviceDate, userId: opdDoctors.userId, completedAt: opdEncounters.consultCompletedAt,
  })
    .from(opdEncounters)
    .innerJoin(opdDoctors, eq(opdDoctors.id, opdEncounters.doctorId))
    .where(and(eq(opdEncounters.id, encounterId), eq(opdEncounters.status, "completed"))))[0];
  return row === undefined || row.userId === null ? null : (row as CompletedVisitRow);
}
