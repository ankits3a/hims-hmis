import { and, asc, desc, eq, gte, inArray, isNotNull, isNull } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import { hasPermission } from "../../kernel/auth/permissions";
import { withTx } from "../../kernel/db/client";
import {
  opdDoctors, opdEncounters, opdPrescriptionDrafts, opdPrescriptions, opdQueueEntries, opdVitals, users,
} from "../../kernel/db/schema";
import { appendEvent } from "../../kernel/events/append";
import { startInstance, transition, WorkflowError } from "../../kernel/workflow/instances";
import { documentsForEncounters, getPatientSummaries } from "../patients";
import { loadOpdConfig } from "./config";
import { consultDoorRefusal, entryWhere, requireTreatingDoctor } from "./consultation";
import { getEncounter } from "./encounters";
import { OpdError } from "./errors";
import {
  consultationCompleted, consultationCompletedOnPaper, consultationPaperConfirmed, consultationPaperRecheckAsked,
  consultationPaperRecheckDone, consultationPaperReopened,
  consultFeeOverridden, paperPrescriptionTranscribed,
} from "./events";
import { normaliseRxLine } from "./fhir";
import { layoutStampFor } from "./layout";
import { doctorForUser } from "./masters";
import { issuePrescription, runRxChecks } from "./prescriptions";
import { markDone } from "./queue";
import { istDate } from "./time";
import { OPD_VISIT_DEF_KEY } from "./workflow-def";
import type { AppConfig } from "../../kernel/config";
import type { Db, Tx } from "../../kernel/db/client";
import type { EncounterDocument, PatientSummary } from "../patients";
import type { AdvisedTest, RxDraftLine } from "./consultation";
import type { EncounterRow } from "./encounters";
import type { RxLine } from "./fhir";
import type { AllergyOverride, IssuedPrescription, RxOverride } from "./prescriptions";

/**
 * ═════════════════════════════════════════════════════════════════════
 * CONSULTED ON PAPER — OWNER RULING 2026-10-06
 * ═════════════════════════════════════════════════════════════════════
 *
 * *"Some of my doctors … are struggling to type during consulting patient … they are okay to
 * write/prescribe on physical paper. I don't have funds to hire … we already have 'Desk Scribe'
 * module. Let's enable it to type the drugs as well as lab tests. And we also have 'Slip Desk' …
 * if they don't start a consultation of the patient on their dashboard … the patient will be kept
 * marked as 'waiting in the building' even if the doctor has already given consultation … If the
 * Slip Desk or Scribe Desk staff by performing either clicking a picture of prescription slip or
 * typing the prescriptions … will mark the patient as Consulted."*
 *
 * Rulings: **A) the pharmacy may dispense** (and the lab may bill) from what the desk typed, before
 * any doctor looks at it. **B) only the slip desk and the desk scribe** may close a visit this way.
 *
 * WHAT THIS FILE IS. Four acts and two reads:
 *
 *   1. `markConsultedOnPaperInTx` — the visit is closed from paper evidence. Reached from the slip
 *      desk (a `consult_prescription` photograph filed against the visit, through the patients
 *      module's capture hook) and from `transcribePaper` below. Whichever comes first wins; the
 *      second finds the visit already closed and changes nothing.
 *   2. `transcribePaper` — the desk scribe types the doctor's medicines and tests. Clean lines are
 *      ISSUED (the shipped `issuePrescription`, `paper_slip` authority: prescriber read from the
 *      visit, `transcribed_by` stamped, the pharmacist's slip cross-check before the bill intact).
 *      A line that raises a hard warning is NOT issued and NOT dropped: it is HELD FOR THE DOCTOR.
 *   3. `confirmPaperConsult` / `correctPaperPrescription` — the doctor's OPTIONAL look. Nothing waits
 *      on it except the held lines, which only a prescriber may clear.
 *   4. `reopenPaperConsult` — a supervisor found the wrong visit closed and puts the patient back.
 *
 * ═══ WHY THE WORKFLOW MOVES ARE THE APPLICATION'S OWN ═══
 *
 * `opd_visit` gives `waiting → in_consultation → completed` to the `doctor` role alone, and that
 * definition is Class A data activated in production under two keys. A desk is not a doctor and
 * must not be made one. So the desk's AUTHORITY is checked here, by permission, by day and by the
 * visit's own state — and the transitions are then made by a named system actor, exactly as the
 * radiology readiness move is. The person is not lost: `consultation.completed_on_paper` carries
 * them, and `paper_completed_by` is on the row.
 *
 * ═══ WHAT IS DELIBERATELY NOT DONE ═══
 *
 *   · A visit the doctor STARTED on the screen and never completed IS closed too — owner, 2026-10-06,
 *     asked exactly that: *"Yes, paper close that visit too."* (in consultation, parked or not —
 *     a park is a mark on the queue row, not a state). What the doctor had typed is NOT touched:
 *     the note stays, and medicines typed on the screen and never issued stay UNISSUED — the paper
 *     road issues only what the desk typed from the paper, never a draft nobody signed off. The
 *     doctor's paper list shows those lines ("typed on your screen, not issued"), and the doctor's
 *     own screen, if still open, is told plainly (`refuseIfClosedOnPaper`).
 *   · No guard is skipped but the money one, and that one is not skipped either — it is RECORDED.
 *     The doctor has already seen the patient; pretending otherwise would keep them "waiting"
 *     forever. So an unsettled fee is written down as seen-before-payment in the desk's name, the
 *     due stays on the account and the unpaid mark keeps riding to every later desk. Any OTHER
 *     refusal at the consult door (a clinical or statutory one) refuses the paper road too.
 *   · The scribe clears no warning. See `transcribePaper`.
 */

/** Held by `opd_slip_desk` and `opd_scribe` (ruling B). Asserted HERE, not only at a route. */
export const PAPER_CONSULT_PERMISSION = "opd.consult.paper";
/** The supervisor's existing queue authority — putting a patient back in a line is a queue act. */
export const PAPER_REOPEN_PERMISSION = "opd.queue.transfer";
const TRANSCRIBE_PERMISSION = "opd.prescription.transcribe";

/** The sentence every later desk reads beside the unpaid mark for a visit closed this way. */
export const PAPER_FEE_REASON = "Seen by the doctor on paper before the fee was settled — recorded when the paper was filed";

const PAPER_ACTOR: Actor = { type: "system", id: "opd-paper-consult" };
const CLOSABLE = ["registered", "waiting", "in_consultation", "awaiting_results"] as const;
type ClosableState = (typeof CLOSABLE)[number];

export type PaperEvidence = { kind: "slip_photo" | "transcription"; id: string };

export type PaperOutcome =
  /** This act closed the visit. */
  | "marked"
  /** It was already closed from paper — the photo or the typing that came first did it. */
  | "already_marked"
  /** The doctor completed it on the screen. Nothing to do; the paper is simply on file. */
  | "doctor_completed"
  | "not_permitted" | "not_today" | "no_doctor" | "not_in_queue" | "abandoned" | "not_a_consultation"
  /** The consult door refuses for a reason that is not money. `gate` says which. */
  | "gate_refused";

