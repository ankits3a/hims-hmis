import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put, Query } from "@nestjs/common";
import { z } from "zod";
import type { Actor } from "@hmis/contracts";
import { CONFIG, DB } from "../../kernel/tokens";
import { CurrentActor, RequirePermission } from "../../kernel/auth/decorators";
import { withTx } from "../../kernel/db/client";
import { DIAGNOSIS_KINDS, EXAM_GROUPS, completeConsultation, openUnpaidToken, parkConsultation, resumeConsultation, saveConsultNote, startConsultation } from "./consultation";
import { activeReminder, clearReminder, setReminder } from "./reminders";
import { acquireEditLease, releaseEditLease } from "./lease";
import type { LeaseAnswer } from "./lease";
import { referInternally } from "./referral";
import { saveVisitSection, visitSections } from "./sections";
import { visitLayout } from "./layout";
import type { VisitLayout } from "./layout";
import type { SectionRecordView, VisitSections } from "./sections";
import { printGlassesRx } from "./glasses-print";
import type { ReminderView } from "./reminders";
import { transferQueue } from "./encounters";
import { parsed, toHttp } from "./opd-masters.controller";
import {
  getPrescriptionPrint, issuePrescription, listPrescriptions, precheckPrescription, verifyPrescriptionQr,
} from "./prescriptions";
import { discardDraft, getPendingDraft, issueDraft, saveDraft } from "./prescription-drafts";
import { SKIP_REASONS } from "./skip-reasons";
import { boardSnapshot, callNext, listQueue, recallCalled, skipCalled, summaryByDoctor, undoSkip } from "./queue";
import { setSessionStatus } from "./sessions";
import { istDate } from "./time";
import type { EncounterRow, PrescriptionRow, QueueEntryRow } from "./encounters";
import type { IssuedPrescription, RxPrecheckResult, RxPrintData, RxVerifyResult } from "./prescriptions";
import type { DraftRow } from "./prescription-drafts";
import type { BoardItem, DoctorSummary, QueueView } from "./queue";
import type { SessionRow } from "./sessions";
import type { AppConfig } from "../../kernel/config";
import type { Db } from "../../kernel/db/client";

const summaryQuery = z.object({ departmentId: z.string().min(1).optional(), serviceDate: z.string().max(10).optional() });
const boardQuery = z.object({ serviceDate: z.string().max(10).optional(), roomIds: z.string().max(2000).optional() });
const transferBody = z.object({
  fromDoctorId: z.string().min(1),
  toDoctorId: z.string().min(1),
  serviceDate: z.string().min(1).max(10),
  entryIds: z.array(z.string().min(1)).optional(),
  consented: z.boolean(),
  reason: z.string().max(500),
});
const queueQuery = z.object({ doctorId: z.string().min(1), serviceDate: z.string().max(10).optional() });
const sessionStatusBody = z.object({ status: z.enum(["in", "out", "closed"]) });
/** The doctor's sentence for seeing a patient before the bill — shown at every desk after this one. */
const openUnpaidBody = z.object({ reason: z.string().max(500) });
/**
 * THE SKIP NOW STATES ITS REASON (owner, 2026-09-13). `reason` is REQUIRED, so the shipped client
 * that posted an empty body gets a 400 rather than writing a reasonless skip — which is the right
 * direction for a field whose whole point is that it is never absent. The note is bounded like
 * every other free-text field here; `skipCalled` — not zod — refuses an empty note under `other`,
 * so the client gets `reason_required` with an OPD code it can map to the box rather than a schema
 * error it cannot.
 */
