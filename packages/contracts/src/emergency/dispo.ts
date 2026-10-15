import { z } from "zod";
import { IpdBedClassSchema } from "../ipd-bed-classes";
import { ErIdSchema, ErInstantSchema, ErNoteSchema, ErUserRefSchema, ErWordsSchema, erInput, erIntent } from "./common";

/**
 * ER lane 5 (#812) — DISPOSITION (spec SPEC-emergency §3.10, §4.5). Every way out of the department ends the episode in
 * `departed` with an outcome, and every departure releases the bay to cleaning.
 *
 * - One disposition per episode, decided by a doctor with a reason (`decide_disposition`); the doctor's exit acts
 *   (discharge, hand to a unit, refer out) decide it in the same act when the patient is still `in_treatment`.
 * - Discharge needs the signed ER summary (diagnosis, treatment given, medicines, return-if signs shown in Hindi and
 *   English, follow-up). Hand to a unit raises the IPD admission (source `er`; the gate time and "stabilised" copied):
 *   with a bed it is admitted and the patient leaves the ER; without one the patient BOARDS on the ER board until IPD
 *   places a bed. Referral is never for money. LAMA needs the risks explained and a signature (or a witnessed refusal).
 *   Death needs the MCCD number (0018), unless the case is an MLC whose police intimation is recorded.
 *
 * No answer names money (decision 0058).
 */
const LongNoteSchema = z.string().trim().min(1).max(4000);

export const ER_DISPOSITIONS = ["discharge", "admit", "refer_out"] as const;
export type ErDisposition = (typeof ER_DISPOSITIONS)[number];

/** The return-if signs printed on the discharge summary — each has its English and Hindi words on the screen and print. */
export const ER_RETURN_IF_SIGNS = [
  "chest_pain", "breathlessness", "bleeding", "high_fever", "repeated_vomiting", "fits", "drowsiness", "worsening_pain",
  "wound_redness", "less_urine", "weakness_one_side", "severe_headache",
] as const;
export type ErReturnIfSign = (typeof ER_RETURN_IF_SIGNS)[number];

/** DECIDED (lane 5): why a patient is referred out. "Cannot pay" is refused — nobody is referred for money (spec §7). */
export const ER_REFERRAL_REASONS = [
  "higher_centre_care", "specialty_not_available", "bed_not_available", "equipment_not_available", "patient_choice", "cannot_pay",
] as const;

const MedicineSchema = z.strictObject({
  name: ErWordsSchema, dose: z.string().trim().min(1).max(60), frequency: z.string().trim().min(1).max(60),
  days: z.number().int().min(1).max(365).optional(),
});

export const decideDisposition = erIntent({
  input: erInput({ episodeId: ErIdSchema, disposition: z.enum(ER_DISPOSITIONS), reason: ErNoteSchema }),
  output: z.strictObject({ episodeId: ErIdSchema, state: z.literal("disposition_decided"), disposition: z.enum(ER_DISPOSITIONS) }),
  refusals: ["episode_not_found", "episode_wrong_state", "not_a_doctor", "disposition_already_decided"],
  actors: ["doctor"],
  copilotProposable: true,
  agentTier: "none",
  undo: "irreversible",
  events: ["er.disposition_decided"],
  idempotent: true,
});

const DepartureOut = z.strictObject({
  episodeId: ErIdSchema, state: z.literal("departed"), outcome: z.string(), departedAt: ErInstantSchema,
  /** The bay the patient left (to cleaning), or null when the patient was never in one. */
  bayReleased: z.string().nullable(),
});

export const dischargeFromEr = erIntent({
  input: erInput({
    episodeId: ErIdSchema,
    /** Required when the disposition is not decided yet (the act decides it). */
    reason: ErNoteSchema.optional(),
    summary: z.strictObject({
      diagnosis: LongNoteSchema,
      treatmentGiven: LongNoteSchema,
      medicines: z.array(MedicineSchema).max(30),
      returnIf: z.array(z.enum(ER_RETURN_IF_SIGNS)).min(1).max(ER_RETURN_IF_SIGNS.length),
      returnIfNote: ErNoteSchema.optional(),
      followUp: z.strictObject({ department: z.string().trim().min(1).max(16), onDate: z.iso.date() }).optional(),
    }),
  }),
  output: DepartureOut,
  refusals: ["episode_not_found", "episode_wrong_state", "not_a_doctor", "disposition_mismatch", "disposition_reason_needed"],
  actors: ["doctor"],
  copilotProposable: true,
  agentTier: "none",
  undo: "irreversible",
  events: ["er.departed"],
  idempotent: true,
});