export type PaperVerdict = {
  outcome: PaperOutcome;
  /** True when the visit stands consulted after this call, whoever made it so. */
  consulted: boolean;
  encounterId: string;
  visitNo: string;
  gate?: { guard: string; code: string };
};

function verdict(e: EncounterRow, outcome: PaperOutcome, gate?: { guard: string; code: string }): PaperVerdict {
  const consulted = outcome === "marked" || outcome === "already_marked" || outcome === "doctor_completed";
  return { outcome, consulted, encounterId: e.id, visitNo: e.visitNo, ...(gate === undefined ? {} : { gate }) };
}

/** What stops the paper road before it writes anything, or null when the visit can be closed. */
async function refusalBeforeWrite(
  tx: Tx, actor: Actor, e: EncounterRow, now: Date,
): Promise<PaperOutcome | null> {
  if (actor.type !== "user") return "not_permitted";
  if (!(await hasPermission(tx as unknown as Db, actor.id, PAPER_CONSULT_PERMISSION, "hospital"))) return "not_permitted";
  if (e.type !== "opd") return "not_a_consultation";
  if (e.status === "abandoned") return "abandoned";
  if (e.status === "completed") return e.completedVia === "paper" ? "already_marked" : "doctor_completed";
  if (e.serviceDate !== istDate(now)) return "not_today";
  if (e.doctorId === null) return "no_doctor";
  return null;
}

/**
 * Closes a visit from paper evidence, on the caller's transaction.
 *
 * IT NEVER THROWS FOR A VISIT IT MAY NOT CLOSE — it answers with an outcome. The slip desk's
 * photograph must be filed whatever this function decides, and a caller that had to catch a
 * refusal to learn that would one day forget to.
 */
export async function markConsultedOnPaperInTx(
  tx: Tx, actor: Actor, encounterId: string, evidence: PaperEvidence, now: Date = new Date(),
): Promise<PaperVerdict | null> {
  const locked = await tx.select().from(opdEncounters).where(eq(opdEncounters.id, encounterId)).for("update");
  const current = locked[0];
  if (!current) return null;

  const stop = await refusalBeforeWrite(tx, actor, current, now);
  if (stop !== null) return verdict(current, stop);

  const entries = await tx
    .select({ id: opdQueueEntries.id }).from(opdQueueEntries)
    .where(eq(opdQueueEntries.encounterId, current.id)).limit(1);
  if (entries.length === 0) return verdict(current, "not_in_queue");

  /*
    THE DOOR. Money is recorded, never waved through silently; anything else refuses (see the
    header). Read without the doctor's waiver applied, because what is being decided here is what
    to WRITE about the fee, not whether somebody may start.
  */
  /* A visit the doctor already started has been through this door on the doctor's own word; it is not asked again. */
  const refusal = current.status === "in_consultation" ? null : await consultDoorRefusal(tx, current);
  let feeUnsettled = false;
  if (refusal !== null) {
    if (refusal.code !== "fee_unsettled") return verdict(current, "gate_refused", { guard: refusal.guard, code: refusal.code });
    feeUnsettled = true;
  }

  const fromState = current.status as ClosableState;
  const hops: ("waiting" | "in_consultation" | "completed")[] =
    fromState === "in_consultation" ? ["completed"]
      : fromState === "waiting" ? ["in_consultation", "completed"] : ["waiting", "in_consultation", "completed"];
  try {
    for (const to of hops) await transition(tx, current.workflowInstanceId, to, PAPER_ACTOR, { note: "consulted on paper" });
  } catch (e) {
    if (e instanceof WorkflowError) {
      throw new OpdError("paper_consult_state_conflict", `${current.status} could not be closed from paper: ${e.code}`);
    }
    throw e;
  }

  const cfg = await loadOpdConfig(tx as unknown as Db);
  const stamp = current.layoutDefaultId === null && current.layoutOverlayId === null
    ? await layoutStampFor(tx, current.departmentId, current.doctorId)
    : {};
  const feePatch = feeUnsettled && current.consultFeeOverrideBy === null
    ? { consultFeeOverrideBy: actor.id, consultFeeOverrideReason: PAPER_FEE_REASON, consultFeeOverrideAt: now }
    : {};
  const rows = await tx
    .update(opdEncounters)
    .set({
      status: "completed",
      consultStartedAt: current.consultStartedAt ?? now,
      consultCompletedAt: now,
      followUpDays: cfg.followUpDefaultDays,
      followUpExtended: false,
      completedVia: "paper",
      paperCompletedBy: actor.id, paperCompletedAt: now,
      paperEvidenceKind: evidence.kind, paperEvidenceId: evidence.id,
      paperConfirmedBy: null, paperConfirmedAt: null,
      ...stamp, ...feePatch,
      updatedBy: actor.id, updatedAt: now,
    })
    .where(and(eq(opdEncounters.id, current.id), eq(opdEncounters.status, current.status)))
    .returning();
  const encounter = rows[0];
  if (!encounter) throw new OpdError("paper_consult_state_conflict", "the visit moved while the paper was being filed");

  await markDone(tx, encounter.id, now);
  const where = await entryWhere(tx, encounter.id);
  const issued = await tx
    .select({ id: opdPrescriptions.id }).from(opdPrescriptions)
    .where(and(eq(opdPrescriptions.encounterId, encounter.id), eq(opdPrescriptions.status, "active")));
  const env = { actor, patientId: encounter.patientId, encounterId: encounter.id, correlationId: encounter.workflowInstanceId };
  const doctorId = encounter.doctorId!;

  if ("consultFeeOverrideBy" in feePatch) {
    await appendEvent(tx, consultFeeOverridden.make({ ...env, payload: {
      encounterId: encounter.id, patientId: encounter.patientId, doctorId,
      serviceDate: encounter.serviceDate, reason: PAPER_FEE_REASON,
    } }));
  }
  await appendEvent(tx, consultationCompleted.make({ ...env, payload: {
    encounterId: encounter.id, patientId: encounter.patientId, departmentId: encounter.departmentId!,
    doctorId, serviceDate: encounter.serviceDate, ...where,
    visitType: encounter.visitType as "new" | "revisit" | "renewal",
    followUpDays: cfg.followUpDefaultDays, followUpExtended: false,
    admissionAdvised: encounter.admissionAdvised,
    referralIssued: encounter.referralTo !== null,
    prescriptionCount: issued.length,
    icd10Code: encounter.icd10Code,
  } }));
  await appendEvent(tx, consultationCompletedOnPaper.make({ ...env, payload: {
    encounterId: encounter.id, patientId: encounter.patientId, doctorId, serviceDate: encounter.serviceDate,
    fromState, evidenceKind: evidence.kind, evidenceId: evidence.id, feeUnsettled,
  } }));
  return verdict(encounter, "marked");
}

export async function markConsultedOnPaper(
  db: Db, actor: Actor, encounterId: string, evidence: PaperEvidence, now: Date = new Date(),
): Promise<PaperVerdict> {
  const out = await withTx(db, (tx) => markConsultedOnPaperInTx(tx, actor, encounterId, evidence, now));
  if (out === null) throw new OpdError("unknown_encounter", `unknown encounter ${encounterId}`);
  return out;
}