const skipBody = z.object({ reason: z.enum(SKIP_REASONS), note: z.string().max(500).nullish() });
const consultNoteBody = z.object({
  chiefComplaint: z.string().max(2000).nullable().optional(),
  /**
   * THE DIAGNOSES, AS A LIST. Bounded for the same reason `advisedTests` is: an unbounded array on
   * a request body is a body somebody can make arbitrarily large. Twelve is a consultation's worth
   * of a primary diagnosis and its comorbidities.
   *
   * `diagnosis` and `icd10Code` below are still accepted — an older caller writing prose is a
   * caller that still works — but when `diagnoses` is present the server DERIVES both from it and
   * ignores what was sent, so the display string and the coded rows cannot be made to disagree.
   */
  diagnoses: z.array(z.object({
    text: z.string().min(1).max(300),
    icd10Code: z.string().max(20).nullable(),
    /** Which eye, for an eye code (board "Ophthal"). The server drops it on any other code. */
    laterality: z.enum(["od", "os", "ou"]).nullable().optional(),
  })).max(12).nullable().optional(),
  diagnosis: z.string().max(2000).nullable().optional(),
  icd10Code: z.string().max(20).nullable().optional(),
  advice: z.string().max(4000).nullable().optional(),
  admissionAdvised: z.boolean().optional(),
  referralTo: z.string().max(200).nullable().optional(),
  referralNote: z.string().max(2000).nullable().optional(),
  /**
   * PLAN 07d T5 / DD4 — advised tests, bounded on the way in. The cap of 20 is not arbitrary: it is
   * a consultation's worth of advice, and an unbounded array on a jsonb column is a request body
   * somebody can make arbitrarily large. `pricePaise` is a NON-NEGATIVE INTEGER for the reason
   * money is paise everywhere in this tree — a float here would print a rounded rupee on a slip a
   * patient is quoted from.
   */
  advisedTests: z.array(z.object({
    serviceId: z.string().min(1).max(64),
    code: z.string().min(1).max(64),
    name: z.string().min(1).max(300),
    pricePaise: z.number().int().nonnegative(),
  })).max(20).nullable().optional(),
  /**
   * CONSULT V2 — bounded like everything else on this body. Sixty findings is a thorough examination;
   * thirty treatment lines is more than any OPD room gives.
   */
  examination: z.array(z.object({ group: z.enum(EXAM_GROUPS), text: z.string().min(1).max(300) })).max(60).nullable().optional(),
  treatment: z.array(z.string().min(1).max(300)).max(30).nullable().optional(),
  doctorNote: z.string().max(4000).nullable().optional(),
  internalComment: z.string().max(4000).nullable().optional(),
  diagnosisKind: z.enum(DIAGNOSIS_KINDS).nullable().optional(),
  // D14 — only what was offered and what was kept; `by`/`at` are the server's (`stampStockChoices`).
  rxStockChoices: z.array(z.object({
    offeredMedicineId: z.string().min(1).max(64),
    keptMedicineId: z.string().min(1).max(64),
    chosen: z.enum(["swap", "keep"]),
  })).max(30).nullable().optional(),
  leaseToken: z.string().min(8).max(64).optional(),
});
const reminderBody = z.object({ text: z.string().trim().min(1).max(300) });
const leaseBody = z.object({ token: z.string().min(8).max(64), takeover: z.boolean().optional() });
const referBody = z.object({
  departmentId: z.string().min(1).max(64), doctorId: z.string().min(1).max(64),
  reason: z.string().trim().min(3).max(300), note: z.string().max(2000).nullish(),
});
const consultCompleteBody = z.object({
  note: consultNoteBody.optional(),
  testsOrderedReturnToday: z.boolean(),
  followUpDays: z.number().int().positive().optional(), // anything but the default must be a configured extension
});
const rxLineBody = z.object({
  drug: z.string().max(300),
  dose: z.string().max(100),
  route: z.string().max(100),
  // 200, not 100, only so a tapered line's text fits (8 steps of "12×/day × 60d" is 132): the
  // refine below keeps a plain line at 100, and a tapered line's frequency is overwritten by the
  // server's own `taperText` at issue anyway.
  frequency: z.string().max(200),
  durationDays: z.number().int().positive().nullable(),
  instructions: z.string().max(2000).nullable(),
  noSubstitution: z.boolean(),
  // PLAN 16a T5 / DD9 — optional and nullable: the autocomplete sets it, free typing does not, and
  // design law 1 says a line without one is a perfectly legal prescription for ever.
  medicineId: z.string().min(1).max(64).nullish(),
  // The ophthal line (board "Ophthal", 2026-09-23). Undeclared keys are STRIPPED by zod, so these
  // two must be named here or an eye line would issue with no eye.
  eye: z.enum(["od", "os", "ou"]).nullish(),
  taper: z.array(z.object({
    timesPerDay: z.number().int().min(1).max(12),
    days: z.number().int().min(1).max(60),
  })).min(2).max(8).nullish(),
}).refine((l) => (l.taper ?? null) !== null || l.frequency.length <= 100, {
  path: ["frequency"], message: "String must contain at most 100 character(s)",
});
// No .min(1) on lines: an empty prescription answers empty_prescription with its OPD code, not a zod 400.
const prescriptionBody = z.object({
  lines: z.array(rxLineBody),
  overrides: z.array(z.object({
    lineIndex: z.number().int().nonnegative(), substance: z.string().max(200), reason: z.string().max(500),
  })).optional(),
  // PLAN 16a T5 / DD3 — one array per hard-warning kind, each in `overrides`' own grammar. A reason
  // shorter than the shipped minimum is refused by `issuePrescription`, not by zod, so the client
  // gets `override_reason_required` and not a schema error it cannot map to a field.
  // C5 — an override NAMES the hit it clears. Without the identity it clears nothing, which is the
  // fail-safe direction: a doctor sees a warning twice rather than never seeing the second one.
  interactionOverrides: z.array(z.object({
    lineIndex: z.number().int().nonnegative(), reason: z.string().max(500),
    saltPair: z.tuple([z.string().min(1), z.string().min(1)]).optional(),
  })).optional(),
  duplicateOverrides: z.array(z.object({
    lineIndex: z.number().int().nonnegative(), reason: z.string().max(500),
    moiety: z.string().min(1).max(200).optional(),
  })).optional(),
});
/** The pre-check takes the lines alone: nothing is written, so nothing else is needed. */
const precheckBody = z.object({ lines: z.array(rxLineBody) });
/**
 * FD-30 — the transcription. The SAME `rxLineBody` the prescription takes, because the draft is
 * handed to `issuePrescription` unchanged and a draft that could hold a line the issue route would
 * refuse is a slip the doctor cannot tap.
 *
 * NO OVERRIDE ARRAYS. A scribe cannot pre-clear an allergy conflict, a severe interaction or a
 * duplicate salt: clearing one is a clinical judgement with a mandatory reason recorded against the
 * prescriber. The warnings surface at the doctor's tap and the reasons are typed there.
 */
