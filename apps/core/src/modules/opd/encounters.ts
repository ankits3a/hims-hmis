import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import { appendEvent } from "../../kernel/events/append";
import { nextEpisodeNo } from "../../kernel/episodes/series";
import { withTx } from "../../kernel/db/client";
import {
  opdDepartments, opdDoctors, opdEncounters, opdPrescriptions, opdQueueEntries, opdQueueSessions, opdVitals,
} from "../../kernel/db/schema";
import { startInstance, transition, WorkflowError } from "../../kernel/workflow/instances";
import { getPatient, listMergedLoserIds, resolvePatientId } from "../patients";
import { loadOpdConfig } from "./config";
import { OpdError } from "./errors";
import { patientCheckedIn, visitAbandoned, visitOpened, visitTransferred } from "./events";
import { allocateToken, getOrCreateSession, roomForDoctorDay } from "./sessions";
import { istDate } from "./time";
import { classifyVisit } from "./visit-type";
import { OPD_VISIT_DEF_KEY } from "./workflow-def";
import type { OpdVisitState } from "./workflow-def";
import type { VisitType } from "./visit-type";
import type { Db, Tx } from "../../kernel/db/client";

export type EncounterRow = typeof opdEncounters.$inferSelect;
export type QueueEntryRow = typeof opdQueueEntries.$inferSelect;
export type VitalsRow = typeof opdVitals.$inferSelect;
export type PrescriptionRow = typeof opdPrescriptions.$inferSelect;

/** Queue-entry statuses a live encounter can be sitting in. */
const LIVE_ENTRY_STATUSES = ["waiting_vitals", "waiting", "called"] as const;
/** Encounter states an abandon may leave from (the definition's three abandon transitions). */
const ABANDONABLE: readonly string[] = ["registered", "waiting", "awaiting_results"];

export type OpenVisitInput = {
  patientId: string; departmentId: string; doctorId: string;
  intendedPayer?: "self" | "tpa" | "pmjay" | "corporate";
  referralSource?: "self" | "internal_doctor" | "external_rmp" | "camp" | "other";
  referrerName?: string;
  appointment?: { id: string; slotStart: Date }; // set only by appointments.checkIn (T4)
};
export type OpenVisitResult = {
  encounter: EncounterRow; queueEntry: QueueEntryRow; tokenNo: number; sessionId: string; roomId: string | null;
  visitType: VisitType; doctorScheduledToday: boolean;
};

/** Db-first: resolves the patient and its merge chain through the patients module, then runs openVisitInTx on its own transaction. */
export async function openVisit(db: Db, actor: Actor, input: OpenVisitInput, now: Date = new Date()): Promise<OpenVisitResult> {
  if (actor.type !== "user") throw new OpdError("user_actor_required");
  const canonical = await resolvePatientId(db, input.patientId);
  if (!canonical) throw new OpdError("patient_not_found", `unknown patient ${input.patientId}`);
  const chainIds = [canonical, ...(await listMergedLoserIds(db, canonical))];
  return withTx(db, (tx) => openVisitInTx(tx, actor, { ...input, patientId: canonical, chainIds }, now));
}

