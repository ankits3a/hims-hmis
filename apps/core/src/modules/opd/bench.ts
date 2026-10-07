import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { Actor } from "@hmis/contracts";
import { appendEvent } from "../../kernel/events/append";
import { withTx } from "../../kernel/db/client";
import { opdDepartments, opdDoctors, opdEncounters, opdQueueEntries, opdQueueSessions, opdVitals } from "../../kernel/db/schema";
import { getPatientSummaries } from "../patients";
import { OpdError } from "./errors";
import { benchStateSet } from "./events";
import { escalationFor } from "./escalation";
import type { EscalationState } from "./escalation";
import type { QueueEntryRow } from "./encounters";
import type { PatientSummary } from "../patients";
import type { Db, Tx } from "../../kernel/db/client";

/**
 * ══════════════════ VD-1 T4 — THE BENCH ══════════════════
 *
 * The rail that is always on screen. It is one of the three divergences from Desk One the owner
 * signed off, and the reason is physical rather than aesthetic: **a rest-and-recheck timer that
 * lives in a drawer is a forgotten patient.** Ramdev went to the chairs at 09:52 with 172/104 on
 * the clipboard; the only thing standing between him and being forgotten is that his recall is in
 * somebody's peripheral vision.
 *
 * ═══ WHY THESE ARE NOT QUEUE STATUSES, AND NOT WORKFLOW STATES ═══
 *
 * `bench_state` is `null | 'resting' | 'away'` on the queue entry, and the row's `status` stays
 * `waiting_vitals` throughout. That is deliberate on both counts (schema/opd.ts carries the long
 * form):
 *
 *   · not `status`, because `waiting_vitals` is the value `listQueue`'s callable filter excludes,
 *     and a resting patient who became callable is exactly the accident this seat exists to
 *     prevent;
 *   · not a workflow state, because `opd_visit` is a **Class A** definition — a new state costs
 *     owner-plus-medical-superintendent two-key approval and a definition version, and the engine
 *     gates transitions on ROLE KEYS rather than permissions, so the bay's sub-states would have to
 *     be re-granted as definition data to say something the queue already knows.
 *
 * The turn is held by the `seq` the row already has, so coming back from `away` is one column
 * write and no re-queue. *"Her turn was held, not lost"* is a property of doing nothing.
 */

/** `null` is "at the bench, waiting" — the ordinary state, and the absence of a special one. */
export const BENCH_STATES = ["resting", "away"] as const;
export type BenchState = (typeof BENCH_STATES)[number];

export type BenchRow = {
  encounterId: string;
  entryId: string;
  tokenNo: number;
  /**
   * Owner 2026-10-06 — what the PAPER says. The slip and the prescription print the visit number
   * (the prescription's QR is the visit number and nothing else) and the token as `<dept code>-<n>`;
   * a bay that could not match either told a nurse the patient in front of her was not on the bench.
   */
  visitNo: string;
  departmentCode: string | null;
  seq: number;
  doctorId: string;
  doctorName: string;
  serviceDate: string;
  /** Owner 2026-10-07 — the bay offers "guardian with reports" on a REVISIT row only (`patient-absent.ts`). */
  visitType: string;
  patient: PatientSummary | null;
  benchState: BenchState | null;
  recallAt: Date | null;
  /** True once a chart exists — the ✓ row, which re-opens for amendment (D2). */
  vitalsDone: boolean;
  vitalsId: string | null;
  escalation: EscalationState;
  /** Milliseconds left on a live ten-second cancel window; 0 otherwise. */
  cancelMsRemaining: number;
  /** Past its recall and still resting — the row the bay must not walk past. */
  recallDue: boolean;
};

/** Entries the bay can still act on. `done`/`left`/`cancelled` have left the bench. */
const BENCH_STATUSES = ["waiting_vitals", "waiting", "called", "in_consult"] as const;

