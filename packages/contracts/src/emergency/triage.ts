import { z } from "zod";
import { IPD_CONSCIOUSNESS, IPD_EWS_BANDS, IPD_EWS_KINDS } from "../ipd/ews";
import { ErIdSchema, ErInstantSchema, ErNoteSchema, ErUserRefSchema, erInput, erIntent } from "./common";

/**
 * ER lane 2 (#809) — TRIAGE: ESI v4, the re-triage clock, vitals with the IPD early-warning score beside the level, bays
 * from the bed registry, and the doctor who sees the patient (spec SPEC-emergency §3.1–§3.3, §4.2).
 *
 * The ESI level is the PERSON's choice. The four decision points (needs a life-saving intervention? high risk, confused
 * or in severe pain? how many resources? danger-zone vitals?) give the algorithm's level, shown as a proposal with its
 * reasons; a level LESS urgent than that proposal, or than the patient's last level, needs a reason in words. An
 * up-triage never does (§6 edge 2).
 */
export const ER_ESI_LEVELS = [1, 2, 3, 4, 5] as const;
export type ErEsiLevel = (typeof ER_ESI_LEVELS)[number];
export const ErEsiLevelSchema = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]);

/**
 * Every level is a colour AND a word AND a number (never colour alone, spec §3.1). `retriageMin`: re-triage interval
 * until a doctor has seen the patient (ESI 1 is in resus, continuously watched: none). `doctorWithinMin`: the
 * door-to-doctor target from the gate (§3.2). `doorColour` is the Doctor Desk export's three-colour map (E3).
 */
export const ER_ESI_INFO: Record<ErEsiLevel, { word: string; colour: "red" | "orange" | "yellow" | "green" | "blue"; retriageMin: number | null; doctorWithinMin: number; deskColour: "red" | "yellow" | "green" }> = {
  1: { word: "Resuscitation", colour: "red", retriageMin: null, doctorWithinMin: 0, deskColour: "red" },
  2: { word: "Emergent", colour: "orange", retriageMin: 15, doctorWithinMin: 10, deskColour: "red" },
  3: { word: "Urgent", colour: "yellow", retriageMin: 30, doctorWithinMin: 30, deskColour: "yellow" },
  4: { word: "Less urgent", colour: "green", retriageMin: 60, doctorWithinMin: 60, deskColour: "green" },
  5: { word: "Non-urgent", colour: "blue", retriageMin: 120, doctorWithinMin: 120, deskColour: "green" },
};

/** An overdue re-triage becomes a task at once; unanswered this long after it was due, it climbs (spec §4.2 edge). */
export const ER_RETRIAGE_CLIMB_MIN = 15;

export const ER_ESI_RESOURCES = ["none", "one", "many"] as const;
export const ErEsiDecisionSchema = z.strictObject({
  /** A: needs an immediate life-saving intervention (airway, CPR, defibrillation, emergency drugs). */
  lifeSaving: z.boolean(),
  /** B: high-risk situation, new confusion or lethargy, or severe pain or distress. */
  highRisk: z.boolean(),
  /** C: how many different resources the ER will spend (labs, imaging, IV fluids, a consult, a procedure). */
  resources: z.enum(ER_ESI_RESOURCES),
  /** D: danger-zone vitals for the age (with C = many, the algorithm considers ESI 2). */
  dangerVitals: z.boolean(),
});
export type ErEsiDecision = z.infer<typeof ErEsiDecisionSchema>;

/** The ESI v4 algorithm's level from the four decision points, with the reason in words. Pure. */
export function esiAlgorithm(d: ErEsiDecision): { level: ErEsiLevel; reason: string } {
  if (d.lifeSaving) return { level: 1, reason: "Needs a life-saving intervention now" };
  if (d.highRisk) return { level: 2, reason: "High risk, confused, or in severe pain" };
  if (d.resources === "many") {
    return d.dangerVitals ? { level: 2, reason: "Many resources and danger-zone vitals" } : { level: 3, reason: "Needs many resources" };
  }
  if (d.resources === "one") return { level: 4, reason: "Needs one resource" };
  return { level: 5, reason: "Needs no resources" };
}

/** A level is a DOWN-triage when it is less urgent (a higher number) than the one it is compared with. */
export const isDownTriage = (chosen: ErEsiLevel, than: ErEsiLevel | null): boolean => than !== null && chosen > than;

/** One vital-sign set, in the OPD vitals desk's units; any subset. Scored by the IPD early-warning export. */
export const ErVitalsSchema = z.strictObject({
  temperatureC: z.number().min(25).max(45).optional(),
  pulse: z.number().int().min(0).max(300).optional(),
  respRate: z.number().int().min(0).max(80).optional(),
  systolic: z.number().int().min(0).max(300).optional(),
  diastolic: z.number().int().min(0).max(200).optional(),
  spo2: z.number().int().min(0).max(100).optional(),
  onOxygen: z.boolean().optional(),
  consciousness: z.enum(IPD_CONSCIOUSNESS).optional(),
  capRefillSec: z.number().min(0).max(20).optional(),
});
export type ErVitals = z.infer<typeof ErVitalsSchema>;
export const ErEwsSchema = z.strictObject({ kind: z.enum(IPD_EWS_KINDS), value: z.number().int(), band: z.enum(IPD_EWS_BANDS) });
export type ErEws = z.infer<typeof ErEwsSchema>;

/** The take: which unit of the specialty was on take at the GATE instant (seam E2), not at the registration. */
const TakeOutput = z.strictObject({ departmentCode: z.string(), teamId: z.string().nullable(), source: z.enum(["published", "none"]) }).nullable();

