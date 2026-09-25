import { and, count, desc, eq, gte, lt } from "drizzle-orm";
import { isEyeCode } from "@hmis/contracts";
import type { Actor, Eye } from "@hmis/contracts";
import { appendEvent } from "../../kernel/events/append";
import { withTx } from "../../kernel/db/client";
import { isNull } from "drizzle-orm";
import { opdDoctors, opdEncounterDiagnoses, opdEncounters, opdPrescriptions, opdQueueEntries, opdQueueSessions } from "../../kernel/db/schema";
import { loadOpdConfig } from "./config";
import { getEncounter, moveEncounter } from "./encounters";
import { recordComplaintUsage } from "./complaints";
import { OpdError } from "./errors";
import {
  admissionRequested, consultFeeOverridden, consultationCompleted, consultationParked, consultationResumed,
  consultationStarted, referralIssued,
} from "./events";
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

/**
 * One diagnosis as the doctor committed it: their words, the catalogue code if they picked one, and
 * — for an eye code only — which eye (board "Ophthal": ICD-10 has no laterality, so it rides beside).
 */
export type NoteDiagnosis = { text: string; icd10Code: string | null; laterality?: Eye | null };

/**
 * THE TAG SEPARATOR, AND IT IS NOT A COMMA. `tag-field.tsx` learned this on the first realistic
 * complaint: "fever since 3 days, worse at night" split into two tags, one of them a fragment.
 * A doctor writes commas; nobody types " · ".
 */
export const DIAGNOSIS_SEPARATOR = " · ";

export type ConsultNote = {
  chiefComplaint?: string | null;
  /**
   * THE STRUCTURED DIAGNOSES. When present they are the TRUTH and `diagnosis` / `icd10Code` are
   * derived from them here — never sent by the client — so the display string and the coded rows
   * cannot disagree with each other. A caller that sends `diagnosis` on its own still works and
   * writes one uncoded row per tag; that is the older shape, not a second way to say the same
   * thing in a different order.
   */
  diagnoses?: NoteDiagnosis[] | null;
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
  /**
   * CONSULT V2 (owner, 2026-09-23) — the sections the screen was missing. Each list is REPLACED
   * whole, as the diagnoses are: the doctor edits the list, and a merge would keep what they deleted.
   */
  examination?: ExamFinding[] | null;
  treatment?: string[] | null;
  doctorNote?: string | null;
  internalComment?: string | null;
  diagnosisKind?: DiagnosisKind | null;
  /** D14 — offered/kept at a zero-stock line. `at` and `by` are stamped by the SERVER (see `stampStockChoices`). */
  rxStockChoices?: RxStockChoiceInput[] | null;
  /** D17 — the writing tab's lease token (`lease.ts`). Absent = the shipped client, unchecked. Never stored. */
  leaseToken?: string;
};

export const EXAM_GROUPS = ["general", "systemic", "local"] as const;
export type ExamFinding = { group: (typeof EXAM_GROUPS)[number]; text: string };
export const DIAGNOSIS_KINDS = ["provisional", "final"] as const;
export type DiagnosisKind = (typeof DIAGNOSIS_KINDS)[number];
export type RxStockChoiceInput = { offeredMedicineId: string; keptMedicineId: string; chosen: "swap" | "keep" };
export type RxStockChoice = RxStockChoiceInput & { by: string; at: string };

/**
 * D14 IS AN AUDIT, SO THE CLIENT NEVER NAMES WHO OR WHEN. The list is re-sent whole on every
 * autosave; a choice already on the record keeps its original stamp, and a new one gets this
 * actor and this moment. A client that sent `by`/`at` would have them ignored.
 */
export function stampStockChoices(
  incoming: RxStockChoiceInput[], existing: unknown, actorId: string, now: Date,
): RxStockChoice[] {
  const prior = Array.isArray(existing) ? (existing as RxStockChoice[]) : [];
  const key = (c: RxStockChoiceInput): string => `${c.offeredMedicineId}|${c.keptMedicineId}|${c.chosen}`;
  const priorByKey = new Map(prior.map((c) => [key(c), c]));
  return incoming.map((c) => {
    const was = priorByKey.get(key(c));
    return {
      offeredMedicineId: c.offeredMedicineId, keptMedicineId: c.keptMedicineId, chosen: c.chosen,
      by: was?.by ?? actorId, at: was?.at ?? now.toISOString(),
    };
  });
}

