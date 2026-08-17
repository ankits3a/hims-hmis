import { and, count, desc, eq, gte, lt } from "drizzle-orm";
import type { Actor } from "@hmis/contracts";
import { appendEvent } from "../../kernel/events/append";
import { withTx } from "../../kernel/db/client";
import { opdDoctors, opdEncounters, opdPrescriptions, opdQueueEntries, opdQueueSessions } from "../../kernel/db/schema";
import { loadOpdConfig } from "./config";
import { getEncounter, moveEncounter } from "./encounters";
import { OpdError } from "./errors";
import { admissionRequested, consultationCompleted, consultationStarted, referralIssued } from "./events";
import { doctorForUser } from "./masters";
import { markDone, markInConsult } from "./queue";
import { istMonthBounds } from "./time";
import type { EncounterRow, QueueEntryRow } from "./encounters";
import type { DoctorRow } from "./masters";
import type { Db, Tx } from "../../kernel/db/client";

/** The consult record itself — every field optional, so a doctor may save the note in as many passes as they like. */
export type ConsultNote = {
  chiefComplaint?: string | null;
  diagnosis?: string | null;
  icd10Code?: string | null; // §11.19-E fix 31: capturable at consult, not only at MRD coding
  advice?: string | null;
  admissionAdvised?: boolean;
  referralTo?: string | null;
  referralNote?: string | null;
};

/** The encounter columns a note writes — the same set moveEncounter's patch accepts, so a completion is ONE update. */
type NoteColumns = Partial<Pick<EncounterRow,
  "chiefComplaint" | "diagnosis" | "icd10Code" | "advice" | "admissionAdvised" | "referralTo" | "referralNote">>;

function noteColumns(note: ConsultNote | undefined): NoteColumns {
  const patch: NoteColumns = {};
  if (note === undefined) return patch;
  if (note.chiefComplaint !== undefined) patch.chiefComplaint = note.chiefComplaint;
  if (note.diagnosis !== undefined) patch.diagnosis = note.diagnosis;
  if (note.icd10Code !== undefined) patch.icd10Code = note.icd10Code;
  if (note.advice !== undefined) patch.advice = note.advice;
  if (note.admissionAdvised !== undefined) patch.admissionAdvised = note.admissionAdvised;
  if (note.referralTo !== undefined) patch.referralTo = note.referralTo;
  if (note.referralNote !== undefined) patch.referralNote = note.referralNote;
  return patch;
}

/**
 * D5: only the encounter's OWN doctor may start, note, complete or prescribe — resolved from
 * opd_doctors.user_id, never from a role. Coverage for an absent doctor is the E2 transfer, which
 * moves opd_encounters.doctor_id; from that moment the previous doctor is not_your_patient.
 */
export async function requireTreatingDoctor(db: Db | Tx, actor: Actor, encounter: EncounterRow): Promise<DoctorRow> {
  if (actor.type !== "user") throw new OpdError("user_actor_required", "a consultation is a user action");
  const doctor = await doctorForUser(db, actor.id);
  if (!doctor) throw new OpdError("not_a_doctor", "no OPD doctor profile for this user");
  if (encounter.doctorId !== doctor.id) throw new OpdError("not_your_patient", `encounter ${encounter.id} is not this doctor's`);
  return doctor;
}

/** The encounter's newest queue entry (seq, never id — ledger §3.26) and its session's room: the doctor-day event fields. */
async function entryWhere(tx: Tx, encounterId: string): Promise<{ sessionId: string; roomId: string | null; tokenNo: number }> {
  const entries = await tx
    .select().from(opdQueueEntries).where(eq(opdQueueEntries.encounterId, encounterId))
    .orderBy(desc(opdQueueEntries.seq)).limit(1);
  const entry = entries[0]!;
  const sessions = await tx.select().from(opdQueueSessions).where(eq(opdQueueSessions.id, entry.sessionId));
  return { sessionId: entry.sessionId, roomId: sessions[0]!.roomId, tokenNo: entry.tokenNo };
}

/** waiting → in_consultation, with the queue entry (called OR waiting — a doctor may take a patient without calling). */
export async function startConsultation(
  db: Db, actor: Actor, encounterId: string, now: Date = new Date(),
): Promise<{ encounter: EncounterRow; queueEntry: QueueEntryRow }> {
  const current = await getEncounter(db, encounterId);
  if (!current) throw new OpdError("unknown_encounter", `unknown encounter ${encounterId}`);
  const doctor = await requireTreatingDoctor(db, actor, current);
  if (current.status !== "waiting") {
    throw new OpdError("encounter_state_conflict", `a consultation starts from waiting, not ${current.status}`);
  }
  return withTx(db, async (tx) => {
    const encounter = await moveEncounter(tx, actor, current, "in_consultation", { consultStartedAt: now }, now);
    const queueEntry = await markInConsult(tx, encounterId, now);
    const sessions = await tx.select().from(opdQueueSessions).where(eq(opdQueueSessions.id, queueEntry.sessionId));
    await appendEvent(tx, consultationStarted.make({
      actor, patientId: encounter.patientId, encounterId, correlationId: encounter.workflowInstanceId,
      payload: {
        encounterId, patientId: encounter.patientId, departmentId: encounter.departmentId!,
        doctorId: doctor.id, serviceDate: encounter.serviceDate,
        sessionId: queueEntry.sessionId, roomId: sessions[0]!.roomId, tokenNo: queueEntry.tokenNo,
      },
    }));
    return { encounter, queueEntry };
  });
}