/**
 * The slip desk's half, as the patients module's capture hook. A `consult_prescription` page filed
 * against a visit is the doctor's signed paper for that visit; any other kind (an outside report, an
 * outside prescription) says nothing about whether THIS doctor has seen the patient.
 */
export async function paperHookForDocument(
  tx: Tx, actor: Actor, doc: { documentId: string; encounterId: string | null; kind: string }, now: Date,
): Promise<PaperVerdict | null> {
  if (doc.kind !== "consult_prescription" || doc.encounterId === null) return null;
  return markConsultedOnPaperInTx(tx, actor, doc.encounterId, { kind: "slip_photo", id: doc.documentId }, now);
}

// ——— the desk scribe: medicines and tests, typed from the paper ———

export type HeldAlert = {
  kind: "allergy" | "interaction" | "duplicate" | "drug_disease";
  /** Hard = the line cannot be issued without a prescriber's reason. Soft ones are shown, never held. */
  hard: boolean;
  /** One plain sentence. The screens word their own from the fields below where they can. */
  text: string;
  substance?: string;
  saltPair?: [string, string];
  moiety?: string;
  icd10Prefix?: string;
};
export type LineAlerts = { lineIndex: number; alerts: HeldAlert[] };
export type HeldLine = { line: RxLine; alerts: HeldAlert[] };

/** Every warning the shipped checks raise, grouped by the line that raised it. */
async function alertsByLine(
  db: Db, patientId: string, lines: RxLine[], now: Date, excludeEncounterId: string,
): Promise<Map<number, HeldAlert[]>> {
  const out = new Map<number, HeldAlert[]>();
  if (lines.length === 0) return out;
  const push = (i: number, a: HeldAlert): void => { out.set(i, [...(out.get(i) ?? []), a]); };
  const checks = await runRxChecks(db, patientId, lines, now, { excludeEncounterId });
  for (const m of checks.allergyMatches) {
    push(m.lineIndex, { kind: "allergy", hard: true, substance: m.substance, text: `Allergy on record: ${m.substance}` });
  }
  for (const h of checks.interactions) {
    push(h.lineIndex, {
      kind: "interaction", hard: h.severity === "severe", saltPair: h.saltPair,
      text: `${h.saltPair[0]} with ${h.saltPair[1]}${h.note.trim() === "" ? "" : ` — ${h.note}`}`,
    });
  }
  for (const h of checks.duplicates) {
    push(h.lineIndex, {
      kind: "duplicate", hard: h.hard, moiety: h.moiety,
      text: h.with === undefined ? `${h.moiety} is written twice` : `${h.moiety} and ${h.with} are the same kind of medicine`,
    });
  }
  for (const h of checks.drugDisease) {
    push(h.lineIndex, {
      kind: "drug_disease", hard: h.severity === "severe", moiety: h.moiety, icd10Prefix: h.icd10Prefix,
      text: `${h.moiety} with ${h.icd10Title}${h.note.trim() === "" ? "" : ` — ${h.note}`}`,
    });
  }
  return out;
}

/**
 * Clean lines and held lines. Run to a fixed point, because holding one line can clear another:
 * two medicines that interact with EACH OTHER raise the warning on one of them, and once that one
 * is held the other is clean and must still reach the pharmacy.
 */
async function splitHeld(
  db: Db, patientId: string, lines: RxLine[], now: Date, excludeEncounterId: string,
): Promise<{ clean: RxLine[]; held: HeldLine[] }> {
  let keep = lines.map((line) => ({ line }));
  const held: HeldLine[] = [];
  for (let round = 0; round <= lines.length && keep.length > 0; round++) {
    const alerts = await alertsByLine(db, patientId, keep.map((k) => k.line), now, excludeEncounterId);
    const hardAt = new Set([...alerts.entries()].filter(([, a]) => a.some((x) => x.hard)).map(([i]) => i));
    if (hardAt.size === 0) break;
    keep.forEach((k, i) => { if (hardAt.has(i)) held.push({ line: k.line, alerts: (alerts.get(i) ?? []).filter((a) => a.hard) }); });
    keep = keep.filter((_, i) => !hardAt.has(i));
  }
  return { clean: keep.map((k) => k.line), held };
}

async function requireScribe(db: Db, actor: Actor): Promise<string> {
  if (actor.type !== "user") throw new OpdError("user_actor_required", "a transcription is a user action");
  if (!(await hasPermission(db, actor.id, TRANSCRIBE_PERMISSION, "hospital"))) {
    throw new OpdError("transcription_not_permitted", "this account may not type a prescription from a paper slip");
  }
  return actor.id;
}

async function paperVisit(db: Db, encounterId: string, now: Date): Promise<EncounterRow> {
  const e = await getEncounter(db, encounterId);
  if (!e) throw new OpdError("unknown_encounter", `unknown encounter ${encounterId}`);
  if (e.type !== "opd") throw new OpdError("paper_consult_state_conflict", "only an OPD consultation is typed from paper");
  if (e.status === "abandoned") throw new OpdError("paper_consult_state_conflict", `visit ${e.visitNo} was abandoned`);
  if (e.serviceDate !== istDate(now)) {
    throw new OpdError("paper_consult_state_conflict", `visit ${e.visitNo} is from ${e.serviceDate}, not today — the desk types today's paper only`, { reason: "not_today" });
  }
  if (e.doctorId === null) throw new OpdError("not_a_doctor", `visit ${e.visitNo} names no doctor to type for`);
  return e;
}

/** The warnings for what the scribe has typed so far. Reads only; the scribe can clear none of them. */
export async function paperCheck(
  db: Db, actor: Actor, encounterId: string, sent: RxLine[], now: Date = new Date(),
): Promise<{ lines: LineAlerts[] }> {
  await requireScribe(db, actor);
  const e = await paperVisit(db, encounterId, now);
  const lines = sent.map(normaliseRxLine);
  const alerts = await alertsByLine(db, e.patientId, lines, now, e.id);
  return { lines: [...alerts.entries()].map(([lineIndex, a]) => ({ lineIndex, alerts: a })).sort((a, b) => a.lineIndex - b.lineIndex) };
}

export type PaperAdvisedTest = AdvisedTest & { transcribedBy?: string };
export type TranscribePaperInput = {
  lines: RxLine[];
  /** The tests the paper names, snapshotted from the price list exactly as the doctor's screen does. */
  advisedTests?: AdvisedTest[];
  note?: string | null;
};
export type TranscribePaperResult = {
  encounterId: string;
  visitNo: string;
  paper: PaperVerdict;
  prescription: Pick<IssuedPrescription, "prescriptionId" | "version"> & { lineCount: number } | null;
  held: HeldLine[];
  advisedTests: PaperAdvisedTest[];
};

/**
 * ═══ THE SCRIBE TYPES; THE SCRIBE CLEARS NOTHING ═══
 *
 * Every line goes through the checks a doctor's line goes through. A line with no hard warning is
 * issued now — ruling A: the pharmacy may dispense without waiting for the doctor. A line WITH one
 * is held: kept word for word as the visit's pending draft, with the warning that held it, where
 * the doctor's list shows it first. The scribe cannot type a reason and the server would refuse
 * one (`issuePrescription`, `paper_slip`): the reason is a clinical judgement and belongs to the
 * prescriber's name.
 *
 * ORDER OF WRITES, each one valid on its own so a failure between them leaves no lie behind:
 * the prescription (clean lines) → the held lines → the tests → the visit closed from paper.
 * Everything that could refuse the CLOSE for a reason known in advance is checked before the first.
 */
