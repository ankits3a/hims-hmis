import { z } from "zod";
import { ErIdSchema, ErInstantSchema, ErNoteSchema, ErUserRefSchema, ErWordsSchema, erInput, erIntent } from "./common";

/**
 * ER lane 7 (#814) — CODES AND ACTIVATIONS (spec SPEC-emergency §3.9, §4.7, §5 F; NABH names).
 *
 * - `call_code` pages the roster's team for that code at once (a bell row per person, relayed to their phones — the phone's
 *   lock screen carries no patient text at all, platform rule M6b) and starts the record. Code Blue (arrest) and Code Grey
 *   (violence against staff) may be called anywhere, on a patient or not; the clinical activations — STEMI, stroke,
 *   trauma, sepsis, snakebite, obstetric — are called on an ER episode.
 * - The resuscitation record is a timed, append-only event log tapped by the scribe (CPR start / pause, rhythm, shock with
 *   joules, drug and dose, airway, ROSC, time of death, a milestone, a note); a paper code sheet is back-filled, flagged.
 * - Activation clocks run from the DOOR (the ER gate time), not the activation — except snakebite's ASV, which runs from
 *   the decision (the activation), as the spec states. `end_code` needs the team leader (a doctor) and an outcome; the
 *   debrief is recorded after.
 * - Code Grey: security paged with the location (only security sees it), an incident report drafted.
 */
export const ER_CODE_KINDS = ["code_blue", "code_grey", "stemi", "stroke", "trauma", "sepsis", "snakebite", "obstetric"] as const;
export type ErCodeKind = (typeof ER_CODE_KINDS)[number];
/** The codes that need no patient (anywhere in the hospital). */
export const ER_CODE_ANYWHERE: readonly ErCodeKind[] = ["code_blue", "code_grey"];

/** An activation's clock: a milestone, its target in minutes, and what the clock runs from. */
export type ErCodeClockDef = { milestone: string; targetMin: number; from: "door" | "activation" };
export const ER_CODE_CLOCKS: Record<ErCodeKind, readonly ErCodeClockDef[]> = {
  code_blue: [],
  code_grey: [],
  stemi: [{ milestone: "ecg", targetMin: 10, from: "door" }, { milestone: "balloon", targetMin: 90, from: "door" }],
  stroke: [{ milestone: "ct", targetMin: 25, from: "door" }, { milestone: "needle", targetMin: 60, from: "door" }],
  trauma: [{ milestone: "primary_survey", targetMin: 10, from: "door" }, { milestone: "ct", targetMin: 60, from: "door" }],
  sepsis: [{ milestone: "antibiotics", targetMin: 60, from: "door" }],
  snakebite: [{ milestone: "asv", targetMin: 30, from: "activation" }],
  obstetric: [{ milestone: "lr_handover", targetMin: 15, from: "activation" }],
};
/** DECIDED (lane 7): who a code pages — the department on take through the roster's call-out list, else this role. */
export const ER_CODE_TEAM: Record<ErCodeKind, { departmentCode: string | null; fallbackRole: string }> = {
  code_blue: { departmentCode: "ANAES", fallbackRole: "anaesthetist" },
  code_grey: { departmentCode: null, fallbackRole: "security_guard" },
  stemi: { departmentCode: "CARD", fallbackRole: "doctor" },
  stroke: { departmentCode: "NEURO", fallbackRole: "doctor" },
  trauma: { departmentCode: "SUR", fallbackRole: "surgeon" },
  sepsis: { departmentCode: "MED", fallbackRole: "doctor" },
  snakebite: { departmentCode: "MED", fallbackRole: "doctor" },
  obstetric: { departmentCode: "OBG", fallbackRole: "doctor" },
};

export const ER_CODE_EVENT_KINDS = [
  "cpr_start", "cpr_pause", "rhythm", "shock", "drug", "airway", "rosc", "death", "milestone", "location", "note",
] as const;
export const ER_RHYTHMS = ["vf", "pulseless_vt", "pea", "asystole", "sinus", "brady", "svt", "af", "other"] as const;
export const ER_CODE_OUTCOMES = ["rosc", "died", "stood_down", "transferred", "resolved"] as const;

export const callCode = erIntent({
  input: erInput({
    kind: z.enum(ER_CODE_KINDS),
    episodeId: ErIdSchema.optional(),
    /** Where: an ER bay (a bed id), or words ("Ward 4 corridor", "OPD 2 waiting"). */
    bayId: ErIdSchema.optional(),
    place: ErWordsSchema.optional(),
    note: ErNoteSchema.optional(),
  }).refine((i) => i.bayId !== undefined || i.place !== undefined || i.episodeId !== undefined, { message: "a code names where", path: ["place"] }),
  output: z.strictObject({
    codeId: ErIdSchema, kind: z.enum(ER_CODE_KINDS), calledAt: ErInstantSchema, paged: z.number().int().nonnegative(),
    clocks: z.array(z.object({ milestone: z.string(), dueAt: ErInstantSchema })),
  }),
  refusals: ["episode_not_found", "episode_wrong_state", "code_needs_patient", "code_open", "bay_not_found"],
  actors: ["desk", "er_nurse", "doctor", "duty_manager"],
  copilotProposable: false,
  agentTier: "none",
  undo: "irreversible",
  events: ["er.code_called"],
  idempotent: true,
});