export const handToUnit = erIntent({
  input: erInput({
    episodeId: ErIdSchema,
    reason: ErNoteSchema.optional(),
    consultantId: ErUserRefSchema,
    department: z.string().trim().min(1).max(16).optional(),
    requestedClass: IpdBedClassSchema,
    isolation: z.enum(["none", "contact", "droplet", "airborne"]).default("none"),
    provisionalDiagnosis: ErNoteSchema,
    /** A bed the admission desk has already found: admitted now and the patient leaves the ER. Absent → the patient boards. */
    bedId: ErIdSchema.optional(),
  }),
  output: z.strictObject({
    episodeId: ErIdSchema, admissionId: ErIdSchema, admissionNo: z.string().nullable(),
    /** True while the patient waits on the ER board for the IPD bed (the episode stays open). */
    boarding: z.boolean(),
    state: z.enum(["disposition_decided", "departed"]),
  }),
  refusals: [
    "episode_not_found", "episode_wrong_state", "not_a_doctor", "disposition_mismatch", "disposition_reason_needed",
    "admission_refused", "already_boarding",
  ],
  actors: ["doctor"],
  copilotProposable: true,
  agentTier: "none",
  undo: "irreversible",
  events: ["er.handed_to_unit", "er.departed"],
  idempotent: true,
});

export const referOut = erIntent({
  input: erInput({
    episodeId: ErIdSchema,
    reason: z.enum(ER_REFERRAL_REASONS),
    facility: ErWordsSchema,
    /** The referral note: the clinical summary sent with the patient. */
    note: LongNoteSchema,
    escort: z.enum(["doctor", "nurse", "paramedic", "family"]),
    transport: z.enum(["own_ambulance", "ambulance_108", "private_vehicle", "other"]),
  }),
  output: DepartureOut,
  refusals: ["episode_not_found", "episode_wrong_state", "not_a_doctor", "disposition_mismatch", "referral_not_for_money"],
  actors: ["doctor"],
  copilotProposable: true,
  agentTier: "none",
  undo: "irreversible",
  events: ["er.departed"],
  idempotent: true,
});

/** Leaving against medical advice: the risks explained, and the patient's (or representative's) signature — or a witnessed refusal to sign. */
export const recordLama = erIntent({
  input: erInput({
    episodeId: ErIdSchema,
    risksExplained: LongNoteSchema,
    signer: z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("patient"), name: ErWordsSchema }),
      z.strictObject({ kind: z.literal("representative"), name: ErWordsSchema, relation: z.string().trim().min(1).max(40) }),
      z.strictObject({ kind: z.literal("refused_to_sign"), witnessId: ErUserRefSchema }),
    ]),
    /** The family insists on going elsewhere against advice: the facility goes on the form (spec §4.5). */
    goingTo: ErWordsSchema.optional(),
  }),
  output: DepartureOut,
  refusals: ["episode_not_found", "episode_wrong_state", "not_a_doctor", "lama_witness_needed"],
  actors: ["doctor", "duty_manager"],
  copilotProposable: false,
  agentTier: "none",
  undo: "irreversible",
  events: ["er.departed"],
  idempotent: true,
});

/** Left without being seen (before a doctor): the time the patient was last seen. */
export const recordLwbs = erIntent({
  input: erInput({ episodeId: ErIdSchema, lastSeenAt: ErInstantSchema, note: ErNoteSchema.optional() }),
  output: DepartureOut,
  refusals: ["episode_not_found", "episode_wrong_state", "time_in_future", "last_seen_before_arrival"],
  actors: ["er_nurse", "doctor", "desk"],
  copilotProposable: false,
  agentTier: "none",
  undo: "irreversible",
  events: ["er.departed"],
  idempotent: true,
});

/** Absconded during care: security is alerted; an MLC patient's absconding is for the police (the duty manager is told). */
export const recordAbscond = erIntent({
  input: erInput({ episodeId: ErIdSchema, lastSeenAt: ErInstantSchema, searched: z.boolean(), note: ErNoteSchema.optional() }),
  output: DepartureOut.extend({ securityAlerted: z.number().int().nonnegative(), policeToBeInformed: z.boolean() }),
  refusals: ["episode_not_found", "episode_wrong_state", "time_in_future", "last_seen_before_arrival"],
  actors: ["er_nurse", "doctor", "duty_manager"],
  copilotProposable: false,
  agentTier: "none",
  undo: "irreversible",
  events: ["er.departed"],
  idempotent: true,
});

/**
 * Death in the ER (after arrival — a body brought dead is lane 1's marker). The MCCD number is required (0018); an MLC
 * whose police intimation is recorded may go without it (the post-mortem decides the cause). The body goes to the mortuary
 * register through lane 4's seam.
 */
export const recordErDeath = erIntent({
  input: erInput({ episodeId: ErIdSchema, diedAt: ErInstantSchema, mccdNo: z.string().trim().min(1).max(40).optional(), note: ErNoteSchema.optional() }),
  output: DepartureOut.extend({ mortuaryEntryId: ErIdSchema, mlc: z.boolean() }),
  refusals: ["episode_not_found", "episode_wrong_state", "not_a_doctor", "time_in_future", "died_before_arrival", "mccd_required"],
  actors: ["doctor"],
  copilotProposable: false,
  agentTier: "none",
  undo: "irreversible",
  events: ["er.departed"],
  idempotent: true,
});