export async function transcribePaper(
  db: Db, actor: Actor, cfg: AppConfig, encounterId: string, input: TranscribePaperInput, now: Date = new Date(),
): Promise<TranscribePaperResult> {
  const scribeId = await requireScribe(db, actor);
  const e = await paperVisit(db, encounterId, now);
  const lines = input.lines.map(normaliseRxLine);
  const tests = input.advisedTests ?? [];
  if (lines.length === 0 && tests.length === 0) {
    throw new OpdError("empty_prescription", "type at least one medicine or one test from the paper");
  }
  for (const line of lines) {
    if (line.drug.trim() === "" || line.dose.trim() === "" || line.frequency.trim() === "" || line.route.trim() === "") {
      throw new OpdError("empty_prescription", "every line needs a drug, a dose, a frequency and a route");
    }
  }
  const closable = (CLOSABLE as readonly string[]).includes(e.status);
  if (closable && !(await hasPermission(db, scribeId, PAPER_CONSULT_PERMISSION, "hospital"))) {
    throw new OpdError("paper_consult_not_permitted", "this account may type the paper but may not mark the visit consulted");
  }

  const active = await db
    .select({ id: opdPrescriptions.id, transcribedBy: opdPrescriptions.transcribedBy })
    .from(opdPrescriptions)
    .where(and(eq(opdPrescriptions.encounterId, e.id), eq(opdPrescriptions.status, "active")));
  if (lines.length > 0 && active.some((p) => p.transcribedBy === null)) {
    throw new OpdError(
      "doctor_rx_exists_state_conflict",
      `the doctor has already issued the prescription for visit ${e.visitNo} on the screen — the desk does not type over it`,
    );
  }

  const { clean, held } = await splitHeld(db, e.patientId, lines, now, e.id);

  let prescription: TranscribePaperResult["prescription"] = null;
  if (clean.length > 0) {
    const issued = await issuePrescription(db, actor, cfg, e.id, { lines: clean }, now, "paper_slip", { paperStates: true });
    prescription = { prescriptionId: issued.prescriptionId, version: issued.version, lineCount: clean.length };
  }

  const advisedTests = await withTx(db, async (tx) => {
    await tx.select({ id: opdEncounters.id }).from(opdEncounters).where(eq(opdEncounters.id, e.id)).for("update");
    /* The held lines REPLACE whatever was pending: one pending slip per visit, as FD-30 has it. */
    const pending = await tx
      .select({ id: opdPrescriptionDrafts.id }).from(opdPrescriptionDrafts)
      .where(and(eq(opdPrescriptionDrafts.encounterId, e.id), eq(opdPrescriptionDrafts.status, "pending")));
    const note = (input.note ?? "").trim() === "" ? null : (input.note ?? "").trim();
    if (held.length > 0) {
      const values = { lines: held.map((h) => h.line), heldAlerts: held.map((h) => h.alerts), note, draftedBy: scribeId, draftedAt: now };
      if (pending[0] !== undefined) {
        await tx.update(opdPrescriptionDrafts).set(values).where(eq(opdPrescriptionDrafts.id, pending[0].id));
      } else {
        await tx.insert(opdPrescriptionDrafts).values({ id: newId(), encounterId: e.id, patientId: e.patientId, status: "pending", ...values });
      }
    } else if (pending[0] !== undefined && lines.length > 0) {
      await tx.update(opdPrescriptionDrafts)
        .set({ status: "discarded", resolvedBy: scribeId, resolvedAt: now })
        .where(eq(opdPrescriptionDrafts.id, pending[0].id));
    }

    /*
      THE TESTS. `advised_tests` is what the lab desk reads to bill and collect (`lab/desk.ts`), so a
      test typed here reaches the laboratory exactly as one the doctor advised on the screen does.
      What the doctor typed themselves is never touched; what an earlier save typed from paper is
      replaced by this one, so correcting a mistyped test does not leave both behind.
    */
    const row = (await tx.select({ advisedTests: opdEncounters.advisedTests }).from(opdEncounters).where(eq(opdEncounters.id, e.id)))[0]!;
    const existing = (Array.isArray(row.advisedTests) ? row.advisedTests : []) as PaperAdvisedTest[];
    if (tests.length === 0) return existing;
    const doctors = existing.filter((t) => t.transcribedBy === undefined);
    const taken = new Set(doctors.map((t) => t.serviceId));
    const typed: PaperAdvisedTest[] = tests
      .filter((t, i) => !taken.has(t.serviceId) && tests.findIndex((x) => x.serviceId === t.serviceId) === i)
      .map((t) => ({ serviceId: t.serviceId, code: t.code, name: t.name, pricePaise: t.pricePaise, transcribedBy: scribeId }));
    const next = [...doctors, ...typed];
    await tx.update(opdEncounters).set({ advisedTests: next, updatedBy: scribeId, updatedAt: now }).where(eq(opdEncounters.id, e.id));
    return next;
  });

  const paper = await markConsultedOnPaper(
    db, actor, e.id, { kind: "transcription", id: prescription?.prescriptionId ?? e.id }, now,
  );

  /* A save IS the re-check: what the doctor sent back is answered by typing it again (decision 0043). */
  await withTx(db, (tx) => closeRecheckInTx(tx, actor, e, null, true, now));
  await withTx(db, (tx) => appendEvent(tx, paperPrescriptionTranscribed.make({
    actor, patientId: e.patientId, encounterId: e.id, correlationId: e.workflowInstanceId,
    payload: {
      encounterId: e.id, patientId: e.patientId, doctorId: e.doctorId!, prescriptionId: prescription?.prescriptionId ?? null,
      issuedLines: clean.length, heldLines: held.length,
      advisedTests: advisedTests.filter((t) => t.transcribedBy !== undefined).length,
    },
  })));
  return { encounterId: e.id, visitNo: e.visitNo, paper, prescription, held, advisedTests };
}

// ——— what the desk, the doctor and the supervisor read ———

export type PaperConsultRow = {
  encounterId: string;
  visitNo: string;
  serviceDate: string;
  status: string;
  patient: PatientSummary;
  doctorId: string | null;
  doctorCode: string | null;
  doctorName: string | null;
  tokenNo: number | null;
  completedVia: string | null;
  paperCompletedAt: Date | null;
  paperCompletedByName: string | null;
  evidenceKind: string | null;
  /** The photographed pages of the doctor's paper for this visit, oldest first. Metadata only. */
  documents: EncounterDocument[];
  /** The visit's current prescription, whoever keyed it. `transcribedByName` is null when the doctor did. */
  prescription: { id: string; version: number; lines: RxLine[]; issuedAt: Date; transcribedByName: string | null } | null;
  held: { lines: RxLine[]; alerts: HeldAlert[][]; note: string | null; draftedByName: string | null; draftedAt: Date } | null;
  advisedTests: (PaperAdvisedTest & { transcribedByName: string | null })[];
  /**
   * Medicines the DOCTOR typed on the consultation screen and never issued, on a visit the paper
   * road then closed. Kept exactly as typed, issued by nobody; shown to the doctor, who may issue
   * them through "correct it". Empty when there is no such draft (the usual case).
   */
  doctorDraft: RxLine[];
  confirmedAt: Date | null;
  confirmedByName: string | null;
  /** "Ask the desk to re-check" (decision 0043): open while `doneAt` is null. Null when never asked. */
  recheck: { reason: string; askedAt: Date; askedByName: string | null; doneAt: Date | null; doneByName: string | null; doneNote: string | null } | null;
};