export const recordCodeEvent = erIntent({
  input: erInput({
    codeId: ErIdSchema,
    kind: z.enum(ER_CODE_EVENT_KINDS),
    rhythm: z.enum(ER_RHYTHMS).optional(),
    joules: z.number().int().min(1).max(400).optional(),
    drug: ErWordsSchema.optional(),
    dose: z.string().trim().min(1).max(60).optional(),
    milestone: z.string().trim().min(1).max(40).optional(),
    place: ErWordsSchema.optional(),
    note: ErNoteSchema.optional(),
    /** A paper code sheet back-filled after the tablet was offline: the time on the sheet, flagged. */
    at: ErInstantSchema.optional(),
    fromPaper: z.boolean().optional(),
  }).refine((i) => (i.kind !== "rhythm" || i.rhythm !== undefined) && (i.kind !== "shock" || i.joules !== undefined)
    && (i.kind !== "drug" || (i.drug !== undefined && i.dose !== undefined)) && (i.kind !== "milestone" || i.milestone !== undefined)
    && (i.kind !== "location" || i.place !== undefined), { message: "the event kind's own detail is required" }),
  output: z.strictObject({ eventId: ErIdSchema, at: ErInstantSchema, scribeId: ErUserRefSchema }),
  refusals: ["code_not_found", "code_ended", "time_in_future", "milestone_unknown", "event_before_arrival"],
  actors: ["er_nurse", "doctor"],
  copilotProposable: false,
  agentTier: "none",
  undo: "irreversible",
  events: ["er.code_event"],
  idempotent: true,
});

export const endCode = erIntent({
  input: erInput({ codeId: ErIdSchema, outcome: z.enum(ER_CODE_OUTCOMES), note: ErNoteSchema.optional() }),
  output: z.strictObject({ codeId: ErIdSchema, endedAt: ErInstantSchema, durationSec: z.number().int().nonnegative(), leaderId: ErUserRefSchema }),
  refusals: ["code_not_found", "code_ended", "not_a_doctor"],
  actors: ["doctor"],
  copilotProposable: false,
  agentTier: "none",
  undo: "irreversible",
  events: ["er.code_ended"],
  idempotent: true,
});

export const recordCodeDebrief = erIntent({
  input: erInput({
    codeId: ErIdSchema, wentWell: ErNoteSchema, improve: ErNoteSchema, actions: z.array(ErNoteSchema).max(10).optional(),
  }),
  output: z.strictObject({ codeId: ErIdSchema, at: ErInstantSchema }),
  refusals: ["code_not_found", "code_not_ended", "debrief_recorded", "not_code_leader"],
  actors: ["doctor"],
  copilotProposable: true,
  agentTier: "none",
  undo: "irreversible",
  events: ["er.code_debriefed"],
  idempotent: true,
});

// ═══════════════════════════════════════ reads: the scribe tablet and the board ═══════════════════════════════════════

export const ErCodeClockSchema = z.object({
  milestone: z.string(), targetMin: z.number().int(), from: z.enum(["door", "activation"]), dueAt: ErInstantSchema,
  metAt: ErInstantSchema.nullable(),
});
export const ErCodeEventSchema = z.object({
  eventId: ErIdSchema, kind: z.enum(ER_CODE_EVENT_KINDS), words: z.string(), at: ErInstantSchema, by: z.string(), fromPaper: z.boolean(),
});
export const ErCodeViewSchema = z.object({
  codeId: ErIdSchema, kind: z.enum(ER_CODE_KINDS), episodeId: ErIdSchema.nullable(), episodeNo: z.string().nullable(),
  /** The patient's name or alias — on the scribe tablet only (never on a page or a lock screen). */
  patientLabel: z.string().nullable(),
  where: z.string(), calledAt: ErInstantSchema, doorAt: ErInstantSchema.nullable(), endedAt: ErInstantSchema.nullable(),
  outcome: z.string().nullable(), team: z.array(z.object({ userId: z.string(), name: z.string() })),
  scribe: z.string().nullable(), leader: z.string().nullable(), clocks: z.array(ErCodeClockSchema), events: z.array(ErCodeEventSchema),
  debriefed: z.boolean(), backfilled: z.boolean(),
});
export type ErCodeView = z.infer<typeof ErCodeViewSchema>;
export const ErCodesSchema = z.object({ active: z.array(ErCodeViewSchema), recent: z.array(ErCodeViewSchema), serverNow: ErInstantSchema });
export type ErCodes = z.infer<typeof ErCodesSchema>;