const triageShape = {
  episodeId: ErIdSchema,
  /** The four ESI decision points; absent on a re-triage that only re-states the level. */
  decision: ErEsiDecisionSchema.optional(),
  level: ErEsiLevelSchema,
  /** Required (by the intent) when the level is less urgent than the algorithm's or the last one. */
  reason: ErNoteSchema.optional(),
  vitals: ErVitalsSchema.optional(),
  /** Pregnant or up to 42 days after delivery: MEOWS instead of NEWS2. */
  obstetric: z.boolean().optional(),
  /**
   * Lane 9 (#816): the level the copilot's ESI proposal showed on the screen, when one was shown. Kept on the entry so a
   * pick other than the proposal is logged as an override (spec §6 edge 2); it never asks for a reason by itself.
   */
  copilotLevel: ErEsiLevelSchema.optional(),
};

const TriageOutput = z.strictObject({
  episodeId: ErIdSchema,
  level: ErEsiLevelSchema,
  algorithmLevel: ErEsiLevelSchema.nullable(),
  downTriage: z.boolean(),
  retriageDueAt: ErInstantSchema.nullable(),
  doctorDueAt: ErInstantSchema,
  ews: ErEwsSchema.nullable(),
  take: TakeOutput,
});

export const triage = erIntent({
  input: erInput({
    ...triageShape,
    decision: ErEsiDecisionSchema,
    /** The specialty the complaint belongs to (OPD department code: MED, SUR, ORT, OBG, PAED…), for the take unit. */
    departmentCode: z.string().trim().min(2).max(16).optional(),
  }),
  output: TriageOutput,
  refusals: ["episode_not_found", "episode_wrong_state", "down_triage_needs_reason", "department_not_found", "state_changed"],
  actors: ["er_nurse", "doctor"],
  copilotProposable: true,
  agentTier: "none",
  undo: "entered_in_error",
  events: ["er.triaged"],
  idempotent: true,
});

export const reTriage = erIntent({
  input: erInput(triageShape),
  output: TriageOutput,
  refusals: ["episode_not_found", "episode_wrong_state", "down_triage_needs_reason", "state_changed"],
  actors: ["er_nurse", "doctor"],
  copilotProposable: true,
  agentTier: "none",
  undo: "entered_in_error",
  events: ["er.retriaged"],
  idempotent: true,
});

/** A vital-sign set between triages. A WORSE early-warning band than the last re-triages at once (spec §3.2). */
export const recordErVitals = erIntent({
  input: erInput({
    episodeId: ErIdSchema,
    // An empty set has nothing to score: a malformed body, not a 500 inside the intent.
    vitals: ErVitalsSchema.refine((v) => Object.keys(v).length > 0, { message: "at least one vital sign" }),
    obstetric: z.boolean().optional(), takenAt: ErInstantSchema.optional() }),
  output: z.strictObject({ episodeId: ErIdSchema, ews: ErEwsSchema, worse: z.boolean(), retriageDueAt: ErInstantSchema.nullable() }),
  refusals: ["episode_not_found", "episode_wrong_state", "time_in_future"],
  actors: ["er_nurse", "doctor", "device"],
  copilotProposable: false,
  agentTier: "none",
  undo: "entered_in_error",
  events: ["er.vitals_recorded"],
  idempotent: true,
});

/** Bays are emergency-class beds of the bed registry (§3.3), placed through the IPD bed export under the same lock. */
export const placeInBay = erIntent({
  input: erInput({ episodeId: ErIdSchema, bedId: ErIdSchema }),
  output: z.strictObject({ episodeId: ErIdSchema, bedId: ErIdSchema, bayCode: z.string() }),
  refusals: ["episode_not_found", "episode_wrong_state", "already_in_bay", "bay_not_found", "bay_not_emergency", "bay_not_available"],
  actors: ["er_nurse", "doctor"],
  copilotProposable: true,
  agentTier: "none",
  undo: "reversal_line",
  events: ["er.placed"],
  idempotent: true,
});

export const moveBay = erIntent({
  input: erInput({ episodeId: ErIdSchema, bedId: ErIdSchema, reason: ErNoteSchema.optional() }),
  output: z.strictObject({ episodeId: ErIdSchema, bedId: ErIdSchema, bayCode: z.string(), fromBedId: ErIdSchema }),
  refusals: ["episode_not_found", "episode_wrong_state", "not_in_bay", "same_bay", "bay_not_found", "bay_not_emergency", "bay_not_available"],
  actors: ["er_nurse", "doctor"],
  copilotProposable: true,
  agentTier: "none",
  undo: "reversal_line",
  events: ["er.moved"],
  idempotent: true,
});

/**
 * The ER doctor of record. The first assignment is "seen by a doctor": the door-to-doctor clock stops and the re-triage
 * clock with it (`arrived | triaged → in_treatment`); a later one hands the patient to another doctor.
 */
export const assignErDoctor = erIntent({
  input: erInput({ episodeId: ErIdSchema, doctorId: ErUserRefSchema }),
  output: z.strictObject({ episodeId: ErIdSchema, doctorId: ErUserRefSchema, seenAt: ErInstantSchema, state: z.literal("in_treatment") }),
  refusals: ["episode_not_found", "episode_wrong_state", "not_a_doctor", "state_changed"],
  actors: ["er_nurse", "doctor"],
  copilotProposable: true,
  agentTier: "none",
  undo: "reversal_line",
  events: ["er.doctor_assigned"],
  idempotent: true,
});