async function namesOf(db: Db, ids: readonly (string | null | undefined)[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((id): id is string => typeof id === "string"))];
  if (wanted.length === 0) return new Map();
  const rows = await db.select({ id: users.id, fullName: users.fullName }).from(users).where(inArray(users.id, wanted));
  return new Map(rows.map((u) => [u.id, u.fullName]));
}

async function rowsFor(db: Db, actor: Actor, encounters: EncounterRow[]): Promise<PaperConsultRow[]> {
  if (encounters.length === 0) return [];
  const ids = encounters.map((e) => e.id);
  const [summaries, docs, rx, drafts, entries, doctors] = await Promise.all([
    getPatientSummaries(db, actor, encounters.map((e) => e.patientId)),
    documentsForEncounters(db, ids),
    db.select().from(opdPrescriptions)
      .where(and(inArray(opdPrescriptions.encounterId, ids), eq(opdPrescriptions.status, "active")))
      .orderBy(desc(opdPrescriptions.version)),
    db.select().from(opdPrescriptionDrafts)
      .where(and(inArray(opdPrescriptionDrafts.encounterId, ids), eq(opdPrescriptionDrafts.status, "pending"))),
    db.select({ encounterId: opdQueueEntries.encounterId, tokenNo: opdQueueEntries.tokenNo, seq: opdQueueEntries.seq })
      .from(opdQueueEntries).where(inArray(opdQueueEntries.encounterId, ids)).orderBy(asc(opdQueueEntries.seq)),
    db.select({ id: opdDoctors.id, code: opdDoctors.code, displayName: opdDoctors.displayName }).from(opdDoctors),
  ]);
  const byPatient = new Map(summaries.map((s) => [s.requestedId, s] as const));
  const rxBy = new Map<string, (typeof rx)[number]>();
  for (const p of rx) if (!rxBy.has(p.encounterId)) rxBy.set(p.encounterId, p);
  const draftBy = new Map(drafts.map((d) => [d.encounterId, d] as const));
  const tokenBy = new Map(entries.map((q) => [q.encounterId, q.tokenNo] as const));
  const doctorBy = new Map(doctors.map((d) => [d.id, d] as const));
  const names = await namesOf(db, [
    ...encounters.flatMap((e) => [e.paperCompletedBy, e.paperConfirmedBy, e.paperRecheckAskedBy, e.paperRecheckDoneBy]),
    ...rx.map((p) => p.transcribedBy), ...drafts.map((d) => d.draftedBy),
    ...encounters.flatMap((e) => ((Array.isArray(e.advisedTests) ? e.advisedTests : []) as PaperAdvisedTest[]).map((t) => t.transcribedBy)),
  ]);

  const out: PaperConsultRow[] = [];
  for (const e of encounters) {
    const patient = byPatient.get(e.patientId);
    if (patient === undefined) continue; // a sealed record this reader may not see is simply absent
    const p = rxBy.get(e.id);
    const d = draftBy.get(e.id);
    const doc = e.doctorId === null ? undefined : doctorBy.get(e.doctorId);
    out.push({
      encounterId: e.id, visitNo: e.visitNo, serviceDate: e.serviceDate, status: e.status, patient,
      doctorId: e.doctorId, doctorCode: doc?.code ?? null, doctorName: doc?.displayName ?? null,
      tokenNo: tokenBy.get(e.id) ?? null,
      completedVia: e.completedVia, paperCompletedAt: e.paperCompletedAt,
      paperCompletedByName: e.paperCompletedBy === null ? null : names.get(e.paperCompletedBy) ?? null,
      evidenceKind: e.paperEvidenceKind,
      documents: docs.filter((x) => x.encounterId === e.id && x.kind === "consult_prescription")
        .sort((a, b) => a.capturedAt.getTime() - b.capturedAt.getTime()),
      prescription: p === undefined ? null : {
        id: p.id, version: p.version, lines: p.lines as RxLine[], issuedAt: p.issuedAt,
        transcribedByName: p.transcribedBy === null ? null : names.get(p.transcribedBy) ?? "the desk",
      },
      held: d === undefined || d.heldAlerts === null ? null : {
        lines: d.lines as RxLine[], alerts: d.heldAlerts as HeldAlert[][], note: d.note,
        draftedByName: names.get(d.draftedBy) ?? null, draftedAt: d.draftedAt,
      },
      advisedTests: ((Array.isArray(e.advisedTests) ? e.advisedTests : []) as PaperAdvisedTest[])
        .map((t) => ({ ...t, transcribedByName: t.transcribedBy === undefined ? null : names.get(t.transcribedBy) ?? "the desk" })),
      doctorDraft: unissuedDoctorDraft(e, p === undefined ? [] : (p.lines as RxLine[])),
      confirmedAt: e.paperConfirmedAt,
      confirmedByName: e.paperConfirmedBy === null ? null : names.get(e.paperConfirmedBy) ?? null,
      recheck: e.paperRecheckAskedAt === null ? null : {
        reason: e.paperRecheckReason ?? "", askedAt: e.paperRecheckAskedAt,
        askedByName: e.paperRecheckAskedBy === null ? null : names.get(e.paperRecheckAskedBy) ?? null,
        doneAt: e.paperRecheckDoneAt, doneByName: e.paperRecheckDoneBy === null ? null : names.get(e.paperRecheckDoneBy) ?? null,
        doneNote: e.paperRecheckDoneNote,
      },
    });
  }
  return out;
}

/** The consultation screen's drafted rows that name a drug and are on no issued prescription, as lines. */
function unissuedDoctorDraft(e: EncounterRow, issued: RxLine[]): RxLine[] {
  const draft = Array.isArray(e.rxDraft) ? (e.rxDraft as RxDraftLine[]) : [];
  const onPaper = new Set(issued.map((l) => l.drug.trim().toLowerCase()));
  return draft
    .filter((r) => typeof r?.drug === "string" && r.drug.trim() !== "" && !onPaper.has(r.drug.trim().toLowerCase()))
    .map((r) => {
      const raw = String(r.durationDays ?? "").trim();
      const days = /^\d+$/.test(raw) ? Number(raw) : null;
      return {
        drug: r.drug.trim(), dose: (r.dose ?? "").trim(), route: (r.route ?? "").trim() || "oral", frequency: (r.frequency ?? "").trim(),
        durationDays: days !== null && days > 0 ? days : null,
        instructions: (r.instructions ?? "").trim() === "" ? null : r.instructions.trim(),
        noSubstitution: r.noSubstitution === true,
        ...(r.medicineId == null ? {} : { medicineId: r.medicineId }),
      };
    });
}

