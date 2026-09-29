import { and, asc, desc, eq, gte, inArray, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  imagingIrCases, imagingIrChecklists, imagingIrSedationVitals, imagingSafetyScreenings, imagingStudies,
} from "../../kernel/db/schema/radiology";
import { patients } from "../../kernel/db/schema/patients";
import { users } from "../../kernel/db/schema/auth";
import { resources } from "../../kernel/db/schema/resources";
import { workflowInstances } from "../../kernel/db/schema/workflow";
import { appendEvent } from "../../kernel/events/append";
import { recordPhiAccess } from "../../kernel/phi/audit";
import { istDayString } from "../../kernel/approvals/cumulative";
import { newId } from "@hmis/contracts";
import { displayName, guardiansWithAuthority } from "../patients";
import { latestVerifiedInr, latestVerifiedPlatelets } from "../lab";
import { ADULT_AGE_YEARS, NPO_CLEAR_FLUIDS_HOURS, NPO_SOLIDS_HOURS, consentSchema } from "../ot";
import { RadiologyError } from "./errors";
import {
  IR_COAGULATION_VERDICTS, imagingIrCoagulationOverridden, imagingIrSkinDoseAlert,
} from "./events";
import { clearanceOf } from "./read";
import { activeStudyTypes, requireStudyType } from "./study-types";
import type { IrChecklistPhase } from "../../kernel/db/schema/radiology";
import type { StudyType } from "./definitions";
import type { Db, Tx } from "../../kernel/db/client";
import type { Actor } from "@hmis/contracts";

/**
 * PLAN 18-S RS12b — **THE INTERVENTIONAL RADIOLOGY SUITE.**
 *
 * An IR case is an `imaging_studies` row whose study type says `interventional: true` (DECIDED — no
 * parallel procedure table; the accession, the gates, the dose register row and the report stay
 * the study's). This file owns what a procedure adds on top of a scan, and the order is the WHO
 * surgical safety checklist adapted to image-guided work (SIR / CIRSE practice, the standard an
 * Indian corporate hospital's IR suite runs):
 *
 *     Sign in (before sedation) → Time out (before the needle) → start acquisition → procedure
 *     (sedation chart every 5 min, fluoro time / DAP / Ka,r) → Sign out (before the patient leaves
 *     the table) → Send (the dose goes to the register) → procedure note → recovery hand-off.
 *
 * The refusals, and where each is enforced:
 *   · `ir_checklist_incomplete` — `startAcquisition` refuses an IR study without Sign in AND Time
 *     out; `recordAcquired` refuses one without Sign out (`assertIrStartable`/`assertIrSendable`,
 *     called from `acquisition.ts` so there is no second door to the machine).
 *   · `coagulation_out_of_range` — Sign in on a HIGH-bleeding-risk procedure (SIR 2019: PCN, PTBD,
 *     solid-organ biopsy) needs a signed INR ≤ 1.5 and platelets ≥ 50,000/µL drawn within 7 days,
 *     from the lab's own rows; missing, stale or out of range refuses unless a radiologist has
 *     recorded an override with a reason (`overrideCoagulation`: row + event — the audit).
 *   · `skin_followup_required` — Send with Ka,r ≥ 3 Gy refuses until the skin follow-up is
 *     documented (patient told, skin check booked 2–4 weeks out — NCRP 168 / SIR).
 *
 * The OT's shapes are REUSED through `ot/index.ts`: the consent (`consentSchema` — procedure code,
 * template version, language, interpreter, witness, signer/guardian, laterality), the fasting hours
 * (`NPO_SOLIDS_HOURS` 6 / `NPO_CLEAR_FLUIDS_HOURS` 2) and the adult age. The OT's `completeChecklist`
 * is bound to an OT case and cannot be called for a study; its A13 rule (a time-out needs at least
 * two DISTINCT people) is restated here with its source rather than re-decided.
 */

/** SIR / NCRP 168: reference-point air kerma at which the patient is told and a skin check follows. */
export const IR_KAR_SKIN_FOLLOWUP_MGY = 3000;
/** NCRP 168's Substantial Radiation Dose Level for Ka,r — the RSO reviews the case. */
export const IR_KAR_SRDL_MGY = 5000;
/** SIR 2019 consensus, high-bleeding-risk procedures. */
export const IR_INR_MAX = 1.5;
export const IR_PLATELETS_MIN_PER_UL = 50_000;
export const IR_COAG_VALID_DAYS = 7;
/** Moderate/deep sedation: BP, HR, SpO₂ and the sedation score at least every 5 minutes (ASA / SIR). */
export const IR_SEDATION_VITALS_EVERY_MIN = 5;
/** After Send and until the hand-off, the recovery observations: every 15 minutes (DECIDED — the common PACU cadence). */
export const IR_RECOVERY_VITALS_EVERY_MIN = 15;
/** The skin check is booked 2–4 weeks after the procedure. */
export const IR_SKIN_FOLLOWUP_DAYS = { min: 14, max: 28 } as const;
/** A time-out is the whole team stopping: at least two DISTINCT people (OT A13). */
export const IR_TIME_OUT_MIN_PARTICIPANTS = 2;

export const IR_THRESHOLDS = {
  skinFollowUpMgy: IR_KAR_SKIN_FOLLOWUP_MGY, srdlMgy: IR_KAR_SRDL_MGY, inrMax: IR_INR_MAX,
  plateletsMinPerUl: IR_PLATELETS_MIN_PER_UL, coagValidDays: IR_COAG_VALID_DAYS,
  vitalsEveryMin: IR_SEDATION_VITALS_EVERY_MIN, recoveryVitalsEveryMin: IR_RECOVERY_VITALS_EVERY_MIN, skinFollowUpDays: IR_SKIN_FOLLOWUP_DAYS,
  fastingSolidsHours: NPO_SOLIDS_HOURS, fastingClearHours: NPO_CLEAR_FLUIDS_HOURS,
} as const;

/** `local` = local anaesthesia only (no fasting rule, no sedation chart clock). */
export const IR_SEDATION_PLANS = ["local", "moderate", "deep"] as const;
export type IrSedationPlan = (typeof IR_SEDATION_PLANS)[number];
export type IrCoagulationVerdict = (typeof IR_COAGULATION_VERDICTS)[number];

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const text = (max: number) => z.string().trim().min(1).max(max);
const participantsSchema = z.array(text(120)).min(1).max(12);

