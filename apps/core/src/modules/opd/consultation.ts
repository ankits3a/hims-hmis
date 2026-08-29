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
/**
 * PLAN 07d T5 / DD4 — ONE ADVISED TEST. `pricePaise` is a SNAPSHOT taken at the moment of advice,
 * not a reference resolved at print time: E-9 rules that the slip carries an as-of date and the
 * counter reprices, and a snapshot is what makes the printed sheet honest about being a quotation
 * from a particular afternoon. `serviceId` is kept so Plan 17 can read the demand signal without
 * matching on names.
 */
export type AdvisedTest = {
  serviceId: string;
  code: string;
  name: string;
  pricePaise: number;
};

export type ConsultNote = {
  chiefComplaint?: string | null;
  diagnosis?: string | null;
  icd10Code?: string | null; // §11.19-E fix 31: capturable at consult, not only at MRD coding
  advice?: string | null;
  admissionAdvised?: boolean;
  referralTo?: string | null;
  referralNote?: string | null;
  /**
   * PLAN 07d T5 — advised tests ride the CONSULT NOTE rather than a route of their own, and that is
   * what makes them free of new authority: `saveConsultNote` already requires the encounter's own
   * treating doctor and an `in_consultation` state, so nobody else can write them and they cannot
   * be added to a finished visit.
   */
  advisedTests?: AdvisedTest[] | null;
};

/** The encounter columns a note writes — the same set moveEncounter's patch accepts, so a completion is ONE update. */
type NoteColumns = Partial<Pick<EncounterRow,
  "chiefComplaint" | "diagnosis" | "icd10Code" | "advice" | "admissionAdvised" | "referralTo" | "referralNote"
  | "advisedTests">>;

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
  if (note.advisedTests !== undefined) patch.advisedTests = note.advisedTests;
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

/**
 * Plan 08 D8 — the pay-before-consult hook, dependency-inverted so OPD never imports billing.
 * A guard returns a VERDICT; this module owns the thrown error, so a billing failure inside an
 * OPD route can never surface as anything but `consult_gate_refused` (a foreign error class here
 * would 500). The registry is KEYED: re-registering under the same key REPLACES, which keeps it
 * idempotent across the jest testing modules that share one worker — an array would double-register.
 */
export type ConsultStartGuard = (
  db: Db | Tx,
  encounter: EncounterRow,
) => Promise<{ ok: true } | { ok: false; code: string; detail?: unknown }>;

const consultStartGuards = new Map<string, ConsultStartGuard>();

/** Registers (or replaces) the guard under `key` and returns the unregister function. */
export function registerConsultStartGuard(key: string, guard: ConsultStartGuard): () => void {
  consultStartGuards.set(key, guard);
  return () => {
    consultStartGuards.delete(key);
  };
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
  // D8: every registered guard is consulted BEFORE any write. No guard registered ⇒ shipped behaviour.
  for (const [key, guard] of consultStartGuards) {
    const verdict = await guard(db, current);
    if (!verdict.ok) {
      throw new OpdError(
        "consult_gate_refused",
        `consult start refused by ${key}: ${verdict.code}`,
        { guard: key, code: verdict.code, detail: verdict.detail },
      );
    }
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