/**
 * The check `saveConsultNote` runs when a note names its tab's token: a token that does not hold a LIVE
 * lease is refused, so a read-only tab cannot write even if its screen were tampered with. A note that
 * names no token is the shipped client and is untouched.
 */
export function assertLeaseFor(
  enc: { editLeaseToken: string | null; editLeaseUntil: Date | null }, token: string | undefined, now: Date,
): void {
  if (token === undefined) return;
  const live = enc.editLeaseToken !== null && enc.editLeaseUntil !== null && enc.editLeaseUntil.getTime() > now.getTime();
  if (live && enc.editLeaseToken !== token) {
    throw new OpdError("edit_lease_state_conflict", "another tab is editing this consultation — take over editing there first", {
      until: enc.editLeaseUntil!.toISOString(),
    });
  }
}

/** The encounter columns a note writes — the same set moveEncounter's patch accepts, so a completion is ONE update. */
type NoteColumns = Partial<Pick<EncounterRow,
  "chiefComplaint" | "diagnosis" | "icd10Code" | "advice" | "admissionAdvised" | "referralTo" | "referralNote"
  | "advisedTests" | "examination" | "treatment" | "doctorNote" | "internalComment" | "diagnosisKind">>;

/**
 * The structured list a note writes, or null when the note says nothing about diagnoses at all.
 * `[]` is a real answer — the doctor cleared the field — and must not be confused with "unchanged".
 */
export function diagnosesOf(note: ConsultNote | undefined): NoteDiagnosis[] | null {
  if (note === undefined) return null;
  if (note.diagnoses !== undefined && note.diagnoses !== null) return note.diagnoses;
  if (note.diagnoses === null) return [];
  if (note.diagnosis === undefined) return null;
  if (note.diagnosis === null) return [];
  /* The older shape: tags, no codes. Splitting here rather than at the call site means one reader. */
  return note.diagnosis
    .split(DIAGNOSIS_SEPARATOR).map((t) => t.trim()).filter((t) => t !== "")
    .map((text) => ({ text, icd10Code: null }));
}

/**
 * Rewrite one encounter's diagnosis rows to match the note. A REPLACE, not a merge: the field is a
 * list the doctor edits whole, and a merge would leave a tag on the record that the doctor had
 * deleted from the screen. Called inside the same transaction as the encounter update, so the
 * display column and the coded rows can never land apart.
 */
async function writeDiagnosisRows(
  tx: Tx, encounterId: string, note: ConsultNote | undefined,
): Promise<void> {
  /*
    `diagnosesOf` — not a check on `diagnoses` alone. A caller that sends only the prose `diagnosis`
    must still get rows, or the structured table quietly misses those encounters and every reader
    that joins it (MRD, a claim, a diagnosis census) reports a blank where a diagnosis was written.
    A table with readers and a path that does not write to it is the same defect in reverse.
  */
  const rows = diagnosesOf(note);
  if (rows === null) return; // the note said nothing about diagnoses; leave what is there
  await tx.delete(opdEncounterDiagnoses).where(eq(opdEncounterDiagnoses.encounterId, encounterId));
  if (rows.length === 0) return;
  await tx.insert(opdEncounterDiagnoses).values(rows.map((d, seq) => ({
    encounterId, seq, text: d.text, icd10Code: d.icd10Code,
    /* An eye beside an ear or a chest code means nothing, so it is dropped here, not trusted from the client. */
    laterality: isEyeCode(d.icd10Code) ? d.laterality ?? null : null,
  })));
}