/* ═══════════════════════════════ bodies ═══════════════════════════════ */

export const irSignInSchema = z.object({
  participants: participantsSchema,
  /** The patient states name and date of birth; the wristband is read (room gate `identity_two_factor`). */
  identityConfirmed: z.boolean(),
  /** OT consent shape; IR requires a witness on every consent (DECIDED). */
  consent: consentSchema,
  siteMarked: z.boolean(),
  allergiesReviewed: z.boolean(),
  anticoagulants: z.enum(["none", "held", "continued"]),
  anticoagulantNote: z.string().trim().max(400).optional(),
  sedationPlan: z.enum(IR_SEDATION_PLANS),
  /** Who gives and watches the sedation (anaesthetist or sedation nurse). Required for moderate/deep. */
  sedationBy: z.string().trim().max(120).optional(),
  lastSolidsAt: z.string().datetime({ offset: true }).optional(),
  lastClearFluidsAt: z.string().datetime({ offset: true }).optional(),
  ivAccessAndResus: z.boolean(),
}).strict();
export type IrSignInInput = z.infer<typeof irSignInSchema>;

export const irTimeOutSchema = z.object({
  participants: participantsSchema,
  teamIntroduced: z.boolean(),
  patientProcedureSideConfirmed: z.boolean(),
  imagesDisplayed: z.boolean(),
  antibiotics: z.enum(["given", "not_indicated"]),
  criticalEventsDiscussed: z.boolean(),
}).strict();
export type IrTimeOutInput = z.infer<typeof irTimeOutSchema>;

export const irSignOutSchema = z.object({
  participants: participantsSchema,
  procedureDone: z.boolean(),
  countsCorrect: z.boolean(),
  specimens: z.enum(["labelled", "none"]),
  /** Devices / catheters left in the patient, or "none". */
  devices: text(400),
  doseRecorded: z.boolean(),
  recoveryPlanGiven: z.boolean(),
}).strict();
export type IrSignOutInput = z.infer<typeof irSignOutSchema>;

export const irVitalsSchema = z.object({
  bpSystolic: z.number().int().min(40).max(300),
  bpDiastolic: z.number().int().min(20).max(200),
  heartRate: z.number().int().min(20).max(250),
  spo2: z.number().int().min(50).max(100),
  rass: z.number().int().min(-5).max(4),
  drug: z.string().trim().max(200).optional(),
}).strict().refine((v) => v.bpDiastolic < v.bpSystolic, { message: "the diastolic pressure is below the systolic" });
export type IrVitalsInput = z.infer<typeof irVitalsSchema>;

export const irSkinFollowUpSchema = z.object({
  patientInformed: z.literal(true),
  followUpOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  note: z.string().trim().max(400).optional(),
}).strict();
export type IrSkinFollowUpInput = z.infer<typeof irSkinFollowUpSchema>;

export const irNoteSchema = z.object({
  procedure: z.string().trim().min(3).max(2000),
  approach: z.string().trim().max(400).optional(),
  devices: z.string().trim().max(400).optional(),
  specimens: z.string().trim().max(400).optional(),
  complications: z.string().trim().max(1000).optional(),
  bloodLossMl: z.number().int().min(0).max(10_000).optional(),
}).strict();
export type IrNoteInput = z.infer<typeof irNoteSchema>;

export const irHandoffSchema = z.object({
  vitals: z.object({
    bpSystolic: z.number().int().min(40).max(300),
    bpDiastolic: z.number().int().min(20).max(200),
    heartRate: z.number().int().min(20).max(250),
    spo2: z.number().int().min(50).max(100),
  }).strict(),
  bedRestHours: z.number().int().min(0).max(24),
  drainCare: z.string().trim().max(600).optional(),
  instructionsEn: z.string().trim().min(10).max(2000),
  instructionsHi: z.string().trim().min(10).max(2000),
  receivedBy: z.string().trim().min(2).max(120),
}).strict();
export type IrHandoffInput = z.infer<typeof irHandoffSchema>;

/* ═══════════════════════════════ reads ═══════════════════════════════ */

type StudyRow = typeof imagingStudies.$inferSelect;

async function loadStudy(exec: Db | Tx, studyId: string): Promise<StudyRow> {
  const [study] = await (exec as Db).select().from(imagingStudies).where(eq(imagingStudies.id, studyId));
  if (!study) throw new RadiologyError("unknown_study", `no study ${studyId}`, { studyId });
  return study;
}

async function loadIrStudy(exec: Db | Tx, studyId: string): Promise<{ study: StudyRow; studyType: StudyType }> {
  const study = await loadStudy(exec, studyId);
  const studyType = await requireStudyType(exec, study.studyTypeCode);
  if (studyType.interventional !== true) {
    throw new RadiologyError(
      "not_interventional",
      `${studyType.name} is not an image-guided procedure — it is worked at the room console, not the IR suite`,
      { studyId, studyTypeCode: study.studyTypeCode },
    );
  }
  return { study, studyType };
}

async function phasesOf(exec: Db | Tx, studyId: string) {
  return (exec as Db).select().from(imagingIrChecklists).where(eq(imagingIrChecklists.studyId, studyId));
}

async function caseOf(exec: Db | Tx, studyId: string) {
  const [row] = await (exec as Db).select().from(imagingIrCases).where(eq(imagingIrCases.studyId, studyId));
  return row ?? null;
}

async function ensureCase(tx: Tx, studyId: string, now: Date): Promise<void> {
  await tx.insert(imagingIrCases).values({ studyId, createdAt: now }).onConflictDoNothing();
}

const PHASE_WORDS: Record<IrChecklistPhase, string> = { sign_in: "Sign in", time_out: "Time out", sign_out: "Sign out" };

/* ═══════════════════════════════ coagulation ═══════════════════════════════ */

export type CoagulationRead = {
  required: boolean;
  inr: { value: number; sampledAt: Date } | null;
  platelets: { perUl: number; sampledAt: Date } | null;
  /** Empty = within the rule (or not required). */
  verdicts: IrCoagulationVerdict[];
};