/** True when the visit carries anything that came off paper: closed from it, typed from it, or held. */
function hasPaperWork(r: PaperConsultRow): boolean {
  return r.completedVia === "paper" || r.held !== null || (r.prescription !== null && r.prescription.transcribedByName !== null)
    || r.advisedTests.some((t) => t.transcribedBy !== undefined);
}

/** One visit, for the scribe's screen: what is already filed, typed and held against it. */
export async function paperVisitState(db: Db, actor: Actor, encounterId: string): Promise<PaperConsultRow> {
  await requireScribe(db, actor);
  const e = await getEncounter(db, encounterId);
  if (!e) throw new OpdError("unknown_encounter", `unknown encounter ${encounterId}`);
  const [row] = await rowsFor(db, actor, [e]);
  if (row === undefined) throw new OpdError("unknown_encounter", `unknown encounter ${encounterId}`);
  return row;
}

const DAY_CAP = 2000;

/**
 * The day's paper consultations. `mine` is the doctor's own list (held lines first, then the ones
 * nobody has looked at, then the rest); `all` is the supervisor's, every doctor's, and needs the
 * supervisor's own grant — asserted here because the route's decorator carries the doctor's.
 */
export async function listPaperConsults(
  db: Db, actor: Actor, opts: { scope: "mine" | "all"; date?: string }, now: Date = new Date(),
): Promise<{ date: string; scope: "mine" | "all"; items: PaperConsultRow[] }> {
  if (actor.type !== "user") throw new OpdError("user_actor_required", "a staff read");
  const date = opts.date ?? istDate(now);
  let doctorId: string | null = null;
  if (opts.scope === "all") {
    if (!(await hasPermission(db, actor.id, PAPER_REOPEN_PERMISSION, "hospital"))) {
      throw new OpdError("paper_consult_not_permitted", "the whole day's paper consultations are the supervisor's list");
    }
  } else {
    const doctor = await doctorForUser(db, actor.id);
    if (!doctor) return { date, scope: opts.scope, items: [] };
    doctorId = doctor.id;
  }
  const encounters = await db
    .select().from(opdEncounters)
    .where(and(
      eq(opdEncounters.serviceDate, date), eq(opdEncounters.type, "opd"),
      ...(doctorId === null ? [] : [eq(opdEncounters.doctorId, doctorId)]),
    ))
    .orderBy(desc(opdEncounters.paperCompletedAt), desc(opdEncounters.openedAt))
    .limit(DAY_CAP);
  const rows = (await rowsFor(db, actor, encounters)).filter(hasPaperWork);
  const rank = (r: PaperConsultRow): number => (r.held !== null ? 0 : r.confirmedAt === null ? 1 : 2);
  rows.sort((a, b) => rank(a) - rank(b));
  return { date, scope: opts.scope, items: rows };
}

async function doctorsPaperVisit(db: Db, actor: Actor, encounterId: string): Promise<{ e: EncounterRow; row: PaperConsultRow; doctorId: string }> {
  const e = await getEncounter(db, encounterId);
  if (!e) throw new OpdError("unknown_encounter", `unknown encounter ${encounterId}`);
  const doctor = await requireTreatingDoctor(db, actor, e);
  const [row] = await rowsFor(db, actor, [e]);
  if (row === undefined || !hasPaperWork(row)) {
    throw new OpdError("paper_consult_state_conflict", `visit ${e.visitNo} carries nothing from paper to confirm`);
  }
  return { e, row, doctorId: doctor.id };
}

async function stampConfirmed(tx: Tx, actor: Actor, e: EncounterRow, doctorId: string, corrected: boolean, now: Date): Promise<void> {
  const updated = await tx
    .update(opdEncounters)
    .set({ paperConfirmedBy: actor.id, paperConfirmedAt: now })
    .where(and(eq(opdEncounters.id, e.id), ...(corrected ? [] : [isNull(opdEncounters.paperConfirmedBy)])))
    .returning({ id: opdEncounters.id });
  if (updated.length === 0) return; // first look wins; a second "looks right" is not a second event
  await appendEvent(tx, consultationPaperConfirmed.make({
    actor, patientId: e.patientId, encounterId: e.id, correlationId: e.workflowInstanceId,
    payload: { encounterId: e.id, patientId: e.patientId, doctorId, serviceDate: e.serviceDate, corrected },
  }));
}

/** "Looks right." The treating doctor only. Refused while lines are held — those need a decision, not a glance. */
export async function confirmPaperConsult(
  db: Db, actor: Actor, encounterId: string, now: Date = new Date(),
): Promise<PaperConsultRow> {
  const { e, row, doctorId } = await doctorsPaperVisit(db, actor, encounterId);
  if (row.held !== null) {
    throw new OpdError("paper_consult_state_conflict", "lines are held with a warning — correct the prescription or drop them, then confirm");
  }
  await withTx(db, (tx) => stampConfirmed(tx, actor, e, doctorId, false, now));
  return (await rowsFor(db, actor, [(await getEncounter(db, e.id))!]))[0]!;
}

/**
 * ═══ "ASK THE DESK TO RE-CHECK" (app home round 2, decision 0043) ═══
 *
 * The doctor reads what the desk typed from their paper and a line is wrong or cannot be right. Until
 * now their only move was to retype the prescription themselves ("Correct it") — the thing the paper
 * road exists to spare them. This sends it BACK: a reason, the treating doctor only, one open ask
 * per visit (asking again replaces the reason). It holds nothing: the patient is long gone and the
 * pharmacy already has the lines; it is a message with a place to land (the desk's list, the desk's
 * phone) and a record that it was answered.
 */
export async function askPaperRecheck(
  db: Db, actor: Actor, encounterId: string, reasonRaw: string, now: Date = new Date(),
): Promise<PaperConsultRow> {
  const reason = reasonRaw.trim();
  if (reason === "") throw new OpdError("paper_consult_state_conflict", "say what the desk should look at again");
  const { e, doctorId } = await doctorsPaperVisit(db, actor, encounterId);
  await withTx(db, async (tx) => {
    await tx.update(opdEncounters).set({
      paperRecheckAskedBy: actor.id, paperRecheckAskedAt: now, paperRecheckReason: reason.slice(0, 500),
      paperRecheckDoneBy: null, paperRecheckDoneAt: null, paperRecheckDoneNote: null,
    }).where(eq(opdEncounters.id, e.id));
    await appendEvent(tx, consultationPaperRecheckAsked.make({
      actor, patientId: e.patientId, encounterId: e.id, correlationId: e.workflowInstanceId,
      payload: { encounterId: e.id, patientId: e.patientId, doctorId, serviceDate: e.serviceDate },
    }));
  });
  return (await rowsFor(db, actor, [(await getEncounter(db, e.id))!]))[0]!;
}