/** Tx-first core (also called by appointments.checkIn inside ITS transaction). patientId MUST already be canonical. */
export async function openVisitInTx(tx: Tx, actor: Actor, input: OpenVisitInput & { chainIds: string[] }, now: Date): Promise<OpenVisitResult> {
  if (actor.type !== "user") throw new OpdError("user_actor_required");
  await loadOpdConfig(tx); // opd_not_configured before any write
  const doctor = (await tx.select().from(opdDoctors).where(eq(opdDoctors.id, input.doctorId)))[0];
  if (!doctor) throw new OpdError("unknown_doctor");
  if (!doctor.active) throw new OpdError("doctor_inactive");
  const dept = (await tx.select().from(opdDepartments).where(eq(opdDepartments.id, input.departmentId)))[0];
  if (!dept) throw new OpdError("unknown_department");
  if (!dept.active) throw new OpdError("department_inactive");
  if (doctor.departmentId !== dept.id) throw new OpdError("doctor_department_mismatch");

  const serviceDate = istDate(now);
  const anchorRows = await tx
    .select({ consultCompletedAt: opdEncounters.consultCompletedAt, followUpDays: opdEncounters.followUpDays })
    .from(opdEncounters)
    .where(and(inArray(opdEncounters.patientId, input.chainIds), eq(opdEncounters.departmentId, dept.id), eq(opdEncounters.status, "completed")))
    .orderBy(desc(opdEncounters.consultCompletedAt))
    .limit(1);
  const a = anchorRows[0];
  const visitType = classifyVisit(a && a.consultCompletedAt ? { consultCompletedAt: a.consultCompletedAt, followUpDays: a.followUpDays ?? 7 } : null, now);

  const encounterId = newId();
  // The visit number, allocated once per encounter. A same-day re-entry after results does NOT
  // come back through here — it appends an opd_queue_entries row against THIS encounter — so
  // there is exactly one V number per visit, which is what makes it safe to print on a lab form.
  const visitNo = await nextEpisodeNo(tx, "visit", serviceDate);
  const { instanceId } = await startInstance(tx, OPD_VISIT_DEF_KEY, { type: "opd_encounter", id: encounterId, patientId: input.patientId, encounterId });
  const roomId = await roomForDoctorDay(tx, doctor.id, serviceDate);
  const session = await getOrCreateSession(tx, doctor.id, serviceDate, roomId);
  const tokenNo = await allocateToken(tx, session.id);

  const [encounter] = await tx.insert(opdEncounters).values({
    id: encounterId, visitNo, patientId: input.patientId, workflowInstanceId: instanceId, departmentId: dept.id, doctorId: doctor.id,
    appointmentId: input.appointment?.id ?? null, serviceDate, visitType,
    intendedPayer: input.intendedPayer ?? "self", referralSource: input.referralSource ?? null, referrerName: input.referrerName ?? null,
    openedBy: actor.id, openedAt: now, updatedBy: actor.id, updatedAt: now,
  }).returning();
  const [queueEntry] = await tx.insert(opdQueueEntries).values({
    id: newId(), sessionId: session.id, encounterId, tokenNo,
    kind: input.appointment ? "appointment" : "walk_in", appointmentAt: input.appointment?.slotStart ?? null, status: "waiting_vitals",
  }).returning();

  const where = { doctorId: doctor.id, serviceDate, sessionId: session.id, roomId: session.roomId, tokenNo };
  const env = { actor, patientId: input.patientId, encounterId, correlationId: instanceId };
  await appendEvent(tx, visitOpened.make({ ...env, payload: {
    encounterId, patientId: input.patientId, departmentId: dept.id, ...where, visitType, intendedPayer: input.intendedPayer ?? "self",
    kind: input.appointment ? "appointment" : "walk_in", appointmentId: input.appointment?.id ?? null,
  } }));
  await appendEvent(tx, patientCheckedIn.make({ ...env, payload: { encounterId, patientId: input.patientId, ...where, kind: "arrival" } }));
  return { encounter: encounter!, queueEntry: queueEntry!, tokenNo, sessionId: session.id, roomId: session.roomId, visitType, doctorScheduledToday: roomId !== null };
}

/** THE only writer of opd_encounters.status: engine transition first (single-winner), then the mirror. */
export async function moveEncounter(
  tx: Tx, actor: Actor, encounter: EncounterRow, to: OpdVisitState,
  patch: Partial<Pick<EncounterRow, "consultStartedAt" | "consultCompletedAt" | "abandonedAt" | "abandonReason" | "followUpDays" | "followUpExtended"
    | "chiefComplaint" | "diagnosis" | "icd10Code" | "advice" | "admissionAdvised" | "referralTo" | "referralNote">> = {},
  now: Date = new Date(),
): Promise<EncounterRow> {
  try {
    await transition(tx, encounter.workflowInstanceId, to, actor);
  } catch (e) {
    if (e instanceof WorkflowError && (e.code === "stale_transition" || e.code === "instance_not_active" || e.code === "unknown_transition")) {
      throw new OpdError("encounter_state_conflict", `${encounter.status}→${to}: ${e.code}`);
    }
    throw e; // role_denied, unknown_instance, no_active_definition stay WorkflowErrors (403 / 409 at the edge)
  }
  const rows = await tx
    .update(opdEncounters)
    .set({ status: to, updatedBy: actor.id, updatedAt: now, ...patch })
    .where(and(eq(opdEncounters.id, encounter.id), eq(opdEncounters.status, encounter.status)))
    .returning();
  if (rows.length === 0) throw new OpdError("encounter_state_conflict", "mirror desync"); // unreachable while the invariant holds — a loud belt
  return rows[0]!;
}

export async function getEncounter(db: Db | Tx, id: string): Promise<EncounterRow | null> {
  const rows = await db.select().from(opdEncounters).where(eq(opdEncounters.id, id));
  return rows[0] ?? null;
}