const draftBody = z.object({
  lines: z.array(rxLineBody),
  note: z.string().max(2000).nullish(),
});
/** The tap. Overrides ride HERE, with the doctor, for the reason `draftBody` states. */
const issueDraftBody = z.object({
  overrides: z.array(z.object({
    lineIndex: z.number().int().nonnegative(), substance: z.string().max(200), reason: z.string().max(500),
  })).optional(),
  interactionOverrides: z.array(z.object({
    lineIndex: z.number().int().nonnegative(), reason: z.string().max(500),
    saltPair: z.tuple([z.string().min(1), z.string().min(1)]).optional(),
  })).optional(),
  duplicateOverrides: z.array(z.object({
    lineIndex: z.number().int().nonnegative(), reason: z.string().max(500),
    moiety: z.string().min(1).max(200).optional(),
  })).optional(),
});
const verifyBody = z.object({ payload: z.string().min(1).max(500) });

/** The section's own schema validates the body (sections.ts); the route bounds only the envelope. */
const sectionBody = z.object({ body: z.record(z.string(), z.unknown()), leaseToken: z.string().min(1).max(64).nullable().optional() });

@Controller("opd")
export class OpdQueueController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly cfg: AppConfig,
  ) {}

  // ——— literal-segment routes FIRST: summary / board / transfer would otherwise be eaten by ':sessionId' ———

  @RequirePermission("opd.queue.read", "hospital")
  @Get("queues/summary")
  async summary(@Query() query: unknown): Promise<{ items: DoctorSummary[] }> {
    const q = parsed(summaryQuery, query);
    try {
      return { items: await summaryByDoctor(this.db, q.departmentId, q.serviceDate ?? istDate(new Date())) };
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("opd.display.read", "hospital")
  @Get("queues/board")
  async board(@Query() query: unknown): Promise<{ items: BoardItem[] }> {
    const q = parsed(boardQuery, query);
    const roomIds = q.roomIds === undefined ? undefined : q.roomIds.split(",").filter((s) => s !== "");
    try {
      return { items: await boardSnapshot(this.db, q.serviceDate ?? istDate(new Date()), roomIds) };
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("opd.queue.transfer", "hospital")
  @Post("queues/transfer")
  async transfer(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<{ transferred: number; toSessionId: string }> {
    const b = parsed(transferBody, body);
    try {
      return await transferQueue(this.db, actor, b);
    } catch (e) {
      toHttp(e);
    }
  }

  // ——— the doctor-day queue ———

  @RequirePermission("opd.queue.read", "hospital")
  @Get("queues")
  async queue(@CurrentActor() actor: Actor, @Query() query: unknown): Promise<QueueView | { session: null }> {
    const q = parsed(queueQuery, query);
    try {
      return (await listQueue(this.db, actor, q.doctorId, q.serviceDate ?? istDate(new Date()))) ?? { session: null };
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("opd.queue.operate", "hospital")
  @Post("queues/:sessionId/call-next")
  async callNext(
    @CurrentActor() actor: Actor, @Param("sessionId") sessionId: string,
  ): Promise<{ entry: QueueEntryRow | null; encounter: EncounterRow | null }> {
    try {
      return await callNext(this.db, actor, sessionId);
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("opd.queue.operate", "hospital")
  @Post("queues/:sessionId/status")
  async sessionStatus(
    @CurrentActor() actor: Actor, @Param("sessionId") sessionId: string, @Body() body: unknown,
  ): Promise<{ session: SessionRow }> {
    const b = parsed(sessionStatusBody, body);
    try {
      return { session: await withTx(this.db, (tx) => setSessionStatus(tx, actor, sessionId, b.status)) };
    } catch (e) {
      toHttp(e);
    }
  }

  /** CONSULT V2 — the alarm on a called card: the board says the same token again (`recallCalled`). */
  @RequirePermission("opd.queue.operate", "hospital")
  @Post("queues/entries/:entryId/recall")
  async recall(@CurrentActor() actor: Actor, @Param("entryId") entryId: string): Promise<{ entry: QueueEntryRow }> {
    try {
      return await recallCalled(this.db, actor, entryId);
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("opd.queue.operate", "hospital")
  @Post("queues/entries/:entryId/skip")
  async skip(@CurrentActor() actor: Actor, @Param("entryId") entryId: string, @Body() body: unknown): Promise<{ entry: QueueEntryRow }> {
    const b = parsed(skipBody, body);
    try {
      return await skipCalled(this.db, actor, entryId, { reason: b.reason, note: b.note ?? null });
    } catch (e) {
      toHttp(e);
    }
  }

  /**
   * THE SKIP TAKEN BACK — `opd.queue.operate`, the same grant that made the skip. A doctor who can
   * pass a patient over can put them back, and a correction that needed a second authority would be
   * a correction nobody makes at the moment it matters.
   */
  @RequirePermission("opd.queue.operate", "hospital")
  @Post("queues/entries/:entryId/undo-skip")
  async undoSkipped(@CurrentActor() actor: Actor, @Param("entryId") entryId: string): Promise<{ entry: QueueEntryRow }> {
    try {
      return await undoSkip(this.db, actor, entryId);
    } catch (e) {
      toHttp(e);
    }
  }

  // ——— the consultation ———

  /**
   * ═══ THE DOCTOR OPENS AN UNSETTLED TOKEN (OWNER RULING 2026-09-20) ═══
   *
   * *"It waits for bill to be paid until doctor opens the token from his dashboard manually.
   * Currently the doctor have no screen to do it. But we need it to be built."*
   *
   * `opd.consult` and NO new permission: this is not a new authority but the one every doctor
   * already holds over their own session, and `openUnpaidToken` refuses anybody who is not this
   * encounter's treating doctor (`requireTreatingDoctor`, the same rule as the note, the park and
   * the completion). A permission of its own would be a second name for a grant that exists, and
   * `seed-roles.ts` pins the count. Deliberately not the cashier's and not the front desk's: a
   * counter that can excuse its own collection is the separation this hospital draws everywhere.
   */
  @RequirePermission("opd.consult", "hospital")
  @Post("visits/:id/consult/open-unpaid")
  async openUnpaid(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() body: unknown): Promise<{ encounter: EncounterRow }> {
    const b = parsed(openUnpaidBody, body);
    try {
      return { encounter: (await openUnpaidToken(this.db, actor, id, b.reason)).encounter };
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("opd.consult", "hospital")
  @Post("visits/:id/consult/start")
  async start(@CurrentActor() actor: Actor, @Param("id") id: string): Promise<{ encounter: EncounterRow; queueEntry: QueueEntryRow }> {
    try {
      return await startConsultation(this.db, actor, id);
    } catch (e) {
      toHttp(e);
    }
  }

  /**
   * PARK / RESUME (owner report, 2026-09-13) — the patient who stepped out mid-consultation.
   *
   * `opd.consult` and no new permission, because this is not a new authority: both acts are
   * refused by `requireTreatingDoctor` to anybody but the encounter's own doctor, exactly like the
   * note and the completion beside them. A permission of their own would be a second name for a
   * grant every doctor already holds, and `seed-roles.ts` pins the count.
   */
  @RequirePermission("opd.consult", "hospital")
  @Post("visits/:id/consult/park")
  async park(@CurrentActor() actor: Actor, @Param("id") id: string): Promise<{ encounter: EncounterRow; queueEntry: QueueEntryRow }> {
    try {
      return await parkConsultation(this.db, actor, id);
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("opd.consult", "hospital")
  @Post("visits/:id/consult/resume")
  async resume(@CurrentActor() actor: Actor, @Param("id") id: string): Promise<{ encounter: EncounterRow; queueEntry: QueueEntryRow }> {
    try {
      return await resumeConsultation(this.db, actor, id);
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("opd.consult", "hospital")
  @Put("visits/:id/consult/note")
  async note(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() body: unknown): Promise<{ encounter: EncounterRow }> {
    const b = parsed(consultNoteBody, body);
    try {
      return await saveConsultNote(this.db, actor, id, b);
    } catch (e) {
      toHttp(e);
    }
  }

  /** Consult engine (sections.ts) — the department's specialty sections for this visit, and what is recorded in them. */
  @RequirePermission("opd.consult", "hospital")
  @Get("visits/:id/sections")
  async sections(@CurrentActor() actor: Actor, @Param("id") id: string): Promise<VisitSections> {
    try {
      return await visitSections(this.db, actor, id);
    } catch (e) {
      toHttp(e);
    }
  }

  /** Consult layout (layout.ts) — which consult sections this visit shows, in what order, under the versions it started with. */
  @RequirePermission("opd.consult", "hospital")
  @Get("visits/:id/layout")
  async layout(@CurrentActor() actor: Actor, @Param("id") id: string): Promise<VisitLayout> {
    try {
      return await visitLayout(this.db, actor, id);
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("opd.consult", "hospital")
  @Put("visits/:id/sections/:key")
  async saveSection(
    @CurrentActor() actor: Actor, @Param("id") id: string, @Param("key") key: string, @Body() body: unknown,
  ): Promise<{ record: SectionRecordView }> {
    const b = parsed(sectionBody, body);
    try {
      return { record: await saveVisitSection(this.db, actor, id, key, b) };
    } catch (e) {
      toHttp(e);
    }
  }

  /**
   * Board "Ophthal" — "Print glasses Rx": one A4 job to the front desk for the CURRENT version of
   * the visit's glasses prescription (glasses-print.ts). The treating doctor only, in any status.
   * `queued: false` means this version is already coming — success, not failure.
   */
  @RequirePermission("opd.consult", "hospital")
  @Post("visits/:id/glasses-rx/print")
  async printGlassesRx(@CurrentActor() actor: Actor, @Param("id") id: string): Promise<{ queued: boolean }> {
    try {
      return await printGlassesRx(this.db, actor, id);
    } catch (e) {
      toHttp(e);
    }
  }

  /**
   * CONSULT V2 — THE PATIENT REMINDER. Read and written by whoever conducts consultations
   * (`opd.consult`), not by the desk: it is a clinician's note on the patient. `reminders.ts` gates the
   * patient through `getPatient`, so a sealed record answers like an absent one.
   */
  @RequirePermission("opd.consult", "hospital")
  @Get("patients/:patientId/reminder")
  async reminder(@CurrentActor() actor: Actor, @Param("patientId") patientId: string): Promise<{ reminder: ReminderView | null }> {
    try {
      return { reminder: await activeReminder(this.db, actor, patientId) };
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("opd.consult", "hospital")
  @Put("patients/:patientId/reminder")
  async putReminder(@CurrentActor() actor: Actor, @Param("patientId") patientId: string, @Body() body: unknown): Promise<{ reminder: ReminderView }> {
    const b = parsed(reminderBody, body);
    try {
      return { reminder: await setReminder(this.db, actor, patientId, b.text) };
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("opd.consult", "hospital")
  @Post("patients/:patientId/reminder/clear")
  async clearReminderRoute(@CurrentActor() actor: Actor, @Param("patientId") patientId: string): Promise<{ cleared: boolean }> {
    try {
      return await clearReminder(this.db, actor, patientId);
    } catch (e) {
      toHttp(e);
    }
  }

  /** D17 — the writing tab's lease: take, renew (the heartbeat), or take over. */
  @RequirePermission("opd.consult", "hospital")
  @Post("visits/:id/consult/lease")
  async lease(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() body: unknown): Promise<LeaseAnswer> {
    const b = parsed(leaseBody, body);
    try {
      return await acquireEditLease(this.db, actor, id, b.token, { takeover: b.takeover === true });
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("opd.consult", "hospital")
  @Post("visits/:id/consult/lease/release")
  async leaseRelease(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() body: unknown): Promise<{ released: boolean }> {
    const b = parsed(leaseBody, body);
    try {
      return await releaseEditLease(this.db, actor, id, b.token);
    } catch (e) {
      toHttp(e);
    }
  }

  /** CONSULT V2 — refer to another department's doctor: a new visit in that line, no re-registration. */
  @RequirePermission("opd.consult", "hospital")
  @Post("visits/:id/refer")
  async refer(
    @CurrentActor() actor: Actor, @Param("id") id: string, @Body() body: unknown,
  ): Promise<{ encounterId: string; tokenNo: number; visitNo: string; visitType: string }> {
    const b = parsed(referBody, body);
    try {
      return await referInternally(this.db, actor, id, b);
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("opd.consult", "hospital")
  @Post("visits/:id/consult/complete")
  async complete(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() body: unknown): Promise<{ encounter: EncounterRow }> {
    const b = parsed(consultCompleteBody, body);
    try {
      return await completeConsultation(this.db, actor, id, b);
    } catch (e) {
      toHttp(e);
    }
  }

  // ——— the e-Rx ———

  @RequirePermission("opd.consult", "hospital")
  @Post("visits/:id/prescriptions")
  async prescribe(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() body: unknown): Promise<IssuedPrescription> {
    const b = parsed(prescriptionBody, body);
    try {
      return await issuePrescription(this.db, actor, this.cfg, id, b);
    } catch (e) {
      toHttp(e);
    }
  }

  // ——— FD-30: the paper slip, transcribed then confirmed (owner ruling 2026-09-12) ———

  /**
   * The scribe composes. `opd.prescription.draft` authorises THIS and nothing else — see the
   * manifest's entry, and `prescription-drafts.ts` for why a draft is inert by construction rather
   * than by a status check somebody has to remember.
   */
  @RequirePermission("opd.prescription.draft", "hospital")
  @Post("visits/:id/prescription-draft")
  async draft(@CurrentActor() actor: Actor, @Param("id") id: string, @Body() body: unknown): Promise<DraftRow> {
    const b = parsed(draftBody, body);
    try {
      return await saveDraft(this.db, actor, id, { lines: b.lines, note: b.note ?? null });
    } catch (e) {
      toHttp(e);
    }
  }

  /**
   * BOTH SEATS READ IT — the scribe re-opens what they typed, the doctor reads it before tapping —
   * and `RequirePermission` takes exactly ONE string, so the pair is made in the ROLE MODEL rather
   * than here: `doctor` holds `opd.prescription.draft` beside `opd.consult` (see `seed-roles.ts`).
   * Guarding this on `opd.consult` instead would have been the same decision pointing the other
   * way and would have shut out the seat that wrote the slip.
   */
  @RequirePermission("opd.prescription.draft", "hospital")
  @Get("visits/:id/prescription-draft")
  async readDraft(@Param("id") id: string): Promise<{ draft: DraftRow | null }> {
    try {
      return { draft: await getPendingDraft(this.db, id) };
    } catch (e) {
      toHttp(e);
    }
  }

  /** Taken off the list — by the doctor who will not issue it, or the scribe who mis-keyed it. */
  @RequirePermission("opd.prescription.draft", "hospital")
  @Post("visits/:id/prescription-draft/discard")
  async discard(@CurrentActor() actor: Actor, @Param("id") id: string): Promise<{ draft: DraftRow | null }> {
    try {
      return { draft: await discardDraft(this.db, actor, id) };
    } catch (e) {
      toHttp(e);
    }
  }

  /**
   * ═══ THE TAP ═══
   *
   * `opd.consult`, which a scribe does not hold — and even holding it would not be enough:
   * `issueDraft` calls the shipped `issuePrescription` with THIS actor, and
   * `requireTreatingDoctor` inside it refuses anyone without an `opd_doctors` profile for this
   * encounter. The permission is the outer door; the guard is the lock, and the lock is the one
   * every other prescription in the hospital passes through.
   */
  /**
   * ═══ FD-31 — THE DESK SENDS IT, BECAUSE THERE IS NO ASSISTANT TO WAIT FOR ═══
   *
   * Owner, 2026-09-12: *"the staff outside the doctor room types the medicine prescribed by the
   * doctor then the pharmacy department would be notified about the upcoming job. However, the
   * pharmacist will cross confirm the prescription slip … before generating the medicine bill."*
   *
   * The prescriber of record is taken from the ENCOUNTER, never from this caller, so no clerk can
   * name a doctor the patient did not see. `issuePrescription` re-asserts
   * `opd.prescription.transcribe` itself — this decorator is the outer door and that assertion is
   * the lock, for the reason `walk-in.ts` gives: one `@RequirePermission` silently replaces another.
   */
  @RequirePermission("opd.prescription.transcribe", "hospital")
  @Post("visits/:id/prescription-draft/transcribe")
  async transcribeDraft(
    @CurrentActor() actor: Actor, @Param("id") id: string, @Body() body: unknown,
  ): Promise<IssuedPrescription & { draftId: string }> {
    const b = parsed(issueDraftBody, body ?? {});
    try {
      return await issueDraft(this.db, actor, this.cfg, id, b, new Date(), "paper_slip");
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("opd.consult", "hospital")
  @Post("visits/:id/prescription-draft/issue")
  async issueDraftRoute(
    @CurrentActor() actor: Actor, @Param("id") id: string, @Body() body: unknown,
  ): Promise<IssuedPrescription & { draftId: string }> {
    const b = parsed(issueDraftBody, body ?? {});
    try {
      return await issueDraft(this.db, actor, this.cfg, id, b);
    } catch (e) {
      toHttp(e);
    }
  }

  /**
   * PLAN 16a T5 — the same checks, while the doctor is still typing.
   *
   * IT WRITES NOTHING AND IT DECIDES NOTHING. The issue path re-runs every check regardless
   * (design law 2: checks evaluate at issue time), so this route is a courtesy to the screen and
   * never a substitute for the gate. Guarded on `opd.consult` — the permission that already means
   * "may write a prescription for this patient" — because the response carries what the patient is
   * currently taking, which is clinical information about them.
   */
  @RequirePermission("opd.consult", "hospital")
  @Post("visits/:id/rx-precheck")
  async rxPrecheck(
    @CurrentActor() actor: Actor, @Param("id") id: string, @Body() body: unknown,
  ): Promise<RxPrecheckResult> {
    const b = parsed(precheckBody, body);
    try {
      return await precheckPrescription(this.db, actor, id, b.lines);
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("opd.visits.read", "hospital")
  @Get("visits/:id/prescriptions")
  async prescriptions(@CurrentActor() actor: Actor, @Param("id") id: string): Promise<{ items: PrescriptionRow[] }> {
    return { items: await listPrescriptions(this.db, actor, id) };
  }

  @RequirePermission("opd.prescriptions.verify", "hospital")
  @Post("prescriptions/verify")
  @HttpCode(200) // a failed scan is a domain answer (ok:false), never a transport error — the qr/verify precedent
  async verify(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<RxVerifyResult> {
    const b = parsed(verifyBody, body);
    try {
      return await verifyPrescriptionQr(this.db, this.cfg, actor, b.payload);
    } catch (e) {
      toHttp(e);
    }
  }

  @RequirePermission("opd.visits.read", "hospital")
  @Get("prescriptions/:id/print")
  async print(@CurrentActor() actor: Actor, @Param("id") id: string): Promise<RxPrintData> {
    try {
      return await getPrescriptionPrint(this.db, this.cfg, actor, id);
    } catch (e) {
      toHttp(e);
    }
  }
}