/** Closes an open ask inside the caller's transaction. A visit with no open ask is left exactly as it is. */
async function closeRecheckInTx(tx: Tx, actor: Actor, e: EncounterRow, note: string | null, bySave: boolean, now: Date): Promise<boolean> {
  const closed = await tx.update(opdEncounters)
    .set({ paperRecheckDoneBy: actor.id, paperRecheckDoneAt: now, paperRecheckDoneNote: note })
    .where(and(eq(opdEncounters.id, e.id), isNotNull(opdEncounters.paperRecheckAskedAt), isNull(opdEncounters.paperRecheckDoneAt)))
    .returning({ id: opdEncounters.id });
  if (closed.length === 0) return false;
  await appendEvent(tx, consultationPaperRecheckDone.make({
    actor, patientId: e.patientId, encounterId: e.id, correlationId: e.workflowInstanceId,
    payload: { encounterId: e.id, patientId: e.patientId, serviceDate: e.serviceDate, bySave },
  }));
  return true;
}

/** The desk says "I have looked again" without retyping (the paper was right, or the doctor was told). */
export async function resolvePaperRecheck(
  db: Db, actor: Actor, encounterId: string, noteRaw: string | null, now: Date = new Date(),
): Promise<PaperConsultRow> {
  await requireScribe(db, actor);
  const e = await getEncounter(db, encounterId);
  if (!e) throw new OpdError("unknown_encounter", `unknown encounter ${encounterId}`);
  const note = (noteRaw ?? "").trim() === "" ? null : (noteRaw ?? "").trim().slice(0, 500);
  const won = await withTx(db, (tx) => closeRecheckInTx(tx, actor, e, note, false, now));
  if (!won) throw new OpdError("paper_consult_state_conflict", `visit ${e.visitNo} has nothing sent back to re-check`);
  const [row] = await rowsFor(db, actor, [(await getEncounter(db, e.id))!]);
  if (row === undefined) throw new OpdError("unknown_encounter", `unknown encounter ${encounterId}`);
  return row;
}

/** The desk's list of what doctors sent back and nobody has answered — every doctor's, today's and yesterday's. */
export async function listPaperSentBack(db: Db, actor: Actor, now: Date = new Date()): Promise<{ items: PaperConsultRow[]; toType: number }> {
  await requireScribe(db, actor);
  const since = new Date(now.getTime() - 48 * 3_600_000);
  const encounters = await db.select().from(opdEncounters)
    .where(and(isNotNull(opdEncounters.paperRecheckAskedAt), isNull(opdEncounters.paperRecheckDoneAt), gte(opdEncounters.paperRecheckAskedAt, since)))
    .orderBy(asc(opdEncounters.paperRecheckAskedAt)).limit(200);
  /*
    PAPERS TO TYPE — a count for the desk's card: today's visits closed from a photographed slip that
    nobody has typed yet (no prescription typed from paper, nothing held). A count and nothing else.
  */
  const photographed = await db.select({ id: opdEncounters.id, advisedTests: opdEncounters.advisedTests }).from(opdEncounters)
    .where(and(eq(opdEncounters.serviceDate, istDate(now)), eq(opdEncounters.type, "opd"), eq(opdEncounters.completedVia, "paper"), eq(opdEncounters.paperEvidenceKind, "slip_photo")))
    .limit(DAY_CAP);
  let toType = 0;
  if (photographed.length > 0) {
    const ids = photographed.map((p) => p.id);
    const typed = new Set((await db.select({ e: opdPrescriptions.encounterId }).from(opdPrescriptions)
      .where(and(inArray(opdPrescriptions.encounterId, ids), eq(opdPrescriptions.status, "active")))).map((r) => r.e));
    const held = new Set((await db.select({ e: opdPrescriptionDrafts.encounterId }).from(opdPrescriptionDrafts)
      .where(and(inArray(opdPrescriptionDrafts.encounterId, ids), eq(opdPrescriptionDrafts.status, "pending")))).map((r) => r.e));
    toType = photographed.filter((p) => !typed.has(p.id) && !held.has(p.id)
      && !((Array.isArray(p.advisedTests) ? p.advisedTests : []) as PaperAdvisedTest[]).some((t) => t.transcribedBy !== undefined)).length;
  }
  return { items: await rowsFor(db, actor, encounters), toType };
}

export type CorrectPaperInput = {
  /** The prescription as the doctor wants it to stand — typed lines, held lines, their own edits. */
  lines: RxLine[];
  /** One reason per line that still raises a hard warning. The server builds the overrides from them. */
  reasons?: { lineIndex: number; reason: string }[];
};

/**
 * "Correct it." The doctor is the actor and `issuePrescription` runs on the doctor's own authority,
 * so `requireTreatingDoctor` and every gate hold exactly as they do in a consultation. The reasons
 * are the doctor's: each one is attached to every hard warning its line raises at THIS moment — the
 * checks are re-run here, so a reason typed for one warning cannot clear one the doctor never saw
 * on a line they gave no reason for. No lines at all means "none of what was held should be given".
 */
export async function correctPaperPrescription(
  db: Db, actor: Actor, cfg: AppConfig, encounterId: string, input: CorrectPaperInput, now: Date = new Date(),
): Promise<PaperConsultRow> {
  const { e, row, doctorId } = await doctorsPaperVisit(db, actor, encounterId);
  if (e.status !== "completed" && e.status !== "in_consultation") {
    throw new OpdError("paper_consult_state_conflict", `visit ${e.visitNo} is ${e.status} — start the consultation to prescribe`);
  }
  const lines = input.lines.map(normaliseRxLine);
  let issuedId: string | null = null;
  if (lines.length > 0) {
    const reasonAt = new Map((input.reasons ?? []).map((r) => [r.lineIndex, r.reason] as const));
    const alerts = await alertsByLine(db, e.patientId, lines, now, e.id);
    const overrides: AllergyOverride[] = [];
    const interactionOverrides: RxOverride[] = [];
    const duplicateOverrides: RxOverride[] = [];
    const drugDiseaseOverrides: RxOverride[] = [];
    for (const [lineIndex, list] of alerts) {
      const reason = reasonAt.get(lineIndex);
      if (reason === undefined) continue;
      for (const a of list.filter((x) => x.hard)) {
        if (a.kind === "allergy") overrides.push({ lineIndex, substance: a.substance!, reason });
        else if (a.kind === "interaction") interactionOverrides.push({ lineIndex, reason, saltPair: a.saltPair! });
        else if (a.kind === "duplicate") duplicateOverrides.push({ lineIndex, reason, moiety: a.moiety! });
        else drugDiseaseOverrides.push({ lineIndex, reason, moiety: a.moiety!, icd10Prefix: a.icd10Prefix! });
      }
    }
    const issued = await issuePrescription(
      db, actor, cfg, e.id, { lines, overrides, interactionOverrides, duplicateOverrides, drugDiseaseOverrides },
      now, "doctor", { paperCorrection: true },
    );
    issuedId = issued.prescriptionId;
  } else if (row.held === null) {
    throw new OpdError("empty_prescription", "a correction needs at least one line");
  }
  await withTx(db, async (tx) => {
    await tx.update(opdPrescriptionDrafts)
      .set(issuedId === null
        ? { status: "discarded", resolvedBy: actor.id, resolvedAt: now }
        : { status: "issued", resolvedBy: actor.id, resolvedAt: now, issuedPrescriptionId: issuedId })
      .where(and(eq(opdPrescriptionDrafts.encounterId, e.id), eq(opdPrescriptionDrafts.status, "pending")));
    await stampConfirmed(tx, actor, e, doctorId, true, now);
  });
  return (await rowsFor(db, actor, [(await getEncounter(db, e.id))!]))[0]!;
}