/** A visit number as typed or scanned: any case, spaces tolerated — `v 2610060001` is `V2610060001`. */
export function normalizeVisitNo(raw: string): string {
  return raw.replace(/\s+/g, "").toUpperCase();
}

export type VisitOnBench =
  | { onBench: true; visitNo: string; encounterId: string }
  | {
    onBench: false; visitNo: string;
    /**
     * WHY — so the bay can say it instead of "check the slip": no such visit; a visit of another
     * day (and which); withdrawn; the consultation already finished; or a visit that holds no place
     * in any doctor's queue (a pharmacy-only visit, or an entry that left the board).
     */
    reason: "unknown_visit" | "other_day" | "abandoned" | "completed" | "not_queued";
    serviceDate?: string;
  };

/**
 * Owner 2026-10-06 — *"searching or scanning the visit id isn't enabling me to select the patient"*.
 * The bench itself now carries the visit number, so a hit is a lookup on screen; this is the answer
 * for a MISS. It reads no patient: a visit number, a date and a reason, behind the bench's own door.
 */
export async function locateVisit(db: Db, input: { visitNo: string; serviceDate: string }): Promise<VisitOnBench> {
  const visitNo = normalizeVisitNo(input.visitNo);
  const [encounter] = await db.select().from(opdEncounters).where(eq(opdEncounters.visitNo, visitNo)).limit(1);
  if (encounter === undefined) return { onBench: false, visitNo, reason: "unknown_visit" };
  if (encounter.serviceDate !== input.serviceDate) return { onBench: false, visitNo, reason: "other_day", serviceDate: encounter.serviceDate };
  if (encounter.status === "abandoned") return { onBench: false, visitNo, reason: "abandoned" };
  if (encounter.status === "completed") return { onBench: false, visitNo, reason: "completed" };
  const live = await db
    .select({ id: opdQueueEntries.id }).from(opdQueueEntries)
    .where(and(eq(opdQueueEntries.encounterId, encounter.id), inArray(opdQueueEntries.status, [...BENCH_STATUSES])))
    .limit(1);
  if (live.length === 0) return { onBench: false, visitNo, reason: "not_queued" };
  return { onBench: true, visitNo, encounterId: encounter.id };
}

/**
 * The bay's whole worklist in one read: who is waiting, who is resting and when they are due back,
 * whose turn is being held, and which rows already have a chart (so a ✓ row can be re-opened).
 *
 * ONE query per fact, never per row — the bench is repainted every few seconds behind a nurse who
 * is typing, and an N+1 here is a stutter in the one surface that must never stutter.
 */