/** The encounter's newest queue entry (seq, never id — ledger §3.26) plus its session, for the doctor-day event fields. */
async function newestEntryWhere(tx: Tx, encounterId: string): Promise<{ entry: QueueEntryRow; sessionRoomId: string | null }> {
  const entries = await tx
    .select().from(opdQueueEntries).where(eq(opdQueueEntries.encounterId, encounterId))
    .orderBy(desc(opdQueueEntries.seq)).limit(1);
  const entry = entries[0]!;
  const sessions = await tx.select().from(opdQueueSessions).where(eq(opdQueueSessions.id, entry.sessionId));
  return { entry, sessionRoomId: sessions[0]!.roomId };
}

/** §11.1 walk-away. One transaction: the mirror move, the queue entry cancelled, one visit.abandoned. */
export async function abandonVisit(db: Db, actor: Actor, encounterId: string, reason: string, now: Date = new Date()): Promise<{ encounter: EncounterRow }> {
  if (reason.trim() === "") throw new OpdError("reason_required", "an abandoned visit records why");
  const current = await getEncounter(db, encounterId);
  if (!current) throw new OpdError("unknown_encounter", `unknown encounter ${encounterId}`);
  if (!ABANDONABLE.includes(current.status)) throw new OpdError("encounter_state_conflict", `cannot abandon from ${current.status}`);
  return withTx(db, async (tx) => {
    const encounter = await moveEncounter(tx, actor, current, "abandoned", { abandonedAt: now, abandonReason: reason }, now);
    await tx
      .update(opdQueueEntries)
      .set({ status: "cancelled" })
      .where(and(eq(opdQueueEntries.encounterId, encounterId), inArray(opdQueueEntries.status, [...LIVE_ENTRY_STATUSES])))
      .returning({ id: opdQueueEntries.id });
    const { entry, sessionRoomId } = await newestEntryWhere(tx, encounterId);
    await appendEvent(tx, visitAbandoned.make({
      actor, patientId: encounter.patientId, encounterId, correlationId: encounter.workflowInstanceId,
      payload: {
        encounterId, patientId: encounter.patientId, doctorId: encounter.doctorId, serviceDate: encounter.serviceDate,
        sessionId: entry.sessionId, roomId: sessionRoomId, tokenNo: entry.tokenNo,
        fromState: current.status, reason,
      },
    }));
    return { encounter };
  });
}

/** Same-day return with results: the SAME encounter and the SAME token, a new queue entry in the re-entry class. */
export async function reEnterVisit(db: Db, actor: Actor, encounterId: string, now: Date = new Date()): Promise<{ encounter: EncounterRow; queueEntry: QueueEntryRow }> {
  const current = await getEncounter(db, encounterId);
  if (!current) throw new OpdError("unknown_encounter", `unknown encounter ${encounterId}`);
  if (current.status !== "awaiting_results") throw new OpdError("encounter_state_conflict", `re-entry needs awaiting_results, not ${current.status}`);
  if (istDate(now) !== current.serviceDate) throw new OpdError("encounter_state_conflict", "re-entry is same-IST-day only");
  return withTx(db, async (tx) => {
    const encounter = await moveEncounter(tx, actor, current, "waiting", {}, now);
    const previous = await tx
      .select().from(opdQueueEntries).where(eq(opdQueueEntries.encounterId, encounterId))
      .orderBy(desc(opdQueueEntries.seq)).limit(1);
    const prev = previous[0]!;
    await tx
      .update(opdQueueEntries)
      .set({ status: "done", doneAt: now })
      .where(and(eq(opdQueueEntries.id, prev.id), inArray(opdQueueEntries.status, [...LIVE_ENTRY_STATUSES, "in_consult"])));
    const [queueEntry] = await tx.insert(opdQueueEntries).values({
      id: newId(), sessionId: prev.sessionId, encounterId, tokenNo: prev.tokenNo, kind: prev.kind,
      appointmentAt: null, status: "waiting", danger: encounter.dangerFlagged, reEntry: true, eligibleAt: now,
    }).returning();
    const sessions = await tx.select().from(opdQueueSessions).where(eq(opdQueueSessions.id, prev.sessionId));
    await appendEvent(tx, patientCheckedIn.make({
      actor, patientId: encounter.patientId, encounterId, correlationId: encounter.workflowInstanceId,
      payload: {
        encounterId, patientId: encounter.patientId, doctorId: encounter.doctorId, serviceDate: encounter.serviceDate,
        sessionId: prev.sessionId, roomId: sessions[0]!.roomId, tokenNo: prev.tokenNo, kind: "re_entry",
      },
    }));
    return { encounter, queueEntry: queueEntry! };
  });
}