/** The doctor's own warnings for the lines in the correction editor (reads only). */
export async function paperCorrectionCheck(
  db: Db, actor: Actor, encounterId: string, sent: RxLine[], now: Date = new Date(),
): Promise<{ lines: LineAlerts[] }> {
  const e = await getEncounter(db, encounterId);
  if (!e) throw new OpdError("unknown_encounter", `unknown encounter ${encounterId}`);
  await requireTreatingDoctor(db, actor, e);
  const alerts = await alertsByLine(db, e.patientId, sent.map(normaliseRxLine), now, e.id);
  return { lines: [...alerts.entries()].map(([lineIndex, a]) => ({ lineIndex, alerts: a })).sort((a, b) => a.lineIndex - b.lineIndex) };
}

export type ReopenPaperInput = {
  reason: string;
  /** The typed prescription was for the wrong patient too: withdraw it (the pharmacy's claim then refuses it). */
  voidTranscription?: boolean;
};

/**
 * ═══ THE WRONG VISIT WAS CLOSED ═══
 *
 * A slip photographed against the wrong visit closes a patient who is still sitting in the hall.
 * A supervisor puts them back: today only, a visit closed FROM PAPER only (a doctor's own
 * completion is the doctor's to undo, not a desk's), with a reason.
 *
 * `completed` is terminal in the workflow, so the visit gets a NEW instance of the same definition
 * and is walked to where a waiting patient stands: `waiting` when vitals are on the chart,
 * `registered` when they never reached the bay. The token is the patient's own again, with the
 * place in the line it had (`eligible_at` is kept).
 *
 * A fee waiver the paper road wrote (`PAPER_FEE_REASON`) is CLEARED — it said "the doctor has seen
 * them", and that is exactly what turned out to be false. Leaving it would let an unpaid patient
 * be called as if a doctor had decided to see them first.
 */
export async function reopenPaperConsult(
  db: Db, actor: Actor, encounterId: string, input: ReopenPaperInput, now: Date = new Date(),
): Promise<{ encounter: EncounterRow }> {
  if (actor.type !== "user") throw new OpdError("user_actor_required", "a reopen is a user action");
  if (!(await hasPermission(db, actor.id, PAPER_REOPEN_PERMISSION, "hospital"))) {
    throw new OpdError("paper_consult_not_permitted", "reopening a visit closed from paper is the supervisor's act");
  }
  const reason = input.reason.trim();
  if (reason.length < 3) throw new OpdError("reason_required", "say why the visit is being reopened — it is recorded");
  return withTx(db, async (tx) => {
    const current = (await tx.select().from(opdEncounters).where(eq(opdEncounters.id, encounterId)).for("update"))[0];
    if (!current) throw new OpdError("unknown_encounter", `unknown encounter ${encounterId}`);
    if (current.status !== "completed" || current.completedVia !== "paper") {
      throw new OpdError("paper_consult_state_conflict", `visit ${current.visitNo} was not closed from paper`);
    }
    if (current.serviceDate !== istDate(now)) {
      throw new OpdError("paper_consult_state_conflict", `visit ${current.visitNo} is from ${current.serviceDate} — a reopen is same-day only`);
    }
    const prev = (await tx.select().from(opdQueueEntries).where(eq(opdQueueEntries.encounterId, current.id))
      .orderBy(desc(opdQueueEntries.seq)).limit(1))[0];
    if (!prev) throw new OpdError("paper_consult_state_conflict", `visit ${current.visitNo} has no token to return to`);
    const hasVitals = (await tx.select({ id: opdVitals.id }).from(opdVitals).where(eq(opdVitals.encounterId, current.id)).limit(1)).length > 0;
    const toState: "registered" | "waiting" = hasVitals ? "waiting" : "registered";

    const { instanceId } = await startInstance(tx, OPD_VISIT_DEF_KEY, {
      type: "opd_encounter", id: current.id, patientId: current.patientId, encounterId: current.id,
    });
    if (toState === "waiting") await transition(tx, instanceId, "waiting", PAPER_ACTOR, { note: "reopened after a paper completion" });

    const clearWaiver = current.consultFeeOverrideReason === PAPER_FEE_REASON;
    const rows = await tx
      .update(opdEncounters)
      .set({
        status: toState, workflowInstanceId: instanceId,
        consultStartedAt: null, consultCompletedAt: null, followUpDays: null, followUpExtended: false,
        completedVia: null, paperCompletedBy: null, paperCompletedAt: null, paperEvidenceKind: null, paperEvidenceId: null,
        paperConfirmedBy: null, paperConfirmedAt: null,
        paperReopenedBy: actor.id, paperReopenedAt: now, paperReopenReason: reason,
        ...(clearWaiver ? { consultFeeOverrideBy: null, consultFeeOverrideReason: null, consultFeeOverrideAt: null } : {}),
        updatedBy: actor.id, updatedAt: now,
      })
      .where(and(eq(opdEncounters.id, current.id), eq(opdEncounters.status, "completed")))
      .returning();
    const encounter = rows[0]!;

    await tx.insert(opdQueueEntries).values({
      id: newId(), sessionId: prev.sessionId, encounterId: current.id, tokenNo: prev.tokenNo, kind: prev.kind,
      appointmentAt: prev.appointmentAt, status: hasVitals ? "waiting" : "waiting_vitals",
      danger: encounter.dangerFlagged, reEntry: prev.reEntry, eligibleAt: hasVitals ? prev.eligibleAt ?? now : null,
    });

    let voidedPrescriptionId: string | null = null;
    if (input.voidTranscription === true) {
      const voided = await tx
        .update(opdPrescriptions).set({ status: "superseded" })
        .where(and(eq(opdPrescriptions.encounterId, current.id), eq(opdPrescriptions.status, "active")))
        .returning({ id: opdPrescriptions.id, transcribedBy: opdPrescriptions.transcribedBy });
      if (voided.some((v) => v.transcribedBy === null)) {
        throw new OpdError("doctor_rx_exists_state_conflict", "this visit's prescription was issued by the doctor — it is not withdrawn from here");
      }
      voidedPrescriptionId = voided[0]?.id ?? null;
      await tx.update(opdPrescriptionDrafts)
        .set({ status: "discarded", resolvedBy: actor.id, resolvedAt: now })
        .where(and(eq(opdPrescriptionDrafts.encounterId, current.id), eq(opdPrescriptionDrafts.status, "pending")));
    }

    await appendEvent(tx, consultationPaperReopened.make({
      actor, patientId: encounter.patientId, encounterId: encounter.id, correlationId: instanceId,
      payload: {
        encounterId: encounter.id, patientId: encounter.patientId, doctorId: encounter.doctorId,
        serviceDate: encounter.serviceDate, reason, toState, voidedPrescriptionId,
      },
    }));
    return { encounter };
  });
}