export async function listBench(
  db: Db, actor: Actor, filter: { departmentId?: string; doctorId?: string; serviceDate: string }, now: Date = new Date(),
): Promise<BenchRow[]> {
  const doctorRows = await db
    .select({ id: opdDoctors.id, displayName: opdDoctors.displayName, departmentId: opdDoctors.departmentId })
    .from(opdDoctors);
  const doctors = doctorRows.filter((d) =>
    (filter.doctorId === undefined || d.id === filter.doctorId)
    && (filter.departmentId === undefined || d.departmentId === filter.departmentId));
  if (doctors.length === 0) return [];
  const doctorById = new Map(doctors.map((d) => [d.id, d] as const));
  const departments = await db.select({ id: opdDepartments.id, code: opdDepartments.code }).from(opdDepartments);
  const codeByDepartment = new Map(departments.map((d) => [d.id, d.code] as const));

  const sessions = await db
    .select().from(opdQueueSessions)
    .where(and(inArray(opdQueueSessions.doctorId, doctors.map((d) => d.id)), eq(opdQueueSessions.serviceDate, filter.serviceDate)));
  if (sessions.length === 0) return [];
  const sessionById = new Map(sessions.map((s) => [s.id, s] as const));

  const entries = await db
    .select().from(opdQueueEntries)
    .where(and(inArray(opdQueueEntries.sessionId, sessions.map((s) => s.id)), inArray(opdQueueEntries.status, [...BENCH_STATUSES])))
    .orderBy(asc(opdQueueEntries.seq));
  if (entries.length === 0) return [];

  const encounterIds = entries.map((e) => e.encounterId);
  const encounters = await db.select().from(opdEncounters).where(inArray(opdEncounters.id, encounterIds));
  const encounterById = new Map(encounters.map((e) => [e.id, e] as const));

  // The ✓: the newest ACTIVE chart per encounter. A superseded row is an amendment's predecessor
  // and must not make a second tick (D2).
  const charts = await db
    .select({ id: opdVitals.id, encounterId: opdVitals.encounterId, recordedAt: opdVitals.recordedAt })
    .from(opdVitals)
    .where(and(inArray(opdVitals.encounterId, encounterIds), eq(opdVitals.status, "active")))
    .orderBy(desc(opdVitals.recordedAt));
  const chartByEncounter = new Map<string, string>();
  for (const c of charts) if (!chartByEncounter.has(c.encounterId)) chartByEncounter.set(c.encounterId, c.id);

  const summaries = await getPatientSummaries(db, actor, encounters.map((e) => e.patientId));
  const summaryByPatient = new Map(summaries.map((s) => [s.requestedId, s] as const));

  const rows: BenchRow[] = [];
  for (const entry of entries) {
    const encounter = encounterById.get(entry.encounterId);
    const session = sessionById.get(entry.sessionId);
    if (encounter === undefined || session === undefined) continue;
    /*
      Owner 2026-10-07 — a guardian's visit has left the bay: nobody is there to weigh, and the
      token is already in the doctor's line. Its entry is `waiting` like a charted patient's, so
      without this it would sit on the bench as a row with no ✓ that no save could ever clear.
    */
    if (encounter.patientAbsentAt !== null) continue;
    const doctor = doctorById.get(session.doctorId);
    if (doctor === undefined) continue;
    const state = (entry.benchState ?? null) as BenchState | null;
    const vitalsId = chartByEncounter.get(entry.encounterId) ?? null;
    const escalation = (entry.escalation ?? "none") as EscalationState;
    rows.push({
      encounterId: entry.encounterId, entryId: entry.id, tokenNo: entry.tokenNo, seq: entry.seq,
      visitNo: encounter.visitNo, departmentCode: codeByDepartment.get(doctor.departmentId) ?? null,
      doctorId: doctor.id, doctorName: doctor.displayName, serviceDate: session.serviceDate,
      visitType: encounter.visitType,
      patient: summaryByPatient.get(encounter.patientId) ?? null,
      benchState: state, recallAt: entry.recallAt,
      vitalsDone: vitalsId !== null, vitalsId,
      escalation,
      cancelMsRemaining: escalation === "escalated" && entry.escalatedAt !== null
        ? Math.max(0, entry.escalatedAt.getTime() + 10_000 - now.getTime())
        : 0,
      recallDue: state === "resting" && entry.recallAt !== null && entry.recallAt.getTime() <= now.getTime(),
    });
  }
  return rows;
}

/** The entry the bench acts on: the newest live one for this encounter. */
async function benchEntry(tx: Tx, encounterId: string): Promise<QueueEntryRow> {
  const rows = await tx
    .select().from(opdQueueEntries)
    .where(and(eq(opdQueueEntries.encounterId, encounterId), inArray(opdQueueEntries.status, [...BENCH_STATUSES])))
    .orderBy(desc(opdQueueEntries.seq)).limit(1);
  const entry = rows[0];
  if (!entry) throw new OpdError("unknown_queue_entry", "this visit is not on the bench", { encounterId });
  return entry;
}