/** Pure: the SIR 2019 rule for a high-bleeding-risk procedure. */
export function coagulationVerdicts(
  inr: { value: number; sampledAt: Date } | null,
  platelets: { perUl: number; sampledAt: Date } | null,
  now: Date,
): IrCoagulationVerdict[] {
  const out: IrCoagulationVerdict[] = [];
  if (inr === null || platelets === null) out.push("missing");
  const cutoff = now.getTime() - IR_COAG_VALID_DAYS * DAY_MS;
  if ((inr !== null && inr.sampledAt.getTime() < cutoff) || (platelets !== null && platelets.sampledAt.getTime() < cutoff)) {
    out.push("stale");
  }
  if (inr !== null && inr.value > IR_INR_MAX) out.push("inr_high");
  if (platelets !== null && platelets.perUl < IR_PLATELETS_MIN_PER_UL) out.push("platelets_low");
  return out;
}

export async function coagulationFor(exec: Db | Tx, patientId: string, studyType: StudyType, now: Date): Promise<CoagulationRead> {
  const inrRow = await latestVerifiedInr(exec, patientId);
  const pltRow = await latestVerifiedPlatelets(exec, patientId);
  const inr = inrRow === null ? null : { value: inrRow.value, sampledAt: inrRow.sampledAt };
  const platelets = pltRow === null ? null : { perUl: pltRow.value, sampledAt: pltRow.sampledAt };
  const required = studyType.bleeding_risk === "high";
  return { required, inr, platelets, verdicts: required ? coagulationVerdicts(inr, platelets, now) : [] };
}

const VERDICT_WORDS: Record<IrCoagulationVerdict, string> = {
  missing: "no signed INR and platelet count on file",
  stale: `the INR or platelet count was drawn more than ${String(IR_COAG_VALID_DAYS)} days ago`,
  inr_high: `the INR is above ${String(IR_INR_MAX)}`,
  platelets_low: `the platelet count is below ${IR_PLATELETS_MIN_PER_UL.toLocaleString("en-IN")}/µL`,
};

/* ═══════════════════════════════ the checklist ═══════════════════════════════ */

function incomplete(phase: IrChecklistPhase, missing: string[], words: string[]): RadiologyError {
  return new RadiologyError(
    "ir_checklist_incomplete",
    `${PHASE_WORDS[phase]} is not complete: ${words.join("; ")}`,
    { phase, missing },
  );
}

async function assertPhaseFree(tx: Tx, studyId: string, phase: IrChecklistPhase): Promise<void> {
  const done = (await phasesOf(tx, studyId)).find((p) => p.phase === phase);
  if (done !== undefined) {
    throw new RadiologyError("ir_phase_recorded", `${PHASE_WORDS[phase]} was already recorded for this procedure`, { phase });
  }
}

