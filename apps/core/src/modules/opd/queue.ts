import { and, asc, desc, eq, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import type { Actor } from "@hmis/contracts";
import { appendEvent } from "../../kernel/events/append";
import { withTx } from "../../kernel/db/client";
import {
  opdDepartments, opdDoctorSchedules, opdDoctors, opdEncounters, opdQueueEntries, opdQueueSessions, opdRooms,
} from "../../kernel/db/schema";
import { getPatientSummaries } from "../patients";
import { loadOpdConfig } from "./config";
import { getEncounter } from "./encounters";
import { OpdError } from "./errors";
import { queueCalled, queueSkipped } from "./events";
import { classOf, nextInQueue, orderQueue } from "./queue-engine";
import { istWeekday } from "./time";
import type { OpdConfig } from "./config";
import type { EncounterRow, QueueEntryRow } from "./encounters";
import type { DoctorRow } from "./masters";
import type { QueueClass, QueueEntryState } from "./queue-engine";
import type { SessionRow, SessionStatus } from "./sessions";
import type { PatientSummary } from "../patients";
import type { Db, Tx } from "../../kernel/db/client";

/** Entry statuses that still occupy the doctor's day. */
const LIVE_ENTRY_STATUSES = ["waiting_vitals", "waiting", "called", "in_consult"] as const;
/** How many upcoming tokens a public board shows. */
const BOARD_NEXT = 5;

/** The row → the engine's pure view. eligible_at is only set when the row becomes 'waiting'; before that arrival order stands in. */
function toState(row: QueueEntryRow): QueueEntryState {
  return {
    id: row.id, tokenNo: row.tokenNo, kind: row.kind === "appointment" ? "appointment" : "walk_in",
    appointmentAt: row.appointmentAt, eligibleAt: row.eligibleAt ?? row.createdAt, seq: row.seq,
    danger: row.danger, reEntry: row.reEntry, perk: row.perk, skips: row.skips,
  };
}

/** What every read surface needs from one session's live rows: who is being served, who is next, how many wait. */
function summarise(entries: QueueEntryRow[], callsMade: number, cfg: OpdConfig, now: Date): { nowServing: number | null; next: number[]; waitingCount: number } {
  const waiting = entries.filter((r) => r.status === "waiting");
  const ordered = orderQueue(waiting.map(toState), now, { perkEveryNth: cfg.perkEveryNth }, callsMade);
  const serving = entries.find((r) => r.status === "called") ?? entries.find((r) => r.status === "in_consult");
  return { nowServing: serving?.tokenNo ?? null, next: ordered.slice(0, BOARD_NEXT).map((x) => x.tokenNo), waitingCount: waiting.length };
}

export type QueueEntryView = QueueEntryRow & {
  position: number | null; queueClass: QueueClass | null;
  encounter: { id: string; patientId: string; visitType: string; dangerFlagged: boolean; status: string };
  patient: PatientSummary | null;
};
export type QueueView = {
  session: SessionRow; doctor: DoctorRow; ordered: QueueEntryView[]; current: QueueEntryView | null; inConsult: QueueEntryView[];
  waitingVitals: number; counts: { waiting: number; called: number; inConsult: number; done: number; left: number };
};

/** The doctor-day queue as the desk and the consultation screen read it: the engine's order, with the facts each row needs. */
export async function listQueue(db: Db, actor: Actor, doctorId: string, serviceDate: string, now: Date = new Date()): Promise<QueueView | null> {
  const cfg = await loadOpdConfig(db);
  const doctor = (await db.select().from(opdDoctors).where(eq(opdDoctors.id, doctorId)))[0];
  if (!doctor) throw new OpdError("unknown_doctor", `unknown doctor ${doctorId}`);
  const session = (await db
    .select().from(opdQueueSessions)
    .where(and(eq(opdQueueSessions.doctorId, doctorId), eq(opdQueueSessions.serviceDate, serviceDate))))[0];
  if (!session) return null;

  const rows = await db.select().from(opdQueueEntries).where(eq(opdQueueEntries.sessionId, session.id)).orderBy(asc(opdQueueEntries.seq));
  const encounterIds = rows.map((r) => r.encounterId);
  const encounters = encounterIds.length === 0 ? [] : await db.select().from(opdEncounters).where(inArray(opdEncounters.id, encounterIds));
  const encounterById = new Map(encounters.map((e) => [e.id, e] as const));
  // Demographics come from the patients module — the OPD module reads no patient table (spec §4).
  const summaries = await getPatientSummaries(db, actor, encounters.map((e) => e.patientId));
  const summaryByPatient = new Map(summaries.map((s) => [s.requestedId, s] as const));

  const toView = (row: QueueEntryRow, position: number | null, queueClass: QueueClass | null): QueueEntryView => {
    const encounter = encounterById.get(row.encounterId)!;
    return {
      ...row, position, queueClass,
      encounter: {
        id: encounter.id, patientId: encounter.patientId, visitType: encounter.visitType,
        dangerFlagged: encounter.dangerFlagged, status: encounter.status,
      },
      patient: summaryByPatient.get(encounter.patientId) ?? null,
    };
  };

  const byId = new Map(rows.map((r) => [r.id, r] as const));
  const ordered = orderQueue(rows.filter((r) => r.status === "waiting").map(toState), now, { perkEveryNth: cfg.perkEveryNth }, session.callsMade)
    .map((state, i) => toView(byId.get(state.id)!, i + 1, classOf(state, now)));
  const called = rows.find((r) => r.status === "called");
  const count = (status: string): number => rows.filter((r) => r.status === status).length;
  return {
    session, doctor, ordered,
    current: called === undefined ? null : toView(called, null, null),
    inConsult: rows.filter((r) => r.status === "in_consult").map((r) => toView(r, null, null)),
    waitingVitals: count("waiting_vitals"),
    counts: { waiting: count("waiting"), called: count("called"), inConsult: count("in_consult"), done: count("done"), left: count("left") },
  };
}

/**
 * §11.1 call. One transaction, serialized per session: two "call next" clicks at nearly the same instant may compute
 * DIFFERENT heads (an appointment crossing its due time between their clocks), which the status belt below cannot
 * catch — so the session row (a row OUTSIDE the entry's own write path) is locked first and makes the pre-check
 * authoritative. Every loser, whichever way the interleaving falls, gets the SAME code: call_conflict.
 */
export async function callNext(db: Db, actor: Actor, sessionId: string, now: Date = new Date()): Promise<{ entry: QueueEntryRow | null; encounter: EncounterRow | null }> {
  return withTx(db, async (tx) => {
    const cfg = await loadOpdConfig(tx);
    // Serialize callers per session: two "call next" clicks at nearly the same instant may compute DIFFERENT heads
    // (an appointment crossing its due time between their clocks); the row lock makes the pre-check below authoritative.
    const sRows = await tx.select().from(opdQueueSessions).where(eq(opdQueueSessions.id, sessionId)).for("update");
    const session = sRows[0];
    if (!session) throw new OpdError("unknown_session");
    if (session.status === "closed") throw new OpdError("session_closed");
    if (session.status === "out") throw new OpdError("doctor_out");
    const live = await tx.select().from(opdQueueEntries).where(and(eq(opdQueueEntries.sessionId, sessionId), inArray(opdQueueEntries.status, ["waiting", "called"])));
    if (live.some((r) => r.status === "called")) throw new OpdError("call_conflict", "a token is already called — start or skip it first");
    const head = nextInQueue(live.filter((r) => r.status === "waiting").map(toState), now, { perkEveryNth: cfg.perkEveryNth }, session.callsMade);
    if (!head) return { entry: null, encounter: null };
    const updated = await tx.update(opdQueueEntries)
      .set({ status: "called", calledAt: now, callCount: sql`${opdQueueEntries.callCount} + 1` })
      .where(and(eq(opdQueueEntries.id, head.id), eq(opdQueueEntries.status, "waiting"))).returning();
    if (updated.length === 0) throw new OpdError("call_conflict", "entry moved concurrently"); // belt — the SAME code as the pre-check
    await tx.update(opdQueueSessions)
      .set({ callsMade: sql`${opdQueueSessions.callsMade} + 1`, status: session.status === "not_started" ? "in" : session.status, openedAt: session.openedAt ?? now })
      .where(eq(opdQueueSessions.id, sessionId));
    const encounter = (await getEncounter(tx, updated[0]!.encounterId))!;
    await appendEvent(tx, queueCalled.make({ actor, patientId: encounter.patientId, encounterId: encounter.id, correlationId: encounter.workflowInstanceId, payload: {
      encounterId: encounter.id, patientId: encounter.patientId, entryId: updated[0]!.id, doctorId: session.doctorId, serviceDate: session.serviceDate,
      sessionId, roomId: session.roomId, tokenNo: updated[0]!.tokenNo, callCount: updated[0]!.callCount,
    } }));
    return { entry: updated[0]!, encounter };
  });
}

/**
 * The called patient did not come: back to waiting with eligible_at = now (they lose their place, never their token),
 * or out of the queue once max_skips_before_left is reached.
 */
export async function skipCalled(db: Db, actor: Actor, entryId: string, now: Date = new Date()): Promise<{ entry: QueueEntryRow }> {
  return withTx(db, async (tx) => {
    const cfg = await loadOpdConfig(tx);
    const current = (await tx.select().from(opdQueueEntries).where(eq(opdQueueEntries.id, entryId)))[0];
    if (!current) throw new OpdError("unknown_queue_entry", `unknown queue entry ${entryId}`);
    if (current.status !== "called") throw new OpdError("queue_entry_state_conflict", `a skip needs a called entry, not ${current.status}`);
    const skips = current.skips + 1;
    const left = skips >= cfg.maxSkipsBeforeLeft;
    const updated = await tx.update(opdQueueEntries)
      .set({ status: left ? "left" : "waiting", skips, eligibleAt: left ? current.eligibleAt : now })
      .where(and(eq(opdQueueEntries.id, entryId), eq(opdQueueEntries.status, "called"))).returning();
    if (updated.length === 0) throw new OpdError("queue_entry_state_conflict", "entry moved concurrently");
    const entry = updated[0]!;
    const session = (await tx.select().from(opdQueueSessions).where(eq(opdQueueSessions.id, entry.sessionId)))[0]!;
    const encounter = (await getEncounter(tx, entry.encounterId))!;
    await appendEvent(tx, queueSkipped.make({ actor, patientId: encounter.patientId, encounterId: encounter.id, correlationId: encounter.workflowInstanceId, payload: {
      encounterId: encounter.id, patientId: encounter.patientId, entryId: entry.id, doctorId: session.doctorId, serviceDate: session.serviceDate,
      sessionId: session.id, roomId: session.roomId, tokenNo: entry.tokenNo, skips, left,
    } }));
    return { entry };
  });
}

/** called | waiting → in_consult (a doctor may take a patient without calling). T7's startConsultation owns the encounter move. */
export async function markInConsult(tx: Tx, encounterId: string, now: Date): Promise<QueueEntryRow> {
  const current = (await tx
    .select().from(opdQueueEntries).where(eq(opdQueueEntries.encounterId, encounterId))
    .orderBy(desc(opdQueueEntries.seq)).limit(1))[0];
  if (!current) throw new OpdError("unknown_queue_entry", `no queue entry for encounter ${encounterId}`);
  if (current.status !== "called" && current.status !== "waiting") {
    throw new OpdError("queue_entry_state_conflict", `a consultation starts from called or waiting, not ${current.status}`);
  }
  const updated = await tx.update(opdQueueEntries)
    .set({ status: "in_consult", calledAt: current.calledAt ?? now }) // never called: the doctor took them at `now`
    .where(and(eq(opdQueueEntries.id, current.id), eq(opdQueueEntries.status, current.status))).returning();
  if (updated.length === 0) throw new OpdError("queue_entry_state_conflict", "entry moved concurrently");
  return updated[0]!;
}

/** Any live entry → done (T7's completion). null when the encounter has no live entry left. */
export async function markDone(tx: Tx, encounterId: string, now: Date): Promise<QueueEntryRow | null> {
  const current = (await tx
    .select().from(opdQueueEntries)
    .where(and(eq(opdQueueEntries.encounterId, encounterId), inArray(opdQueueEntries.status, [...LIVE_ENTRY_STATUSES])))
    .orderBy(desc(opdQueueEntries.seq)).limit(1))[0];
  if (!current) return null;
  const updated = await tx.update(opdQueueEntries)
    .set({ status: "done", doneAt: now })
    .where(and(eq(opdQueueEntries.id, current.id), eq(opdQueueEntries.status, current.status))).returning();
  return updated[0] ?? null;
}

export type BoardItem = {
  sessionId: string; roomId: string | null; roomCode: string | null; doctorId: string; doctorName: string;
  departmentName: string; status: SessionStatus; nowServing: number | null; next: number[]; waitingCount: number;
};

/**
 * The public display board (§11.5): token, room and doctor ONLY — never a patient name, never a patient id.
 * The day's open sessions, ordered by room code; `next` is up to five upcoming tokens in engine order.
 */
export async function boardSnapshot(db: Db, serviceDate: string, roomIds?: string[], now: Date = new Date()): Promise<BoardItem[]> {
  const cfg = await loadOpdConfig(db);
  const rows = await db
    .select({ session: opdQueueSessions, doctorName: opdDoctors.displayName, departmentName: opdDepartments.name, roomCode: opdRooms.code })
    .from(opdQueueSessions)
    .innerJoin(opdDoctors, eq(opdQueueSessions.doctorId, opdDoctors.id))
    .innerJoin(opdDepartments, eq(opdDoctors.departmentId, opdDepartments.id))
    .leftJoin(opdRooms, eq(opdQueueSessions.roomId, opdRooms.id))
    .where(and(
      eq(opdQueueSessions.serviceDate, serviceDate),
      ne(opdQueueSessions.status, "closed"),
      roomIds === undefined ? undefined : inArray(opdQueueSessions.roomId, roomIds),
    ));
  const entriesBySession = await liveEntriesBySession(db, rows.map((r) => r.session.id));
  return rows
    .map((r): BoardItem => {
      const { nowServing, next, waitingCount } = summarise(entriesBySession.get(r.session.id) ?? [], r.session.callsMade, cfg, now);
      return {
        sessionId: r.session.id, roomId: r.session.roomId, roomCode: r.roomCode, doctorId: r.session.doctorId,
        doctorName: r.doctorName, departmentName: r.departmentName, status: r.session.status as SessionStatus,
        nowServing, next, waitingCount,
      };
    })
    .sort((a, b) => {
      if (a.roomCode === b.roomCode) return a.doctorName.localeCompare(b.doctorName);
      if (a.roomCode === null) return 1; // a session with no room sits at the end of the board
      if (b.roomCode === null) return -1;
      return a.roomCode.localeCompare(b.roomCode);
    });
}

export type DoctorSummary = {
  doctor: DoctorRow; sessionId: string | null; status: SessionStatus | "none"; waitingCount: number;
  waitingVitalsCount: number; nowServing: number | null; scheduledToday: boolean; roomCode: string | null;
};

/** The front desk's overview of a department's doctors for one IST day (every active doctor, session or not). */
export async function summaryByDoctor(db: Db, departmentId: string | undefined, serviceDate: string, now: Date = new Date()): Promise<DoctorSummary[]> {
  const cfg = await loadOpdConfig(db);
  const doctors = await db
    .select().from(opdDoctors)
    .where(departmentId === undefined ? eq(opdDoctors.active, true) : and(eq(opdDoctors.active, true), eq(opdDoctors.departmentId, departmentId)));
  if (doctors.length === 0) return [];
  const doctorIds = doctors.map((d) => d.id);

  const sessions = await db
    .select().from(opdQueueSessions)
    .where(and(inArray(opdQueueSessions.doctorId, doctorIds), eq(opdQueueSessions.serviceDate, serviceDate)));
  const sessionByDoctor = new Map(sessions.map((s) => [s.doctorId, s] as const));
  const entriesBySession = await liveEntriesBySession(db, sessions.map((s) => s.id));

  // One batched read of the day's templates — the same predicate sessions.roomForDoctorDay uses, for many doctors at once.
  const weekday = istWeekday(serviceDate);
  const templates = await db
    .select({ doctorId: opdDoctorSchedules.doctorId, startTime: opdDoctorSchedules.startTime, roomId: opdDoctorSchedules.roomId })
    .from(opdDoctorSchedules)
    .where(and(
      inArray(opdDoctorSchedules.doctorId, doctorIds), eq(opdDoctorSchedules.active, true), eq(opdDoctorSchedules.weekday, weekday),
      lte(opdDoctorSchedules.validFrom, serviceDate),
      or(isNull(opdDoctorSchedules.validTo), sql`${opdDoctorSchedules.validTo} >= ${serviceDate}`),
    ));
  const scheduledRoom = new Map<string, string>();
  for (const t of [...templates].sort((a, b) => (a.startTime < b.startTime ? -1 : 1))) {
    if (!scheduledRoom.has(t.doctorId)) scheduledRoom.set(t.doctorId, t.roomId);
  }

  const roomIds = [...new Set([...sessions.map((s) => s.roomId), ...scheduledRoom.values()].filter((r): r is string => r !== null))];
  const rooms = roomIds.length === 0 ? [] : await db.select({ id: opdRooms.id, code: opdRooms.code }).from(opdRooms).where(inArray(opdRooms.id, roomIds));
  const roomCode = new Map(rooms.map((r) => [r.id, r.code] as const));

  return doctors
    .map((doctor): DoctorSummary => {
      const session = sessionByDoctor.get(doctor.id);
      const entries = session === undefined ? [] : entriesBySession.get(session.id) ?? [];
      const { nowServing, waitingCount } = summarise(entries, session?.callsMade ?? 0, cfg, now);
      const room = session?.roomId ?? scheduledRoom.get(doctor.id) ?? null;
      return {
        doctor, sessionId: session?.id ?? null, status: (session?.status as SessionStatus | undefined) ?? "none",
        waitingCount, waitingVitalsCount: entries.filter((r) => r.status === "waiting_vitals").length,
        nowServing, scheduledToday: scheduledRoom.has(doctor.id), roomCode: room === null ? null : roomCode.get(room) ?? null,
      };
    })
    .sort((a, b) => a.doctor.displayName.localeCompare(b.doctor.displayName));
}

/** The live rows of many sessions in one query, grouped. */
async function liveEntriesBySession(db: Db, sessionIds: string[]): Promise<Map<string, QueueEntryRow[]>> {
  const grouped = new Map<string, QueueEntryRow[]>();
  if (sessionIds.length === 0) return grouped;
  const rows = await db
    .select().from(opdQueueEntries)
    .where(and(inArray(opdQueueEntries.sessionId, sessionIds), inArray(opdQueueEntries.status, [...LIVE_ENTRY_STATUSES])))
    .orderBy(asc(opdQueueEntries.seq));
  for (const row of rows) {
    const list = grouped.get(row.sessionId);
    if (list === undefined) grouped.set(row.sessionId, [row]);
    else list.push(row);
  }
  return grouped;
}
