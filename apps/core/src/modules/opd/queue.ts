import { and, asc, desc, eq, gte, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import type { Actor } from "@hmis/contracts";
import { appendEvent } from "../../kernel/events/append";
import { withTx } from "../../kernel/db/client";
import {
  opdDepartments, opdDoctorLeaves, opdDoctorSchedules, opdDoctors, opdEncounters, opdQueueEntries, opdQueueSessions, resources,
} from "../../kernel/db/schema";
import { getPatientSummaries } from "../patients";
import { encounterFeeStatuses } from "../billing";
import type { FeeStatusVia } from "../billing";
import { loadOpdConfig } from "./config";
import { getEncounter, joinQueueInTx } from "./encounters";
import { OpdError } from "./errors";
import { queueCalled, queueFeeStatusChanged, queueSkipped } from "./events";
import { classOf, nextInQueue, orderQueue } from "./queue-engine";
import { istDate, istWeekday } from "./time";
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
  /**
   * RC-1 T3 / D1 — the token's stamp, DERIVED from the invoice ledger by `encounterFeeStatuses`
   * (never stored): free · settled · credit · unsettled. `null` when billing is unconfigured —
   * unknown, rendered as nothing.
   */
  feeStatus: "free" | "settled" | "credit" | "unsettled" | null;
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
  // The stamp, batched: a fixed number of queries however long the queue (the CI perf budget).
  const feeStatuses = await encounterFeeStatuses(db, encounters);

  const toView = (row: QueueEntryRow, position: number | null, queueClass: QueueClass | null): QueueEntryView => {
    const encounter = encounterById.get(row.encounterId)!;
    return {
      ...row, position, queueClass,
      encounter: {
        id: encounter.id, patientId: encounter.patientId, visitType: encounter.visitType,
        dangerFlagged: encounter.dangerFlagged, status: encounter.status,
      },
      patient: summaryByPatient.get(encounter.patientId) ?? null,
      feeStatus: feeStatuses.get(encounter.id) ?? null,
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
    // PLAN 13 T6 — the join target moved to the registry and the join STAYS A LEFT JOIN: a session
    // with no room still belongs on the board (it sorts to the end, below).
    .select({ session: opdQueueSessions, doctorName: opdDoctors.displayName, departmentName: opdDepartments.name, roomCode: resources.code })
    .from(opdQueueSessions)
    .innerJoin(opdDoctors, eq(opdQueueSessions.doctorId, opdDoctors.id))
    .innerJoin(opdDepartments, eq(opdDoctors.departmentId, opdDepartments.id))
    .leftJoin(resources, eq(opdQueueSessions.roomId, resources.id))
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
  /**
   * ═══ FD-7 T8 — THE BOARD DID NOT KNOW ABOUT LEAVE, AT ALL ═══
   *
   * `scheduledToday` was read off `opd_doctor_schedules` alone, so a doctor on approved leave stayed
   * on the board all day reading "scheduled, 0 waiting". Two things followed from that, and the
   * second is the one that reaches a patient:
   *
   *   · the desk's "session not opened" alert (`desk-provider.ts:56`) nagged about a doctor who was
   *     away, every day of their leave;
   *   · **an empty queue is the SHORTEST queue.** With the owner's 03-Sep ruling that the department
   *     queue auto-assigns to the least-waiting doctor, a doctor on leave would win that comparison
   *     every time — the walk-in router would have sent every arriving patient to the one person in
   *     the building guaranteed not to see them.
   *
   * `availableSlots` and `bookAppointment` have consulted `opd_doctor_leaves` since Plan 07
   * (`appointments.ts:23`); the QUEUE side never did. `scheduledToday` now means "working today" —
   * which is what every one of its five readers already assumed it meant — and `onLeaveToday` says
   * WHY somebody is not, because "not on the board" and "away today" are different things to a clerk
   * standing in front of a patient who asked for that doctor by name.
   */
  onLeaveToday: boolean;
  /**
   * RC-1 T5 / D7 — wait v0's pace term: the department's `avg_consult_minutes` (a masters column,
   * default 6). The seat renders `waitingCount × this` as minutes AND a clock time; a future pace
   * model replaces THIS COLUMN'S READ, never the wire shape.
   */
  avgConsultMinutes: number;
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

  /*
   * FD-7 T8 — the day's approved leave, batched over the same doctor set. The predicate is exactly
   * `appointments.ts:23`'s (`status = 'scheduled'`, `from <= date <= to`, inclusive both ends) so
   * the queue and the appointment book cannot disagree about who is away — a doctor the book refuses
   * to book and the board offers a walk-in to would be worse than either behaviour alone.
   */
  const leaves = await db
    .select({ doctorId: opdDoctorLeaves.doctorId })
    .from(opdDoctorLeaves)
    .where(and(
      inArray(opdDoctorLeaves.doctorId, doctorIds), eq(opdDoctorLeaves.status, "scheduled"),
      lte(opdDoctorLeaves.fromDate, serviceDate), gte(opdDoctorLeaves.toDate, serviceDate),
    ));
  const onLeave = new Set(leaves.map((l) => l.doctorId));

  const roomIds = [...new Set([...sessions.map((s) => s.roomId), ...scheduledRoom.values()].filter((r): r is string => r !== null))];
  const rooms = roomIds.length === 0 ? [] : await db.select({ id: resources.id, code: resources.code }).from(resources).where(inArray(resources.id, roomIds));
  const roomCode = new Map(rooms.map((r) => [r.id, r.code] as const));

  // D7 — one batched read of the doctors' departments for the pace column.
  const deptIds = [...new Set(doctors.map((d) => d.departmentId))];
  const depts = deptIds.length === 0
    ? []
    : await db.select({ id: opdDepartments.id, avgConsultMinutes: opdDepartments.avgConsultMinutes }).from(opdDepartments).where(inArray(opdDepartments.id, deptIds));
  const avgByDept = new Map(depts.map((d) => [d.id, d.avgConsultMinutes] as const));

  return doctors
    .map((doctor): DoctorSummary => {
      const session = sessionByDoctor.get(doctor.id);
      const entries = session === undefined ? [] : entriesBySession.get(session.id) ?? [];
      const { nowServing, waitingCount } = summarise(entries, session?.callsMade ?? 0, cfg, now);
      const room = session?.roomId ?? scheduledRoom.get(doctor.id) ?? null;
      return {
        doctor, sessionId: session?.id ?? null, status: (session?.status as SessionStatus | undefined) ?? "none",
        waitingCount, waitingVitalsCount: entries.filter((r) => r.status === "waiting_vitals").length,
        nowServing,
        // A doctor on leave is NOT scheduled today, whatever the weekly template says.
        scheduledToday: scheduledRoom.has(doctor.id) && !onLeave.has(doctor.id),
        onLeaveToday: onLeave.has(doctor.id),
        roomCode: room === null ? null : roomCode.get(room) ?? null,
        avgConsultMinutes: avgByDept.get(doctor.departmentId) ?? 6,
      };
    })
    .sort((a, b) => a.doctor.displayName.localeCompare(b.doctor.displayName));
}

/**
 * RC-1 T3 / D2 — the hook billing calls inside its settling transaction (`registerFeeStatusHook`,
 * wired by `opd.module.ts`). It appends `queue.fee_status_changed` — the board flip — ONLY when:
 * the encounter exists, its consult fee is actually covered per `encounterFeeStatuses` (so a
 * pharmacy-only invoice settling flips nothing), and a LIVE queue entry is on the board (a
 * deferred bill-first visit has no token yet — its token is BORN paid at `joinQueue`, and a flip
 * for a token that never showed UNPAID would just be noise).
 */
export async function queueFeeStatusHook(
  tx: Tx,
  actor: Actor,
  info: { encounterId: string; invoiceId: string; via: FeeStatusVia },
  now: Date,
): Promise<void> {
  const encounter = (await tx.select().from(opdEncounters).where(eq(opdEncounters.id, info.encounterId)))[0];
  if (!encounter) return;
  /**
   * RC-3 T3 — THE BAIL ON `unsettled` IS GONE, AND THAT IS THE WHOLE OF M3's FIX HERE.
   *
   * This hook has always RE-DERIVED the status rather than trusting its caller, so it already
   * computed the truth after a reversal — and then threw it away, because the guard treated
   * "unsettled" as "nothing to say". It is the opposite: a board showing PAID over money that has
   * been reversed is the one state the hall must not be left in.
   *
   * `undefined` (no fee service on this encounter at all) still returns: there is no stamp to move.
   */
  const status = (await encounterFeeStatuses(tx, [encounter])).get(encounter.id);
  if (status === undefined) return;

  /**
   * THE DIRECTION DECIDES WHETHER `unsettled` IS NEWS — and getting this wrong broke RC-1's M1
   * discriminator, which is how it was found.
   *
   * On an ARRIVING via, `unsettled` means "money came in and it did not cover THIS encounter's fee"
   * — a pharmacy-only invoice settling, exactly RC-1 M1's case. There is nothing to tell the hall:
   * the token was UNPAID before and is UNPAID now, and an event saying so would be noise on every
   * unrelated invoice in the hospital. RC-1's silence there was correct and is preserved.
   *
   * On a LEAVING via, `unsettled` is the entire point: money that WAS covering this fee has gone,
   * and the board is still showing PAID. That is M3.
   *
   * So the guard is about the direction of the money, not the value of the status. Removing it
   * altogether — the first thing I tried — turned M3's fix into a regression of M1's.
   */
  const ARRIVING: readonly FeeStatusVia[] = ["invoice", "credit_extended", "allocation"];
  if (status === "unsettled" && ARRIVING.includes(info.via)) return;
  const entry = (await tx
    .select().from(opdQueueEntries)
    .where(and(eq(opdQueueEntries.encounterId, encounter.id), inArray(opdQueueEntries.status, [...LIVE_ENTRY_STATUSES])))
    .orderBy(desc(opdQueueEntries.seq)).limit(1))[0];
  if (!entry) {
    /**
     * ═══ RC-4 CLOSE F1 (CRITICAL) — A DEFERRED VISIT JOINS WHERE ITS MONEY LANDS ═══
     *
     * "Its token is born PAID at `joinQueue`" was true only while the seat that opened the visit
     * stayed mounted and remembered it; every other road to the money — a reload, `/billing`, an
     * Escape — left a paid patient with no token. The join now happens HERE, inside the settling
     * transaction, for exactly the visit that has never had an entry: `registered`, today, with a
     * doctor, and (the deferred proxy) NO queue entry at all — a queue-first visit whose entry has
     * `left` or `done` has rows and is not re-entered by a payment; that is `re-enter`'s act.
     * Money done means `settled`, `credit`, or `free` (a revisit inside its window, reached here
     * by an invoice for something else on the visit) — the same three the seat counts.
     *
     * ═══ CLOSE REVIEW PASS 2, N1 (MAJOR) — `unsettled` DOES REACH THIS BRANCH, ON A LEAVING VIA ═══
     * The first remediation removed this guard on the argument that a leaving via "needs money that
     * was covering the fee, which would have joined the visit" — and R37 stayed green because no
     * fixture built the road. The road: a LAB invoice against a deferred visit settles (arriving,
     * fee still `unsettled` → returned above), then its receipt is voided or its allocation
     * reversed → a LEAVING via with the fee `unsettled` → without this line, four guards pass and
     * an UNPAID token is minted in the bill-first lane. The pass-2 reviewer built the road; the
     * test beside this (`fee-status.test.ts`, "N1") walks it and goes red without the guard.
     *
     * `joinQueueInTx` can only throw for a state this branch has already excluded (it re-reads the
     * same row under `FOR UPDATE`); a throw here WOULD abort the settle (`settle-hooks.ts`), which
     * is why every precondition is checked before the call rather than caught after it.
     */
    if (status === "unsettled") return;
    if (actor.type !== "user" || encounter.status !== "registered" || encounter.doctorId === null) return;
    const anyEntry = (await tx.select({ id: opdQueueEntries.id }).from(opdQueueEntries).where(eq(opdQueueEntries.encounterId, encounter.id)).limit(1))[0];
    if (anyEntry) return;
    if (encounter.serviceDate !== istDate(now)) return;
    await joinQueueInTx(tx, actor, encounter.id, now);
    return;
  }
  const session = (await tx.select().from(opdQueueSessions).where(eq(opdQueueSessions.id, entry.sessionId)))[0];
  if (!session) return;
  await appendEvent(tx, queueFeeStatusChanged.make({
    actor, patientId: encounter.patientId, encounterId: encounter.id, correlationId: info.invoiceId,
    payload: {
      encounterId: encounter.id, patientId: encounter.patientId, doctorId: session.doctorId,
      serviceDate: session.serviceDate, sessionId: session.id, roomId: session.roomId, tokenNo: entry.tokenNo,
      status, invoiceId: info.invoiceId, via: info.via,
    },
  }));
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