async function writePhase(
  tx: Tx, actor: Actor, studyId: string, phase: IrChecklistPhase, items: { key: string; answer: unknown; note?: string }[],
  participants: string[], now: Date,
): Promise<{ phase: IrChecklistPhase; recordedAt: Date }> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`radiology.ir:${studyId}`}))`);
  await assertPhaseFree(tx, studyId, phase);
  await ensureCase(tx, studyId, now);
  await tx.insert(imagingIrChecklists).values({
    id: newId(), studyId, phase, items, participants: [...new Set(participants.map((p) => p.trim()))],
    recordedBy: actor.id, recordedAt: now,
  });
  return { phase, recordedAt: now };
}

/** A room gate that is still open (the wristband not yet read) — terminal states pass. */
async function openRoomGate(exec: Db | Tx, studyId: string, kind: string): Promise<boolean> {
  const rows = await (exec as Db)
    .select({ state: workflowInstances.currentState })
    .from(imagingSafetyScreenings)
    .innerJoin(workflowInstances, eq(workflowInstances.id, imagingSafetyScreenings.workflowInstanceId))
    .where(and(eq(imagingSafetyScreenings.studyId, studyId), eq(imagingSafetyScreenings.kind, kind)));
  return rows.some((r) => r.state === "open");
}

const PRE_START = ["checked_in", "ready"];
const LIVE = ["scheduled", "checked_in", "ready", "in_acquisition"];
const AFTER = ["acquired", "reported", "published"];

/**
 * **Sign in — before sedation.** Identity, consent, site, allergies, anticoagulants, fasting, IV
 * access and the resuscitation trolley; the coagulation rule for a high-bleeding-risk procedure.
 */
export async function irSignIn(tx: Tx, actor: Actor, studyId: string, input: IrSignInInput, now: Date = new Date()): Promise<{ phase: IrChecklistPhase; recordedAt: Date }> {
  const { study, studyType } = await loadIrStudy(tx, studyId);
  if (!PRE_START.includes(study.status)) {
    throw new RadiologyError(
      "bad_transition",
      study.status === "scheduled"
        ? "the patient has not arrived — check the patient in at the desk (or open them from the IR list) before Sign in"
        : `this procedure is ${study.status.replace("_", " ")} — Sign in happens before sedation, once`,
      { studyId, status: study.status },
    );
  }
  const missing: string[] = [];
  const words: string[] = [];
  const miss = (key: string, w: string) => { missing.push(key); words.push(w); };

  if (!input.identityConfirmed) miss("identity", "the patient's identity is not confirmed");
  if (await openRoomGate(tx, studyId, "identity_two_factor")) miss("identity_gate", "the wristband / second identifier has not been checked");
  if (studyType.laterality_applicable && await openRoomGate(tx, studyId, "laterality_confirm")) miss("side_gate", "the side has not been confirmed with the patient");

  /** Consent: the OT shape, for THIS procedure, witnessed (DECIDED for IR), the side agreeing. */
  const c = input.consent;
  if (c.procedureCode !== study.studyTypeCode) miss("consent", `the consent is for "${c.procedureCode}", not ${studyType.name}`);
  if (c.witness === undefined) miss("consent_witness", "the consent names no witness");
  const studySide = study.laterality === "na" ? null : study.laterality;
  if (studyType.laterality_applicable && studySide !== null && c.laterality !== studySide) {
    miss("consent_side", `the consent's side (${String(c.laterality)}) is not the procedure's (${studySide})`);
  }
  const [pt] = await tx.select({ dob: patients.dob }).from(patients).where(eq(patients.id, study.patientId));
  const age = pt?.dob == null ? null : Math.floor((now.getTime() - pt.dob.getTime()) / (365.2425 * DAY_MS));
  if (age !== null && age < ADULT_AGE_YEARS && c.signer !== "guardian") miss("consent_guardian", "the patient is a minor — the consent is the guardian's");
  if (c.signer === "guardian") {
    const g = (await guardiansWithAuthority(tx, study.patientId, now)).find((x) => x.guardianId === c.guardianId);
    if (g === undefined || !g.authority.consents) miss("consent_guardian", "the guardian named does not hold consent authority for this patient");
  }

  if (studyType.laterality_applicable && !input.siteMarked) miss("site", "the site is not marked");
  if (!input.allergiesReviewed) miss("allergies", "the allergy and contrast history has not been read aloud");
  if (input.anticoagulants === "continued" && (input.anticoagulantNote ?? "").trim() === "") {
    miss("anticoagulants", "an anticoagulant continued through the procedure needs the operator's note");
  }
  if (!input.ivAccessAndResus) miss("iv_access", "IV access, the crash cart and the reversal agents are not checked");

  if (input.sedationPlan !== "local") {
    if ((input.sedationBy ?? "").trim() === "") miss("sedation_by", "nobody is named to give and watch the sedation");
    /** Fasting: 6 h solids / 2 h clear (the OT's hours). A STAT procedure proceeds with the times recorded. */
    if (study.priority !== "stat") {
      const solids = input.lastSolidsAt === undefined ? null : new Date(input.lastSolidsAt);
      const clear = input.lastClearFluidsAt === undefined ? null : new Date(input.lastClearFluidsAt);
      if (solids === null || clear === null) miss("fasting", "the last solid food and last clear fluid times are not recorded");
      else {
        if (now.getTime() - solids.getTime() < NPO_SOLIDS_HOURS * HOUR_MS) miss("fasting", `solids less than ${String(NPO_SOLIDS_HOURS)} hours ago`);
        if (now.getTime() - clear.getTime() < NPO_CLEAR_FLUIDS_HOURS * HOUR_MS) miss("fasting", `clear fluids less than ${String(NPO_CLEAR_FLUIDS_HOURS)} hours ago`);
      }
    }
  }
  if (missing.length > 0) throw incomplete("sign_in", [...new Set(missing)], words);

  /** The lab's answer, last: every other item is the team's, this one is the blood's. */
  const coag = await coagulationFor(tx, study.patientId, studyType, now);
  if (coag.verdicts.length > 0) {
    const kase = await caseOf(tx, studyId);
    if (kase?.coagOverrideAt == null) {
      throw new RadiologyError(
        "coagulation_out_of_range",
        `${studyType.name} is a high-bleeding-risk procedure and ${coag.verdicts.map((v) => VERDICT_WORDS[v]).join("; ")} — `
        + `correct and recheck, or the radiologist overrides with a reason`,
        { studyId, verdicts: coag.verdicts, inr: coag.inr?.value ?? null, plateletsPerUl: coag.platelets?.perUl ?? null },
      );
    }
  }

  return writePhase(tx, actor, studyId, "sign_in", [
    { key: "identity", answer: true },
    { key: "consent", answer: c },
    { key: "site_marked", answer: studyType.laterality_applicable ? input.siteMarked : "na" },
    { key: "allergies_reviewed", answer: true },
    { key: "anticoagulants", answer: input.anticoagulants, ...(input.anticoagulantNote ? { note: input.anticoagulantNote } : {}) },
    { key: "sedation_plan", answer: input.sedationPlan, ...(input.sedationBy ? { note: input.sedationBy } : {}) },
    { key: "fasting", answer: { lastSolidsAt: input.lastSolidsAt ?? null, lastClearFluidsAt: input.lastClearFluidsAt ?? null } },
    { key: "iv_access_resus", answer: true },
    { key: "coagulation", answer: {
      required: coag.required, verdicts: coag.verdicts, inr: coag.inr?.value ?? null, plateletsPerUl: coag.platelets?.perUl ?? null,
    } },
  ], input.participants, now);
}

/** **Time out — before the needle.** The whole team, aloud; at least two different people. */
export async function irTimeOut(tx: Tx, actor: Actor, studyId: string, input: IrTimeOutInput, now: Date = new Date()): Promise<{ phase: IrChecklistPhase; recordedAt: Date }> {
  const { study } = await loadIrStudy(tx, studyId);
  if (!PRE_START.includes(study.status)) {
    throw new RadiologyError("bad_transition", `this procedure is ${study.status.replace("_", " ")} — Time out happens before the needle`, { studyId, status: study.status });
  }
  const phases = await phasesOf(tx, studyId);
  if (!phases.some((p) => p.phase === "sign_in")) throw incomplete("time_out", ["sign_in"], ["Sign in has not been done"]);
  const missing: string[] = [];
  const words: string[] = [];
  const distinct = new Set(input.participants.map((p) => p.trim().toLowerCase()));
  if (distinct.size < IR_TIME_OUT_MIN_PARTICIPANTS) {
    missing.push("participants"); words.push(`a time out needs at least ${String(IR_TIME_OUT_MIN_PARTICIPANTS)} different people`);
  }
  if (!input.teamIntroduced) { missing.push("team"); words.push("the team has not introduced itself by name and role"); }
  if (!input.patientProcedureSideConfirmed) { missing.push("confirmed"); words.push("patient, procedure and side not confirmed aloud"); }
  if (!input.imagesDisplayed) { missing.push("images"); words.push("the relevant images are not displayed"); }
  if (!input.criticalEventsDiscussed) { missing.push("critical_events"); words.push("the anticipated critical events have not been said aloud"); }
  if (missing.length > 0) throw incomplete("time_out", missing, words);
  return writePhase(tx, actor, studyId, "time_out", [
    { key: "team_introduced", answer: true },
    { key: "patient_procedure_side", answer: true },
    { key: "images_displayed", answer: true },
    { key: "antibiotics", answer: input.antibiotics },
    { key: "critical_events", answer: true },
  ], input.participants, now);
}

/** **Sign out — before the patient leaves the table.** */
export async function irSignOut(tx: Tx, actor: Actor, studyId: string, input: IrSignOutInput, now: Date = new Date()): Promise<{ phase: IrChecklistPhase; recordedAt: Date }> {
  const { study } = await loadIrStudy(tx, studyId);
  if (study.status !== "in_acquisition") {
    throw new RadiologyError(
      "bad_transition",
      `this procedure is ${study.status.replace("_", " ")} — Sign out is recorded while the patient is still on the table`,
      { studyId, status: study.status },
    );
  }
  const missing: string[] = [];
  const words: string[] = [];
  if (!input.procedureDone) { missing.push("procedure"); words.push("the procedure performed is not confirmed"); }
  if (!input.countsCorrect) { missing.push("counts"); words.push("the needle, guidewire and sponge count is not correct"); }
  if (!input.doseRecorded) { missing.push("dose"); words.push("fluoro time, DAP and Ka,r are not recorded"); }
  if (!input.recoveryPlanGiven) { missing.push("plan"); words.push("the recovery plan has not been given"); }
  if (missing.length > 0) throw incomplete("sign_out", missing, words);
  return writePhase(tx, actor, studyId, "sign_out", [
    { key: "procedure_done", answer: true },
    { key: "counts_correct", answer: true },
    { key: "specimens", answer: input.specimens },
    { key: "devices", answer: input.devices },
    { key: "dose_recorded", answer: true },
    { key: "recovery_plan", answer: true },
  ], input.participants, now);
}

/**
 * The radiologist accepts a missing, stale or out-of-range INR / platelet count, in writing. The
 * controller holds it to `radiology.gates.override` (the radiologist's — the nurse and the
 * technologist ask); here it is recorded once, with the verdict it overrode, and evented.
 */
export async function overrideCoagulation(tx: Tx, actor: Actor, studyId: string, reason: string, now: Date = new Date()): Promise<{ verdicts: IrCoagulationVerdict[] }> {
  const { study, studyType } = await loadIrStudy(tx, studyId);
  const why = reason.trim();
  if (why.length < 5) throw new RadiologyError("reason_required", "an override of the coagulation rule carries the operator's reason");
  const coag = await coagulationFor(tx, study.patientId, studyType, now);
  if (coag.verdicts.length === 0) {
    throw new RadiologyError(
      "coagulation_in_range",
      coag.required ? "the INR and platelet count are within the rule — there is nothing to override" : `${studyType.name} is not a high-bleeding-risk procedure — no coagulation rule applies`,
      { studyId },
    );
  }
  await ensureCase(tx, studyId, now);
  /** Once: the conditional UPDATE is the single-winner control, as the study's own CAS is. */
  const updated = await tx.update(imagingIrCases)
    .set({ coagOverrideVerdict: coag.verdicts.join(","), coagOverrideReason: why, coagOverrideBy: actor.id, coagOverrideAt: now })
    .where(and(eq(imagingIrCases.studyId, studyId), isNull(imagingIrCases.coagOverrideAt)))
    .returning({ id: imagingIrCases.studyId });
  if (updated.length === 0) {
    throw new RadiologyError("ir_phase_recorded", "the coagulation override was already recorded for this procedure", { studyId });
  }
  await appendEvent(tx, imagingIrCoagulationOverridden.make({
    actor, patientId: study.patientId, encounterId: study.encounterNo,
    payload: { studyId, verdicts: coag.verdicts },
  }));
  return { verdicts: coag.verdicts };
}

const CHARTING = ["checked_in", "ready", "in_acquisition", "acquired", "reported", "published"];

/** One reading on the sedation chart. */
export async function recordSedationVitals(tx: Tx, actor: Actor, studyId: string, input: IrVitalsInput, now: Date = new Date()): Promise<{ id: string; recordedAt: Date }> {
  const { study } = await loadIrStudy(tx, studyId);
  if (!CHARTING.includes(study.status)) {
    throw new RadiologyError("bad_transition", `this procedure is ${study.status.replace("_", " ")} — there is no patient to chart`, { studyId, status: study.status });
  }
  if (!(await phasesOf(tx, studyId)).some((p) => p.phase === "sign_in")) {
    throw incomplete("sign_in", ["sign_in"], ["Sign in comes before the sedation chart"]);
  }
  if ((await caseOf(tx, studyId))?.handoffAt != null) {
    throw new RadiologyError("ir_handoff_recorded", "the patient has been handed to recovery — the ward charts from here", { studyId });
  }
  const id = newId();
  await tx.insert(imagingIrSedationVitals).values({
    id, studyId, bpSystolic: input.bpSystolic, bpDiastolic: input.bpDiastolic, heartRate: input.heartRate,
    spo2: input.spo2, rass: input.rass, drug: (input.drug ?? "").trim() === "" ? null : input.drug!.trim(),
    recordedBy: actor.id, recordedAt: now,
  });
  return { id, recordedAt: now };
}

/** Ka,r ≥ 3 Gy: the patient was told, and a skin check is booked 2–4 weeks out. */
export async function recordSkinFollowUp(tx: Tx, actor: Actor, studyId: string, input: IrSkinFollowUpInput, now: Date = new Date()): Promise<{ followUpOn: string }> {
  const { study } = await loadIrStudy(tx, studyId);
  if (!["in_acquisition", "acquired", "reported", "published"].includes(study.status)) {
    throw new RadiologyError("bad_transition", "the skin follow-up is documented once the procedure has started", { studyId, status: study.status });
  }
  const today = new Date(`${istDayString(now)}T00:00:00Z`).getTime();
  const on = new Date(`${input.followUpOn}T00:00:00Z`).getTime();
  const days = Math.round((on - today) / DAY_MS);
  if (Number.isNaN(on) || days < IR_SKIN_FOLLOWUP_DAYS.min || days > IR_SKIN_FOLLOWUP_DAYS.max) {
    throw new RadiologyError(
      "invalid_date",
      `the skin check is booked ${String(IR_SKIN_FOLLOWUP_DAYS.min / 7)}–${String(IR_SKIN_FOLLOWUP_DAYS.max / 7)} weeks after the procedure; ${input.followUpOn} is ${String(days)} days away`,
      { followUpOn: input.followUpOn, days },
    );
  }
  await ensureCase(tx, studyId, now);
  const updated = await tx.update(imagingIrCases).set({
    skinFollowUpOn: input.followUpOn, skinFollowUpNote: (input.note ?? "").trim() === "" ? null : input.note!.trim(),
    skinFollowUpBy: actor.id, skinFollowUpAt: now,
  }).where(and(eq(imagingIrCases.studyId, studyId), isNull(imagingIrCases.skinFollowUpAt)))
    .returning({ id: imagingIrCases.studyId });
  if (updated.length === 0) {
    throw new RadiologyError("ir_phase_recorded", "the skin follow-up was already documented for this procedure", { studyId });
  }
  return { followUpOn: input.followUpOn };
}

/** The procedure note — written (and rewritten) by the operator until the patient is handed over. */
export async function recordProcedureNote(tx: Tx, actor: Actor, studyId: string, input: IrNoteInput, now: Date = new Date()): Promise<{ noteAt: Date }> {
  const { study } = await loadIrStudy(tx, studyId);
  if (!["in_acquisition", "acquired", "reported", "published"].includes(study.status)) {
    throw new RadiologyError("bad_transition", "the procedure note is written once the procedure has started", { studyId, status: study.status });
  }
  await ensureCase(tx, studyId, now);
  if ((await caseOf(tx, studyId))?.handoffAt != null) {
    throw new RadiologyError("ir_handoff_recorded", "the patient has been handed to recovery with this note — it is closed", { studyId });
  }
  const opt = (v: string | undefined) => ((v ?? "").trim() === "" ? null : v!.trim());
  await tx.update(imagingIrCases).set({
    noteProcedure: input.procedure.trim(), noteApproach: opt(input.approach), noteDevices: opt(input.devices),
    noteSpecimens: opt(input.specimens), noteComplications: opt(input.complications),
    noteBloodLossMl: input.bloodLossMl ?? null, noteBy: actor.id, noteAt: now,
  }).where(eq(imagingIrCases.studyId, studyId));
  return { noteAt: now };
}

/** The recovery hand-off: vitals, drain care, bed rest, and the instructions in English and Hindi. */
export async function recordHandoff(tx: Tx, actor: Actor, studyId: string, input: IrHandoffInput, now: Date = new Date()): Promise<{ handoffAt: Date }> {
  const { study } = await loadIrStudy(tx, studyId);
  if (!["acquired", "reported", "published"].includes(study.status)) {
    throw new RadiologyError("bad_transition", "the patient is handed to recovery after Send", { studyId, status: study.status });
  }
  await ensureCase(tx, studyId, now);
  const kase = await caseOf(tx, studyId);
  if (kase?.handoffAt != null) throw new RadiologyError("ir_handoff_recorded", "this patient was already handed to recovery", { studyId });
  if (kase?.noteAt == null) throw incomplete("sign_out", ["procedure_note"], ["the procedure note has not been written"]);
  const updated = await tx.update(imagingIrCases).set({ handoff: input, handoffBy: actor.id, handoffAt: now })
    .where(and(eq(imagingIrCases.studyId, studyId), isNull(imagingIrCases.handoffAt)))
    .returning({ id: imagingIrCases.studyId });
  if (updated.length === 0) throw new RadiologyError("ir_handoff_recorded", "this patient was already handed to recovery", { studyId });
  return { handoffAt: now };
}

/* ═══════════════════ the two doors to the machine (called from acquisition.ts) ═══════════════════ */

/** `startAcquisition`: an IR study goes on the table only after Sign in and Time out. */
export async function assertIrStartable(tx: Tx, studyId: string, studyType: StudyType): Promise<void> {
  if (studyType.interventional !== true) return;
  const phases = new Set((await phasesOf(tx, studyId)).map((p) => p.phase));
  const missing = (["sign_in", "time_out"] as const).filter((p) => !phases.has(p));
  if (missing.length > 0) {
    throw new RadiologyError(
      "ir_checklist_incomplete",
      `${missing.map((p) => PHASE_WORDS[p]).join(" and ")} ${missing.length === 1 ? "has" : "have"} not been done — the procedure does not start before them`,
      { phase: missing[0], missing },
    );
  }
}

/** `recordAcquired`: Sign out first; Ka,r ≥ 3 Gy needs the skin follow-up documented. */
export async function assertIrSendable(tx: Tx, studyId: string, studyType: StudyType, karMgy: number | null): Promise<void> {
  if (studyType.interventional !== true) return;
  if (!(await phasesOf(tx, studyId)).some((p) => p.phase === "sign_out")) {
    throw new RadiologyError(
      "ir_checklist_incomplete",
      "Sign out has not been done — record it with the patient still on the table, then Send",
      { phase: "sign_out", missing: ["sign_out"] },
    );
  }
  if (karMgy !== null && karMgy >= IR_KAR_SKIN_FOLLOWUP_MGY && (await caseOf(tx, studyId))?.skinFollowUpAt == null) {
    throw new RadiologyError(
      "skin_followup_required",
      `the reference air kerma is ${(karMgy / 1000).toFixed(2)} Gy, at or above ${String(IR_KAR_SKIN_FOLLOWUP_MGY / 1000)} Gy — `
      + "tell the patient, note the skin site and book the skin check at 2–4 weeks before Send",
      { studyId, karMgy },
    );
  }
}

/** Pure: the Ka,r triggers a number reaches. */
export function skinDoseLevels(karMgy: number | null): { level: "skin_followup" | "substantial_radiation_dose_level"; thresholdMgy: number }[] {
  if (karMgy === null) return [];
  const out: { level: "skin_followup" | "substantial_radiation_dose_level"; thresholdMgy: number }[] = [];
  if (karMgy >= IR_KAR_SKIN_FOLLOWUP_MGY) out.push({ level: "skin_followup", thresholdMgy: IR_KAR_SKIN_FOLLOWUP_MGY });
  if (karMgy >= IR_KAR_SRDL_MGY) out.push({ level: "substantial_radiation_dose_level", thresholdMgy: IR_KAR_SRDL_MGY });
  return out;
}

/** At Send, after the register row: one `imaging.ir_skin_dose_alert` per trigger reached. */
export async function raiseSkinDoseAlerts(tx: Tx, actor: Actor, study: StudyRow, karMgy: number | null): Promise<number> {
  const levels = skinDoseLevels(karMgy);
  for (const l of levels) {
    await appendEvent(tx, imagingIrSkinDoseAlert.make({
      actor, patientId: study.patientId, encounterId: study.encounterNo,
      payload: {
        studyId: study.id, accessionNo: study.accessionNo, deviceResourceId: study.deviceResourceId!,
        level: l.level, thresholdMgy: l.thresholdMgy,
      },
    }));
  }
  return levels.length;
}

/* ═══════════════════════════════ the suite's reads ═══════════════════════════════ */

export type IrNextAct = "check_in" | "sign_in" | "time_out" | "start" | "sign_out" | "send" | "note" | "handoff" | "done" | "closed";

export type IrCaseView = {
  studyId: string;
  accessionNo: string;
  status: string;
  priority: string;
  studyTypeCode: string;
  studyTypeName: string;
  bleedingRisk: "low" | "high";
  lateralityApplicable: boolean;
  laterality: string;
  patient: { name: string; uhid: string; restricted: boolean; ageYears: number | null; sex: string };
  phases: { phase: IrChecklistPhase; items: unknown; participants: unknown; recordedByName: string; recordedAt: Date }[];
  coagulation: {
    required: boolean;
    inr: { value: number; sampledAt: Date } | null;
    platelets: { perUl: number; sampledAt: Date } | null;
    verdicts: IrCoagulationVerdict[];
    override: { verdict: string; reason: string; byName: string; at: Date } | null;
  };
  sedation: {
    plan: IrSedationPlan | null;
    vitals: { id: string; bpSystolic: number; bpDiastolic: number; heartRate: number; spo2: number; rass: number; drug: string | null; recordedByName: string; recordedAt: Date }[];
    /** When the next reading is due (moderate/deep sedation, until hand-off); null when no clock runs. */
    nextDueAt: Date | null;
  };
  dose: { karMgy: number | null; dapGyCm2: number | null; fluoroSeconds: number | null; levels: ReturnType<typeof skinDoseLevels> };
  skinFollowUp: { on: string; note: string | null; byName: string; at: Date } | null;
  note: { procedure: string; approach: string | null; devices: string | null; specimens: string | null; complications: string | null; bloodLossMl: number | null; byName: string; at: Date } | null;
  handoff: { detail: IrHandoffInput; byName: string; at: Date } | null;
  next: IrNextAct;
  thresholds: typeof IR_THRESHOLDS;
};

function nextAct(status: string, phases: Set<string>, noteAt: Date | null, handoffAt: Date | null): IrNextAct {
  if (["cancelled", "no_show", "rescheduled"].includes(status)) return "closed";
  if (status === "scheduled") return "check_in";
  if (PRE_START.includes(status)) return !phases.has("sign_in") ? "sign_in" : !phases.has("time_out") ? "time_out" : "start";
  if (status === "in_acquisition") return phases.has("sign_out") ? "send" : "sign_out";
  if (handoffAt !== null) return "done";
  return noteAt === null ? "note" : "handoff";
}

const numOrNull = (v: string | null): number | null => (v === null ? null : Number(v));

export async function irCaseView(db: Db, actor: Actor, studyId: string, now: Date = new Date()): Promise<IrCaseView> {
  const clearance = await clearanceOf(db, actor);
  const { study, studyType } = await loadIrStudy(db, studyId);
  const [pt] = await db.select().from(patients).where(eq(patients.id, study.patientId));
  const phases = (await phasesOf(db, studyId)).sort((a, b) => a.recordedAt.getTime() - b.recordedAt.getTime());
  const kase = await caseOf(db, studyId);
  const vitals = await db.select().from(imagingIrSedationVitals)
    .where(eq(imagingIrSedationVitals.studyId, studyId)).orderBy(asc(imagingIrSedationVitals.recordedAt));
  const coag = await coagulationFor(db, study.patientId, studyType, now);

  const userIds = [...new Set([
    ...phases.map((p) => p.recordedBy), ...vitals.map((v) => v.recordedBy),
    kase?.coagOverrideBy, kase?.skinFollowUpBy, kase?.noteBy, kase?.handoffBy,
  ].filter((x): x is string => typeof x === "string"))];
  const nameOf = new Map((userIds.length === 0 ? [] : await db.select({ id: users.id, name: users.fullName })
    .from(users).where(inArray(users.id, userIds))).map((u) => [u.id, u.name]));
  const who = (id: string | null | undefined) => (id == null ? "—" : nameOf.get(id) ?? "—");

  const signIn = phases.find((p) => p.phase === "sign_in");
  const planItem = (signIn?.items as { key: string; answer: unknown }[] | undefined)?.find((i) => i.key === "sedation_plan");
  const plan = (IR_SEDATION_PLANS as readonly string[]).includes(String(planItem?.answer)) ? planItem!.answer as IrSedationPlan : null;
  const lastAt = vitals.length === 0 ? (signIn?.recordedAt ?? null) : vitals[vitals.length - 1]!.recordedAt;
  const clockRuns = plan !== null && plan !== "local" && kase?.handoffAt == null && lastAt !== null;

  await recordPhiAccess(db, {
    actor, patientId: study.patientId, surface: "imaging.study",
    encounterId: study.encounterNo, reason: `IR suite ${study.accessionNo}`,
  });
  const restricted = pt!.isConfidential && !clearance.canSeeConfidential;
  const kar = numOrNull(study.doseKar);

  return {
    studyId: study.id, accessionNo: study.accessionNo, status: study.status, priority: study.priority,
    studyTypeCode: study.studyTypeCode, studyTypeName: studyType.name,
    bleedingRisk: studyType.bleeding_risk ?? "low",
    lateralityApplicable: studyType.laterality_applicable, laterality: study.laterality,
    patient: {
      name: displayName({ name: pt!.name, alias: pt!.alias, isConfidential: pt!.isConfidential }, clearance.canSeeConfidential),
      uhid: restricted ? "" : pt!.uhid, restricted,
      ageYears: pt!.dob == null ? null : Math.floor((now.getTime() - pt!.dob.getTime()) / (365.2425 * DAY_MS)),
      sex: pt!.sex,
    },
    phases: phases.map((p) => ({ phase: p.phase as IrChecklistPhase, items: p.items, participants: p.participants, recordedByName: who(p.recordedBy), recordedAt: p.recordedAt })),
    coagulation: {
      ...coag,
      override: kase?.coagOverrideAt == null ? null : {
        verdict: kase.coagOverrideVerdict!, reason: kase.coagOverrideReason!, byName: who(kase.coagOverrideBy), at: kase.coagOverrideAt,
      },
    },
    sedation: {
      plan,
      vitals: vitals.map((v) => ({
        id: v.id, bpSystolic: v.bpSystolic, bpDiastolic: v.bpDiastolic, heartRate: v.heartRate, spo2: v.spo2,
        rass: v.rass, drug: v.drug, recordedByName: who(v.recordedBy), recordedAt: v.recordedAt,
      })),
      nextDueAt: clockRuns
        ? new Date(lastAt.getTime() + (AFTER.includes(study.status) ? IR_RECOVERY_VITALS_EVERY_MIN : IR_SEDATION_VITALS_EVERY_MIN) * 60_000)
        : null,
    },
    dose: { karMgy: kar, dapGyCm2: numOrNull(study.doseDap), fluoroSeconds: study.fluoroSeconds, levels: skinDoseLevels(kar) },
    skinFollowUp: kase?.skinFollowUpAt == null ? null : {
      on: kase.skinFollowUpOn!, note: kase.skinFollowUpNote, byName: who(kase.skinFollowUpBy), at: kase.skinFollowUpAt,
    },
    note: kase?.noteAt == null ? null : {
      procedure: kase.noteProcedure!, approach: kase.noteApproach, devices: kase.noteDevices, specimens: kase.noteSpecimens,
      complications: kase.noteComplications, bloodLossMl: kase.noteBloodLossMl, byName: who(kase.noteBy), at: kase.noteAt,
    },
    handoff: kase?.handoffAt == null ? null : { detail: kase.handoff as IrHandoffInput, byName: who(kase.handoffBy), at: kase.handoffAt },
    next: nextAct(study.status, new Set(phases.map((p) => p.phase)), kase?.noteAt ?? null, kase?.handoffAt ?? null),
    thresholds: IR_THRESHOLDS,
  };
}

export type IrListRow = {
  studyId: string; accessionNo: string; status: string; priority: string;
  studyTypeCode: string; studyTypeName: string; bleedingRisk: "low" | "high";
  scheduledAt: Date | null; deviceCode: string | null;
  patientId: string; patientName: string; restricted: boolean;
  phases: IrChecklistPhase[]; handedOff: boolean; lastVitalsAt: Date | null; next: IrNextAct;
};


/**
 * The suite's ONE list: every IR procedure booked, arrived or on the table, and every one sent in
 * the last 24 hours that has not yet been handed to recovery. STAT first, then the table, then by
 * slot. One `imaging.worklist` PHI row per patient disclosed.
 */
export async function irCaseList(db: Db, actor: Actor, now: Date = new Date()): Promise<IrListRow[]> {
  const clearance = await clearanceOf(db, actor);
  const types = (await activeStudyTypes(db)).filter((t) => t.interventional === true);
  if (types.length === 0) return [];
  const typeOf = new Map(types.map((t) => [t.code, t]));
  const rows = await db
    .select({
      study: imagingStudies, deviceCode: resources.code,
      name: patients.name, alias: patients.alias, isConfidential: patients.isConfidential,
    })
    .from(imagingStudies)
    .innerJoin(patients, eq(patients.id, imagingStudies.patientId))
    .leftJoin(resources, eq(resources.id, imagingStudies.deviceResourceId))
    .where(and(
      inArray(imagingStudies.studyTypeCode, [...typeOf.keys()]),
      or(
        inArray(imagingStudies.status, LIVE),
        and(inArray(imagingStudies.status, AFTER), gte(imagingStudies.acquiredAt, new Date(now.getTime() - DAY_MS))),
      ),
    ))
    .orderBy(desc(imagingStudies.priority), asc(imagingStudies.scheduledAt))
    .limit(200);
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.study.id);
  const phaseRows = await db.select({ studyId: imagingIrChecklists.studyId, phase: imagingIrChecklists.phase })
    .from(imagingIrChecklists).where(inArray(imagingIrChecklists.studyId, ids));
  const caseRows = await db.select({ studyId: imagingIrCases.studyId, noteAt: imagingIrCases.noteAt, handoffAt: imagingIrCases.handoffAt })
    .from(imagingIrCases).where(inArray(imagingIrCases.studyId, ids));
  const vitalRows = await db.select({ studyId: imagingIrSedationVitals.studyId, at: imagingIrSedationVitals.recordedAt })
    .from(imagingIrSedationVitals).where(inArray(imagingIrSedationVitals.studyId, ids));

  const rank: Record<string, number> = { in_acquisition: 0, ready: 1, checked_in: 2, scheduled: 3, acquired: 4, reported: 4, published: 4 };
  const out: IrListRow[] = [];
  for (const r of rows) {
    const s = r.study;
    const kase = caseRows.find((c) => c.studyId === s.id);
    if (AFTER.includes(s.status) && kase?.handoffAt != null) continue;
    const phases = phaseRows.filter((p) => p.studyId === s.id).map((p) => p.phase as IrChecklistPhase);
    const last = vitalRows.filter((v) => v.studyId === s.id).reduce<Date | null>((m, v) => (m === null || v.at > m ? v.at : m), null);
    const type = typeOf.get(s.studyTypeCode)!;
    out.push({
      studyId: s.id, accessionNo: s.accessionNo, status: s.status, priority: s.priority,
      studyTypeCode: s.studyTypeCode, studyTypeName: type.name, bleedingRisk: type.bleeding_risk ?? "low",
      scheduledAt: s.scheduledAt, deviceCode: r.deviceCode,
      patientId: s.patientId,
      patientName: displayName({ name: r.name, alias: r.alias, isConfidential: r.isConfidential }, clearance.canSeeConfidential),
      restricted: r.isConfidential && !clearance.canSeeConfidential,
      phases, handedOff: kase?.handoffAt != null, lastVitalsAt: last,
      next: nextAct(s.status, new Set(phases), kase?.noteAt ?? null, kase?.handoffAt ?? null),
    });
  }
  out.sort((a, b) => {
    if ((a.priority === "stat") !== (b.priority === "stat")) return a.priority === "stat" ? -1 : 1;
    const d = (rank[a.status] ?? 9) - (rank[b.status] ?? 9);
    if (d !== 0) return d;
    return (a.scheduledAt?.getTime() ?? 0) - (b.scheduledAt?.getTime() ?? 0);
  });
  const reason = `IR suite list, ${String(out.length)} rows`;
  for (const patientId of new Set(out.map((r) => r.patientId))) {
    await recordPhiAccess(db, { actor, patientId, surface: "imaging.worklist", reason });
  }
  return out;
}