function noteColumns(note: ConsultNote | undefined): NoteColumns {
  const patch: NoteColumns = {};
  if (note === undefined) return patch;
  if (note.chiefComplaint !== undefined) patch.chiefComplaint = note.chiefComplaint;
  /*
    ═══ THE DISPLAY COLUMNS ARE DERIVED, NEVER TAKEN FROM THE CALLER ═══

    When the note carries structured diagnoses they decide both columns: `diagnosis` is the tags
    joined, and `icd10Code` is the FIRST code present — the primary diagnosis, which is the one a
    claim carries. A client that could send all three could send three that disagree, and the one a
    reader believed would depend on which reader it was.
  */
  const structured = note.diagnoses === undefined ? null : diagnosesOf(note);
  if (structured !== null) {
    patch.diagnosis = structured.length === 0 ? null : structured.map((d) => d.text).join(DIAGNOSIS_SEPARATOR);
    patch.icd10Code = structured.find((d) => d.icd10Code !== null)?.icd10Code ?? null;
  } else {
    if (note.diagnosis !== undefined) patch.diagnosis = note.diagnosis;
    if (note.icd10Code !== undefined) patch.icd10Code = note.icd10Code;
  }
  if (note.advice !== undefined) patch.advice = note.advice;
  if (note.admissionAdvised !== undefined) patch.admissionAdvised = note.admissionAdvised;
  if (note.referralTo !== undefined) patch.referralTo = note.referralTo;
  if (note.referralNote !== undefined) patch.referralNote = note.referralNote;
  if (note.advisedTests !== undefined) patch.advisedTests = note.advisedTests;
  if (note.examination !== undefined) patch.examination = note.examination;
  if (note.treatment !== undefined) patch.treatment = note.treatment;
  if (note.doctorNote !== undefined) patch.doctorNote = note.doctorNote;
  if (note.internalComment !== undefined) patch.internalComment = note.internalComment;
  if (note.diagnosisKind !== undefined) patch.diagnosisKind = note.diagnosisKind;
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

/**
 * ═══ FD-32 — THE SAME SHAPE, ONE DESK EARLIER (OWNER RULING 2026-09-13) ═══
 *
 * Owner: *"I can see a patient who got the token but has not been billed yet is visible in vitals
 * dashboard. I think we must put a guard here. No patient should reach vitals desk until he has
 * paid."*
 *
 * A SECOND REGISTRY RATHER THAN REUSING `consultStartGuards`, and the reason is the bypass. The two
 * doors ask the same question of billing but answer a WAIVER differently: an emergency patient
 * waved past the counter must still reach the nurse, and — the owner's own words — the warning
 * travels with them to every desk after it. One registry shared between the doors would make
 * "bypassed at vitals" silently mean "bypassed at consultation", which is a clinical decision
 * nobody made. Two registries, two verdicts, one bypass column that each reads for itself.
 *
 * Dependency-inverted exactly as the consult registry is: OPD owns the registry and the thrown
 * refusal, billing hands in a verdict function and imports no OPD internals. Keyed, so a second
 * module init in one jest worker REPLACES rather than double-registers.
 */
export type VitalsStartGuard = ConsultStartGuard;

const vitalsStartGuards = new Map<string, VitalsStartGuard>();

/** Registers (or replaces) the vitals-door guard under `key`; returns the unregister function. */
export function registerVitalsStartGuard(key: string, guard: VitalsStartGuard): () => void {
  vitalsStartGuards.set(key, guard);
  return () => {
    vitalsStartGuards.delete(key);
  };
}

/**
 * Every registered verdict, first refusal wins — or `{ok:true}` when the door has already been
 * opened for this visit: by the front desk at the counter, or (owner ruling 2026-09-20) by the bay
 * itself on an emergency save, which stamps the same columns in the saver's name. The bypass is
 * read HERE rather than inside each guard so that a module registering a new guard cannot forget to
 * honour it, and so the audit answer to "who let this patient through" has exactly one place to
 * look. The emergency save's own decision is NOT read here — `recordVitals` owns it, because a
 * verdict function that could be told "this one is urgent" would be a guard with an argument for
 * ignoring itself.
 */
export async function vitalsGateVerdict(
  db: Db | Tx, encounter: EncounterRow,
): Promise<{ ok: true } | { ok: false; code: string; detail?: unknown }> {
  if (encounter.feeBypassBy !== null && encounter.feeBypassReason !== null) return { ok: true };
  for (const guard of vitalsStartGuards.values()) {
    const verdict = await guard(db, encounter);
    if (!verdict.ok) return verdict;
  }
  return { ok: true };
}

/**
 * ══════════ THE DOCTOR OPENS THE TOKEN (OWNER RULING 2026-09-20) ══════════
 *
 * Owner: *"the emergency at the bay doesn't open the doctor's door. It waits for bill to be paid
 * until doctor opens the token from his dashboard manually. Currently the doctor have no screen to
 * do it. But we need it to be built. Once the bill is paid then the token automatically moves to
 * the display board in the queue towards the doctor consultation."*
 *
 * An unsettled token WAITS: `listQueue` holds it out of the callable order, `callNext` will not
 * reach it, and the public board does not announce it. Two things release it and they are not
 * alike — the money arriving is DERIVED (nothing is written; the ledger flips and the next read
 * sees it, which is what "automatically" has to mean if it is never to be wrong), and this, which
 * is a person deciding, and therefore written down.
 *
 * ═══ WHOSE DECISION, AND WHY IT IS NOT THE COUNTER'S ═══
 *
 * `requireTreatingDoctor`: the encounter's OWN doctor, the same rule the note, the park and the
 * completion beside it already carry. A clerk may not seat a patient in a room they do not run,
 * and a doctor down the corridor may not spend this doctor's session on someone else's unpaid
 * patient. It is deliberately NOT `feeBypass*` — FD-32's waiver opens the bay, this opens the
 * consulting room, and one column serving both would turn a nurse's emergency into a doctor's
 * decision nobody made (the owner ruled exactly that, twice).
 *
 * ═══ AND IT DOES NOT MOVE ONE RUPEE ═══
 *
 * The invoice is still owed and still raised; `feeStatus` goes on saying `unsettled` and the ⚠
 * mark goes on riding every desk this visit reaches. What is waived is the ORDER of paying and
 * being seen, for one visit, by a named doctor, for a stated reason. First writer wins: the audit
 * question is who opened the door, and a second call must not be able to re-answer it.
 */
export async function openUnpaidToken(
  db: Db, actor: Actor, encounterId: string, reason: string, now: Date = new Date(),
): Promise<{ encounter: EncounterRow; doctor: DoctorRow }> {
  const current = await getEncounter(db, encounterId);
  if (!current) throw new OpdError("unknown_encounter", `unknown encounter ${encounterId}`);
  const doctor = await requireTreatingDoctor(db, actor, current);
  const trimmed = reason.trim();
  if (trimmed.length < 3) {
    throw new OpdError("reason_required", "say why this patient is being seen before the bill — it is shown at every desk after this one");
  }
  if (current.consultFeeOverrideBy !== null) return { encounter: current, doctor };
  return withTx(db, async (tx) => {
    const updated = await tx
      .update(opdEncounters)
      .set({ consultFeeOverrideBy: actor.id, consultFeeOverrideReason: trimmed, consultFeeOverrideAt: now })
      .where(and(eq(opdEncounters.id, current.id), isNull(opdEncounters.consultFeeOverrideBy)))
      .returning();
    const encounter = updated[0] ?? current;
    /*
      THE EVENT IS THE LEDGER'S COPY. The columns answer "is this token open" on every read; the
      event answers "when, and on whose word" for a month-end that asks why the day's collection is
      short. Appended only on the write that actually landed — a second caller returns above and
      appends nothing, so the ledger cannot say the door was opened twice.
    */
    if (updated.length > 0) {
      await appendEvent(tx, consultFeeOverridden.make({
        actor, patientId: encounter.patientId, encounterId: encounter.id, correlationId: encounter.workflowInstanceId,
        payload: {
          encounterId: encounter.id, patientId: encounter.patientId, doctorId: doctor.id,
          serviceDate: encounter.serviceDate, reason: trimmed,
        },
      }));
    }
    return { encounter, doctor };
  });
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
      /*
        ═══ THE DOCTOR HAS ALREADY DECIDED (OWNER RULING 2026-09-20) ═══

        Owner: *"It waits for bill to be paid until doctor opens the token from his dashboard
        manually."* `openUnpaidToken` is that decision, written down with a name and a sentence on
        it, and this is where it is spent.

        IT EXCUSES ONE CODE AND NOT ONE GUARD. `fee_unsettled` is the money, and the money is the
        only thing a doctor may decide to proceed without; a guard that starts refusing for a
        clinical reason — a sealed patient, a closed session, a statute — must go on refusing a
        doctor who has waived a BILL. Keying on the verdict rather than on the registry key is what
        makes that true for guards this file has never heard of.
      */
      if (verdict.code === "fee_unsettled" && current.consultFeeOverrideBy !== null) continue;
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

/**
 * ═══ PARK — THE PATIENT WHO STEPPED OUT, AND THE ONE WHO VANISHED (owner report, 2026-09-13) ═══
 *
 * *"in between the patient decide to stop and he gets outside for 15 minutes … Since I don't have
 * hold/park patient option/button, I simply clicked on call next button. Now the issue is that old
 * patient gets invisible in the dashboard."*
 *
 * Both halves were real and they are one defect. `callNext` never refused a doctor with somebody in
 * the chair, so the previous patient stayed `in_consult` — correctly, their visit is not over — and
 * **no screen rendered `in_consult` rows**, so a half-seen patient disappeared from the rail with
 * their note half written and their token still live. Nothing was lost; nothing could be found.
 *
 * A PARK IS NOT A STATE MOVE, and that is the whole design:
 *   · the encounter stays `in_consultation`, so the note, the prescription draft and the vitals
 *     stay exactly where the doctor left them and `saveConsultNote` keeps accepting writes;
 *   · the queue entry stays `in_consult`, the value every callable filter already excludes — a
 *     parked patient who became callable again is precisely the accident this prevents (the
 *     `bench_state` precedent, one seat upstream, records the same reasoning);
 *   · so it emits neither a completion nor a second `consultation.started`: the day-report counts
 *     one consultation, and the wait-time figures measured from the start keep their baseline.
 *
 * What changes is one timestamp, and with it what the rail can say: "with you now" against "held
 * aside since 11:20".
 */
export async function parkConsultation(
  db: Db, actor: Actor, encounterId: string, now: Date = new Date(),
): Promise<{ encounter: EncounterRow; queueEntry: QueueEntryRow }> {
  const current = await getEncounter(db, encounterId);
  if (!current) throw new OpdError("unknown_encounter", `unknown encounter ${encounterId}`);
  const doctor = await requireTreatingDoctor(db, actor, current);
  if (current.status !== "in_consultation") {
    throw new OpdError("encounter_state_conflict", `a park needs in_consultation, not ${current.status}`);
  }
  return withTx(db, async (tx) => {
    const entry = (await tx
      .select().from(opdQueueEntries).where(eq(opdQueueEntries.encounterId, encounterId))
      .orderBy(desc(opdQueueEntries.seq)).limit(1))[0];
    if (!entry) throw new OpdError("unknown_queue_entry", `no queue entry for encounter ${encounterId}`);
    if (entry.status !== "in_consult") {
      throw new OpdError("queue_entry_state_conflict", `a park needs an in-consult entry, not ${entry.status}`);
    }
    if (entry.parkedAt !== null) throw new OpdError("queue_entry_state_conflict", "this patient is already parked");
    // The belt, and the same shape every other writer here uses: a second click that lost the race
    // finds `parked_at` already set and answers the state conflict rather than restamping the clock.
    const updated = await tx
      .update(opdQueueEntries)
      .set({ parkedAt: now, parkedBy: actor.id })
      .where(and(eq(opdQueueEntries.id, entry.id), eq(opdQueueEntries.status, "in_consult"), isNull(opdQueueEntries.parkedAt)))
      .returning();
    if (updated.length === 0) throw new OpdError("queue_entry_state_conflict", "entry moved concurrently");
    const queueEntry = updated[0]!;
    const session = (await tx.select().from(opdQueueSessions).where(eq(opdQueueSessions.id, queueEntry.sessionId)))[0]!;
    await appendEvent(tx, consultationParked.make({
      actor, patientId: current.patientId, encounterId, correlationId: current.workflowInstanceId,
      payload: {
        encounterId, patientId: current.patientId, entryId: queueEntry.id,
        doctorId: doctor.id, serviceDate: current.serviceDate,
        sessionId: session.id, roomId: session.roomId, tokenNo: queueEntry.tokenNo,
        parkedAt: now.toISOString(),
      },
    }));
    return { encounter: current, queueEntry };
  });
}

/**
 * The patient came back. One column write and no re-queue — *"her turn was held, not lost"* — and
 * `parkedMs` on the event is the honest measure of the fifteen minutes the owner described.
 *
 * It is the exact inverse of `parkConsultation` and refuses the same way: an entry that is not
 * parked has nothing to resume, and saying so is better than silently succeeding on a row whose
 * consultation never stopped.
 */
export async function resumeConsultation(
  db: Db, actor: Actor, encounterId: string, now: Date = new Date(),
): Promise<{ encounter: EncounterRow; queueEntry: QueueEntryRow }> {
  const current = await getEncounter(db, encounterId);
  if (!current) throw new OpdError("unknown_encounter", `unknown encounter ${encounterId}`);
  const doctor = await requireTreatingDoctor(db, actor, current);
  if (current.status !== "in_consultation") {
    throw new OpdError("encounter_state_conflict", `a resume needs in_consultation, not ${current.status}`);
  }
  return withTx(db, async (tx) => {
    const entry = (await tx
      .select().from(opdQueueEntries).where(eq(opdQueueEntries.encounterId, encounterId))
      .orderBy(desc(opdQueueEntries.seq)).limit(1))[0];
    if (!entry) throw new OpdError("unknown_queue_entry", `no queue entry for encounter ${encounterId}`);
    const parkedAt = entry.parkedAt;
    if (parkedAt === null) throw new OpdError("queue_entry_state_conflict", "this patient is not parked");
    const updated = await tx
      .update(opdQueueEntries)
      .set({ parkedAt: null, parkedBy: null })
      .where(and(eq(opdQueueEntries.id, entry.id), eq(opdQueueEntries.parkedAt, parkedAt)))
      .returning();
    if (updated.length === 0) throw new OpdError("queue_entry_state_conflict", "entry moved concurrently");
    const queueEntry = updated[0]!;
    const session = (await tx.select().from(opdQueueSessions).where(eq(opdQueueSessions.id, queueEntry.sessionId)))[0]!;
    await appendEvent(tx, consultationResumed.make({
      actor, patientId: current.patientId, encounterId, correlationId: current.workflowInstanceId,
      payload: {
        encounterId, patientId: current.patientId, entryId: queueEntry.id,
        doctorId: doctor.id, serviceDate: current.serviceDate,
        sessionId: session.id, roomId: session.roomId, tokenNo: queueEntry.tokenNo,
        parkedAt: parkedAt.toISOString(), parkedMs: Math.max(0, now.getTime() - parkedAt.getTime()),
      },
    }));
    return { encounter: current, queueEntry };
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
  assertLeaseFor(current, note.leaseToken, now);
  /*
    ONE TRANSACTION, because the de-normalised `diagnosis` string on the encounter and the coded
    rows beside it are two statements of the same fact. A note that wrote one and not the other
    would leave a claim quoting a code the note does not carry, and nothing would ever say so.
  */
  return withTx(db, async (tx) => {
    const rows = await tx
      .update(opdEncounters)
      .set({
        ...noteColumns(note),
        ...(note.rxStockChoices === undefined ? {} : {
          rxStockChoices: note.rxStockChoices === null ? null : stampStockChoices(note.rxStockChoices, current.rxStockChoices, actor.id, now),
        }),
        updatedBy: actor.id, updatedAt: now,
      })
      .where(and(eq(opdEncounters.id, encounterId), eq(opdEncounters.status, "in_consultation")))
      .returning();
    if (rows.length === 0) throw new OpdError("encounter_state_conflict", "encounter moved concurrently");
    await writeDiagnosisRows(tx, encounterId, note);
    return { encounter: rows[0]! };
  });
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
  assertLeaseFor(current, input.note?.leaseToken, now);
  const cfg = await loadOpdConfig(db);
  const patch = noteColumns(input.note);

  if (input.testsOrderedReturnToday) {
    return withTx(db, async (tx) => {
      const encounter = await moveEncounter(tx, actor, current, "awaiting_results", patch, now);
      await writeDiagnosisRows(tx, encounterId, input.note);
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
    /*
      BEFORE the event is appended, not after: `consultationCompleted` carries `icd10Code`, and that
      value comes off the encounter row this patch just wrote. The rows and the column are derived
      from the same list, so the event and the record agree by construction.
    */
    await writeDiagnosisRows(tx, encounterId, input.note);
    /*
      ═══ THE VOCABULARY LEARNS HERE, AND ONLY HERE ═══

      Every complaint phrase on a COMPLETED consultation is counted, mapped or not — which is what
      makes a doctor's own shorthand start being offered back to them, and what builds the worklist
      of phrases nobody has mapped yet.

      At completion rather than at save: the note autosaves on every blur, so counting there would
      score a phrase by how often the doctor tabbed out of the box. A completion happens once per
      encounter and is the honest unit. The same reasoning `curation.ts` gives for counting the
      PRESCRIBING stream rather than every keystroke that touched a prescription.
    */
    const complaint = encounter.chiefComplaint ?? "";
    if (complaint.trim() !== "") {
      await recordComplaintUsage(tx, doctor.id, complaint.split(" · ").map((x) => x.trim()), now);
    }
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