/**
 * Send a patient to the rest chairs, hold a turn for somebody who stepped out, or bring either back.
 *
 * ═══ THE RECALL IS A STORED INSTANT, FOR THE SAME REASON THE CANCEL WINDOW IS (T3 / D8) ═══
 *
 * `recall_at` is written once and compared against the clock by every reader. A timer in a browser
 * tab dies with the tab, and a timer in a Node process dies with a restart — and the thing being
 * timed is a seventy-year-old man with a systolic of 172 sitting on a plastic chair. `recallDue` is
 * therefore derived on every read rather than fired once, so a bench repainted after a crash still
 * knows he is overdue.
 *
 * **Rest is for elevated MAYBES only**, which is the owner's DECIDED line and is enforced by the
 * caller rather than here: at danger numbers T3's `demandRecheck` runs instead, and the recheck
 * happens while the patient is still on the stool.
 */
export async function setBenchState(
  db: Db, actor: Actor, encounterId: string,
  input: { state: BenchState | null; restMinutes?: number; note?: string },
  now: Date = new Date(),
): Promise<BenchRow> {
  if (actor.type !== "user") throw new OpdError("user_actor_required");
  if (input.state !== null && !BENCH_STATES.includes(input.state)) {
    throw new OpdError("invalid_bench_state", `unknown bench state ${String(input.state)}`, { state: input.state });
  }
  if (input.state === "resting" && (input.restMinutes === undefined || input.restMinutes <= 0)) {
    throw new OpdError("invalid_bench_state", "a rest needs a recall time — a rest with no recall is a forgotten patient", {});
  }
  return withTx(db, async (tx) => {
    const entry = await benchEntry(tx, encounterId);
    const encounter = (await tx.select().from(opdEncounters).where(eq(opdEncounters.id, encounterId)))[0]!;
    const session = (await tx.select().from(opdQueueSessions).where(eq(opdQueueSessions.id, entry.sessionId)))[0]!;
    const recallAt = input.state === "resting" ? new Date(now.getTime() + input.restMinutes! * 60_000) : null;

    await tx.update(opdQueueEntries)
      .set({ benchState: input.state, recallAt })
      .where(eq(opdQueueEntries.id, entry.id));

    await appendEvent(tx, benchStateSet.make({
      actor, patientId: encounter.patientId, encounterId, correlationId: encounter.workflowInstanceId,
      payload: {
        encounterId, patientId: encounter.patientId, doctorId: session.doctorId, serviceDate: session.serviceDate,
        sessionId: session.id, roomId: session.roomId, tokenNo: entry.tokenNo,
        state: input.state, recallAt: recallAt === null ? null : recallAt.toISOString(),
        note: input.note ?? null,
      },
    }));

    const chart = (await tx
      .select({ id: opdVitals.id }).from(opdVitals)
      .where(and(eq(opdVitals.encounterId, encounterId), eq(opdVitals.status, "active")))
      .orderBy(desc(opdVitals.recordedAt)).limit(1))[0];
    const escalation = await escalationFor(tx, encounterId, now);
    const [summary] = await getPatientSummaries(tx, actor, [encounter.patientId]);
    const doctor = (await tx.select().from(opdDoctors).where(eq(opdDoctors.id, session.doctorId)))[0]!;
    const department = (await tx.select({ code: opdDepartments.code }).from(opdDepartments).where(eq(opdDepartments.id, doctor.departmentId)))[0];
    return {
      encounterId, entryId: entry.id, tokenNo: entry.tokenNo, seq: entry.seq,
      visitNo: encounter.visitNo, departmentCode: department?.code ?? null,
      doctorId: doctor.id, doctorName: doctor.displayName, serviceDate: session.serviceDate,
      visitType: encounter.visitType,
      patient: summary ?? null, benchState: input.state, recallAt,
      // Read, never assumed: a patient can be sent to the chairs AFTER a first chart exists
      // (Ramdev's 172/104 is saved before he sits down), and a row that claimed otherwise would
      // drop his ✓ off the rail at the moment the rail matters most.
      vitalsDone: chart !== undefined, vitalsId: chart?.id ?? null,
      escalation: escalation?.state ?? "none", cancelMsRemaining: escalation?.cancelMsRemaining ?? 0,
      recallDue: false,
    };
  });
}