/** The note is not a state move: it writes its own columns under a status-discriminated UPDATE and mints nothing. */
export async function saveConsultNote(
  db: Db, actor: Actor, encounterId: string, note: ConsultNote, now: Date = new Date(),
): Promise<{ encounter: EncounterRow }> {
  const current = await getEncounter(db, encounterId);
  if (!current) throw new OpdError("unknown_encounter", `unknown encounter ${encounterId}`);
  await requireTreatingDoctor(db, actor, current);
  if (current.status !== "in_consultation") {
    throw new OpdError("encounter_state_conflict", `the consult note needs in_consultation, not ${current.status}`);
  }
  const rows = await db
    .update(opdEncounters)
    .set({ ...noteColumns(note), updatedBy: actor.id, updatedAt: now })
    .where(and(eq(opdEncounters.id, encounterId), eq(opdEncounters.status, "in_consultation")))
    .returning();
  if (rows.length === 0) throw new OpdError("encounter_state_conflict", "encounter moved concurrently");
  return { encounter: rows[0]! };
}

export type CompleteConsultationInput = {
  note?: ConsultNote;
  testsOrderedReturnToday: boolean; // true ⇒ awaiting_results (the same-day re-entry class), NOT a completion
  followUpDays?: number; // omitted ⇒ the config default; anything else must be one of cfg.followUpExtensionDays
};

/**
 * §11.1 completion. Either the visit ends (completed, the follow-up window stamped and evented) or it parks
 * in awaiting_results for the same-day return with results — which mints NO completion event, because the
 * consultation has not ended.
 *
 * The extension cap (§11.19-C fix 14) is counted INSIDE the transaction, after a FOR UPDATE of the doctor's
 * own opd_doctors row: that row is outside the encounter's write path (§3.28), so the lock costs nothing and
 * two simultaneous completions by one doctor cannot both read a count below the cap.
 */
export async function completeConsultation(
  db: Db, actor: Actor, encounterId: string, input: CompleteConsultationInput, now: Date = new Date(),
): Promise<{ encounter: EncounterRow }> {
  const current = await getEncounter(db, encounterId);
  if (!current) throw new OpdError("unknown_encounter", `unknown encounter ${encounterId}`);
  const doctor = await requireTreatingDoctor(db, actor, current);
  if (current.status !== "in_consultation") {
    throw new OpdError("encounter_state_conflict", `a completion needs in_consultation, not ${current.status}`);
  }
  const cfg = await loadOpdConfig(db);
  const patch = noteColumns(input.note);

  if (input.testsOrderedReturnToday) {
    return withTx(db, async (tx) => {
      const encounter = await moveEncounter(tx, actor, current, "awaiting_results", patch, now);
      await markDone(tx, encounterId, now);
      return { encounter };
    });
  }

  const followUpDays = input.followUpDays ?? cfg.followUpDefaultDays;
  const followUpExtended = followUpDays !== cfg.followUpDefaultDays;
  if (followUpExtended && !cfg.followUpExtensionDays.includes(followUpDays)) {
    throw new OpdError("invalid_follow_up_days", `follow-up must be ${cfg.followUpDefaultDays} or one of ${cfg.followUpExtensionDays.join(", ")}`);
  }

  return withTx(db, async (tx) => {
    if (followUpExtended) {
      await tx.select({ id: opdDoctors.id }).from(opdDoctors).where(eq(opdDoctors.id, doctor.id)).for("update");
      const { start, end } = istMonthBounds(now);
      const used = await tx
        .select({ n: count() })
        .from(opdEncounters)
        .where(and(
          eq(opdEncounters.doctorId, doctor.id), eq(opdEncounters.followUpExtended, true),
          gte(opdEncounters.consultCompletedAt, start), lt(opdEncounters.consultCompletedAt, end),
        ));
      if ((used[0]?.n ?? 0) >= cfg.extensionCapPerDoctorPerMonth) {
        throw new OpdError("extension_cap_reached", `this doctor has used ${cfg.extensionCapPerDoctorPerMonth} follow-up extensions this month`);
      }
    }

    const encounter = await moveEncounter(
      tx, actor, current, "completed", { ...patch, consultCompletedAt: now, followUpDays, followUpExtended }, now,
    );
    await markDone(tx, encounterId, now);
    const where = await entryWhere(tx, encounterId);
    const issued = await tx
      .select({ n: count() })
      .from(opdPrescriptions)
      .where(and(eq(opdPrescriptions.encounterId, encounterId), eq(opdPrescriptions.status, "active")));
    const env = { actor, patientId: encounter.patientId, encounterId, correlationId: encounter.workflowInstanceId };

    await appendEvent(tx, consultationCompleted.make({ ...env, payload: {
      encounterId, patientId: encounter.patientId, departmentId: encounter.departmentId!,
      doctorId: doctor.id, serviceDate: encounter.serviceDate, ...where,
      visitType: encounter.visitType as "new" | "revisit" | "renewal",
      followUpDays, followUpExtended,
      admissionAdvised: encounter.admissionAdvised,
      referralIssued: encounter.referralTo !== null,
      prescriptionCount: issued[0]?.n ?? 0,
      icd10Code: encounter.icd10Code,
    } }));
    if (encounter.admissionAdvised) {
      await appendEvent(tx, admissionRequested.make({ ...env, payload: {
        encounterId, patientId: encounter.patientId, doctorId: doctor.id, departmentId: encounter.departmentId!, note: null,
      } }));
    }
    if (encounter.referralTo !== null) {
      await appendEvent(tx, referralIssued.make({ ...env, payload: {
        encounterId, patientId: encounter.patientId, doctorId: doctor.id, referralTo: encounter.referralTo, note: encounter.referralNote,
      } }));
    }
    return { encounter };
  });
}