/**
 * E2 coverage: a supervisor moves a doctor's live queue to another doctor OF THE SAME DEPARTMENT. New tokens in the
 * target session, original eligibility preserved (the patient does not lose their place), consent recorded.
 */
export async function transferQueue(
  db: Db,
  actor: Actor,
  input: { fromDoctorId: string; toDoctorId: string; serviceDate: string; entryIds?: string[]; consented: boolean; reason: string },
  now: Date = new Date(),
): Promise<{ transferred: number; toSessionId: string }> {
  if (input.consented !== true) throw new OpdError("invalid_transfer", "a queue transfer needs the patient's consent (E2)");
  if (input.reason.trim() === "") throw new OpdError("invalid_transfer", "a queue transfer records why");
  if (input.fromDoctorId === input.toDoctorId) throw new OpdError("invalid_transfer", "source and target doctor are the same");
  return withTx(db, async (tx) => {
    const from = (await tx.select().from(opdDoctors).where(eq(opdDoctors.id, input.fromDoctorId)))[0];
    const to = (await tx.select().from(opdDoctors).where(eq(opdDoctors.id, input.toDoctorId)))[0];
    if (!from || !to) throw new OpdError("invalid_transfer", "unknown doctor");
    if (!from.active || !to.active) throw new OpdError("invalid_transfer", "both doctors must be active");
    if (from.departmentId !== to.departmentId) throw new OpdError("invalid_transfer", "a transfer stays inside the department");

    const toRoomId = await roomForDoctorDay(tx, to.id, input.serviceDate);
    const toSession = await getOrCreateSession(tx, to.id, input.serviceDate, toRoomId);
    const fromSessions = await tx
      .select().from(opdQueueSessions)
      .where(and(eq(opdQueueSessions.doctorId, from.id), eq(opdQueueSessions.serviceDate, input.serviceDate)));
    const fromSession = fromSessions[0];
    if (!fromSession) return { transferred: 0, toSessionId: toSession.id };

    const all = await tx
      .select().from(opdQueueEntries)
      .where(and(eq(opdQueueEntries.sessionId, fromSession.id), inArray(opdQueueEntries.status, [...LIVE_ENTRY_STATUSES])))
      .orderBy(asc(opdQueueEntries.seq));
    const live = input.entryIds === undefined ? all : all.filter((e) => input.entryIds!.includes(e.id));

    let transferred = 0;
    for (const entry of live) {
      const claimed = await tx
        .update(opdQueueEntries)
        .set({ status: "transferred" })
        .where(and(eq(opdQueueEntries.id, entry.id), eq(opdQueueEntries.status, entry.status)))
        .returning({ id: opdQueueEntries.id });
      if (claimed.length === 0) continue; // moved concurrently — skip, never overwrite
      const encounter = (await tx.select().from(opdEncounters).where(eq(opdEncounters.id, entry.encounterId)))[0]!;
      const tokenNo = await allocateToken(tx, toSession.id);
      await tx.insert(opdQueueEntries).values({
        id: newId(), sessionId: toSession.id, encounterId: entry.encounterId, tokenNo, kind: entry.kind,
        appointmentAt: entry.appointmentAt, status: entry.status === "called" ? "waiting" : entry.status,
        danger: entry.danger, reEntry: entry.reEntry, perk: entry.perk, eligibleAt: entry.eligibleAt,
      });
      await tx
        .update(opdEncounters)
        .set({ doctorId: to.id, updatedBy: actor.id, updatedAt: now })
        .where(and(eq(opdEncounters.id, entry.encounterId), eq(opdEncounters.doctorId, from.id)));
      await appendEvent(tx, visitTransferred.make({
        actor, patientId: encounter.patientId, encounterId: encounter.id, correlationId: encounter.workflowInstanceId,
        payload: {
          encounterId: encounter.id, patientId: encounter.patientId, serviceDate: input.serviceDate,
          fromDoctorId: from.id, toDoctorId: to.id, fromSessionId: fromSession.id, toSessionId: toSession.id,
          roomId: toSession.roomId, tokenNo, consented: input.consented, reason: input.reason,
        },
      }));
      transferred++;
    }
    return { transferred, toSessionId: toSession.id };
  });
}

export async function getVisit(
  db: Db,
  encounterId: string,
): Promise<{ encounter: EncounterRow; queueEntries: QueueEntryRow[]; vitals: VitalsRow[]; prescriptions: PrescriptionRow[] } | null> {
  const encounter = await getEncounter(db, encounterId);
  if (!encounter) return null;
  const queueEntries = await db.select().from(opdQueueEntries).where(eq(opdQueueEntries.encounterId, encounterId)).orderBy(asc(opdQueueEntries.seq));
  const vitals = await db.select().from(opdVitals).where(eq(opdVitals.encounterId, encounterId)).orderBy(asc(opdVitals.recordedAt));
  const prescriptions = await db.select().from(opdPrescriptions).where(eq(opdPrescriptions.encounterId, encounterId)).orderBy(asc(opdPrescriptions.version));
  return { encounter, queueEntries, vitals, prescriptions };
}

export async function listVisits(
  db: Db,
  filter: { status?: OpdVisitState; departmentId?: string; doctorId?: string; serviceDate?: string },
  limit = 200,
): Promise<EncounterRow[]> {
  const clauses = [
    filter.status === undefined ? undefined : eq(opdEncounters.status, filter.status),
    filter.departmentId === undefined ? undefined : eq(opdEncounters.departmentId, filter.departmentId),
    filter.doctorId === undefined ? undefined : eq(opdEncounters.doctorId, filter.doctorId),
    filter.serviceDate === undefined ? undefined : eq(opdEncounters.serviceDate, filter.serviceDate),
  ].filter((c) => c !== undefined);
  return db.select().from(opdEncounters).where(clauses.length === 0 ? undefined : and(...clauses)).orderBy(asc(opdEncounters.openedAt)).limit(limit);
}

export type TimelineItem = {
  encounterId: string; serviceDate: string; openedAt: Date; status: string; visitType: string;
  doctorId: string | null; doctorName: string | null; departmentId: string | null; departmentName: string | null;
  diagnosis: string | null; icd10Code: string | null; prescriptionLineCount: number; dangerFlagged: boolean;
};

/**
 * The patient's OPD history, newest first, spanning the merge chain: encounters keep the patient_id they were opened
 * with and a merge never rewrites another module's rows (§6), so the chain is walked at read time.
 */
export async function patientTimeline(db: Db, actor: Actor, patientId: string, limit = 50): Promise<TimelineItem[]> {
  // PLAN 07a T1 — `getPatient`, NOT `resolvePatientId`. The latter is id mapping and says so
  // ("no gate"); using it here left a sealed patient's diagnoses and ICD-10 codes readable to any
  // holder of `opd.visits.read`, which `front_office` holds, while `GET /patients/:id` correctly
  // existence-hid the same person. The refusal below is the SAME `patient_not_found` an absent id
  // produces, so it cannot confirm existence (07a DD2).
  const visible = await getPatient(db, actor, patientId);
  if (!visible) throw new OpdError("patient_not_found", `unknown patient ${patientId}`);
  const canonical = visible.patient.id;
  const chainIds = [canonical, ...(await listMergedLoserIds(db, canonical))];
  const rows = await db
    .select({ encounter: opdEncounters, doctorName: opdDoctors.displayName, departmentName: opdDepartments.name })
    .from(opdEncounters)
    .leftJoin(opdDoctors, eq(opdEncounters.doctorId, opdDoctors.id))
    .leftJoin(opdDepartments, eq(opdEncounters.departmentId, opdDepartments.id))
    .where(inArray(opdEncounters.patientId, chainIds))
    .orderBy(desc(opdEncounters.openedAt))
    .limit(limit);
  const encounterIds = rows.map((r) => r.encounter.id);
  const rx = encounterIds.length === 0
    ? []
    : await db
      .select({ encounterId: opdPrescriptions.encounterId, lines: opdPrescriptions.lines })
      .from(opdPrescriptions)
      .where(and(inArray(opdPrescriptions.encounterId, encounterIds), eq(opdPrescriptions.status, "active")));
  const lineCounts = new Map(rx.map((r) => [r.encounterId, Array.isArray(r.lines) ? r.lines.length : 0] as const));
  return rows.map((r) => ({
    encounterId: r.encounter.id, serviceDate: r.encounter.serviceDate, openedAt: r.encounter.openedAt,
    status: r.encounter.status, visitType: r.encounter.visitType,
    doctorId: r.encounter.doctorId, doctorName: r.doctorName,
    departmentId: r.encounter.departmentId, departmentName: r.departmentName,
    diagnosis: r.encounter.diagnosis, icd10Code: r.encounter.icd10Code,
    prescriptionLineCount: lineCounts.get(r.encounter.id) ?? 0, dangerFlagged: r.encounter.dangerFlagged,
  }));
}
