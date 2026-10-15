import { z } from "zod";
import { ErIdSchema, ErInstantSchema, ErNoteSchema, ErUserRefSchema, ErWordsSchema, erInput, erIntent } from "./common";

/**
 * ER lane 4 (#811) — THE MEDICO-LEGAL CASE (spec SPEC-emergency §3.7, §3.8, §4.4).
 *
 * The ER doctor opens the MLC; it NEVER delays treatment (no clinical intent reads it). Serial from the MLC register
 * (`MLC26-000123`). Police intimation is an OBLIGATION due 1 hour after opening (a task, then a climb); the faculty
 * countersign is an obligation due in 24 hours (still owed if the patient dies first). An MLC is never deleted and never
 * edited — a correction is an ADDENDUM. Belongings are listed and signed by two staff; evidence moves on a chain of custody.
 * An unidentified patient and a body brought dead are MLC by default (opened by rule at arrival).
 */
export const ER_MLC_CATEGORIES = [
  "assault", "road_accident", "burns", "acid_attack", "poisoning", "hanging", "drowning", "fall_from_height", "bite_dispute",
  "unknown_unconscious", "sexual_assault", "brought_dead", "death_within_24h_injury", "police_brought", "other",
] as const;
export type ErMlcCategory = (typeof ER_MLC_CATEGORIES)[number];
/** BNSS s.397: victims of these are treated free by law — lane 6's bill desk cannot raise a patient-payable line. */
export const ER_MLC_FREE_BY_LAW: readonly ErMlcCategory[] = ["sexual_assault", "acid_attack"];
/** Police intimation target, and the faculty countersign obligation (spec §3.7). */
export const ER_MLC_INTIMATION_MIN = 60;
export const ER_MLC_COUNTERSIGN_MIN = 24 * 60;
/** DECIDED (lane 4): an MLC opened more than 6 hours after the gate, or after the patient left the ER, is flagged late. */
export const ER_MLC_LATE_MIN = 6 * 60;

const InjurySchema = z.strictObject({
  site: ErWordsSchema,
  kind: z.enum(["abrasion", "laceration", "contusion", "incised", "stab", "burn", "fracture", "firearm", "bite", "ligature_mark", "other"]),
  sizeCm: z.string().trim().min(1).max(40).optional(),
  description: ErNoteSchema.optional(),
});
const InformantSchema = z.strictObject({
  name: ErWordsSchema, relation: z.string().trim().min(1).max(40), phone: z.string().regex(/^[6-9]\d{9}$/).optional(),
  /** What happened, in the informant's own words (spec §4.4) — never paraphrased. */
  words: z.string().trim().min(1).max(2000),
});
const SecondPersonSchema = z.strictObject({ username: z.string().trim().min(1).max(64), pin: z.string().regex(/^\d{4,6}$/) });

export const openMlc = erIntent({
  input: erInput({
    episodeId: ErIdSchema,
    category: z.enum(ER_MLC_CATEGORIES),
    informant: InformantSchema.optional(),
    injuries: z.array(InjurySchema).max(40).optional(),
    /** Sexual assault of a child: the POCSO mandatory report is recorded with the MLC. */
    pocso: z.boolean().optional(),
  }),
  output: z.strictObject({
    mlcId: ErIdSchema, mlcNo: z.string(), late: z.boolean(), intimationDueAt: ErInstantSchema, countersignDueAt: ErInstantSchema,
  }),
  refusals: ["episode_not_found", "not_a_doctor", "mlc_already_open"],
  actors: ["doctor"],
  copilotProposable: true,
  agentTier: "none",
  undo: "irreversible",
  events: ["er.mlc_opened"],
  idempotent: true,
});

/**
 * An addendum is the ONLY way to change an MLC (spec §4.4): the original row is immutable (a database trigger refuses an
 * UPDATE or DELETE); the read shows the original and every addendum in order, the latest category winning.
 */
export const addMlcAddendum = erIntent({
  input: erInput({
    mlcId: ErIdSchema,
    text: z.string().trim().min(1).max(4000),
    injuries: z.array(InjurySchema).max(40).optional(),
    /** The doctor decides the category, not the family (spec §4.4): a correction names the new one; the original stays. */
    category: z.enum(ER_MLC_CATEGORIES).optional(),
    /** The patient refused examination: recorded, and treatment continues (spec §4.4). */
    examinationRefused: z.boolean().optional(),
  }),
  output: z.strictObject({ addendumId: ErIdSchema, at: ErInstantSchema }),
  refusals: ["mlc_not_found", "not_a_doctor"],
  actors: ["doctor"],
  copilotProposable: false,
  agentTier: "none",
  undo: "irreversible",
  events: ["er.mlc_addendum"],
  idempotent: true,
});

/** Written intimation to the police post or station, the receiving officer named (spec §3.7: within 1 hour, target). */
export const recordPoliceIntimation = erIntent({
  input: erInput({
    mlcId: ErIdSchema,
    mode: z.enum(["written", "phone_then_written", "police_present"]),
    station: ErWordsSchema,
    receiverName: ErWordsSchema,
    receiverRank: z.string().trim().min(1).max(40).optional(),
    gdEntryNo: z.string().trim().min(1).max(40).optional(),
    intimatedAt: ErInstantSchema.optional(),
  }),
  output: z.strictObject({ intimationId: ErIdSchema, intimatedAt: ErInstantSchema, withinTarget: z.boolean() }),
  refusals: ["mlc_not_found", "time_in_future", "intimation_recorded", "intimation_before_arrival"],
  actors: ["desk", "er_nurse", "doctor", "duty_manager"],
  copilotProposable: false,
  agentTier: "none",
  undo: "irreversible",
  events: ["er.police_intimated"],
  idempotent: true,
});

/** The faculty countersign (a senior: a doctor who is not a resident), owed even if the patient has died. */
export const countersignMlc = erIntent({
  input: erInput({ mlcId: ErIdSchema }),
  output: z.strictObject({ mlcId: ErIdSchema, countersignedAt: ErInstantSchema, withinTarget: z.boolean() }),
  refusals: ["mlc_not_found", "mlc_countersigned", "cosigner_not_senior", "countersign_own_mlc"],
  actors: ["doctor"],
  copilotProposable: false,
  agentTier: "none",
  undo: "irreversible",
  events: ["er.mlc_countersigned"],
  idempotent: true,
});

/** The belongings list, signed by two staff (the recorder and a second person's PIN). */
export const recordBelongings = erIntent({
  input: erInput({
    mlcId: ErIdSchema,
    items: z.array(z.strictObject({ description: ErWordsSchema, qty: z.number().int().min(1).max(999) })).min(1).max(60),
    secondPerson: SecondPersonSchema,
    /** Where they are now: the hospital's locker (with its number), or handed to a named relative or officer. */
    keptIn: z.strictObject({ kind: z.enum(["locker", "relative", "police"]), ref: ErWordsSchema }),
  }),
  output: z.strictObject({ custodyId: ErIdSchema, witnessedBy: ErUserRefSchema }),
  refusals: ["mlc_not_found", "second_check_failed", "second_checker_same"],
  actors: ["desk", "er_nurse", "doctor", "duty_manager"],
  copilotProposable: false,
  agentTier: "none",
  undo: "irreversible",
  events: ["er.belongings_recorded"],
  idempotent: true,
});

/** One link of the evidence chain of custody: collected and sealed, stored, or handed over against a named receiver. */
export const handOverEvidence = erIntent({
  input: erInput({
    mlcId: ErIdSchema,
    kind: z.enum(["clothes", "swab", "blood_sample", "projectile", "weapon", "viscera", "other"]),
    description: ErWordsSchema,
    sealNo: z.string().trim().min(1).max(40),
    action: z.enum(["collected", "stored", "handed_over"]),
    /** Handed over: the receiving officer (name, rank, station) — a written requisition's officer. */
    receiver: z.strictObject({ name: ErWordsSchema, rank: z.string().trim().min(1).max(40), station: ErWordsSchema }).optional(),
    secondPerson: SecondPersonSchema,
  }).refine((i) => (i.action === "handed_over") === (i.receiver !== undefined), { message: "a hand-over names its receiver, and only a hand-over", path: ["receiver"] }),
  output: z.strictObject({ custodyId: ErIdSchema, link: z.number().int().positive() }),
  refusals: ["mlc_not_found", "second_check_failed", "second_checker_same", "seal_not_collected", "seal_already_collected", "seal_already_handed_over"],
  actors: ["doctor", "er_nurse", "duty_manager"],
  copilotProposable: false,
  agentTier: "none",
  undo: "irreversible",
  events: ["er.evidence_custody"],
  idempotent: true,
});

// ═══════════════════════════════════════ the MLC desk (reads) ═══════════════════════════════════════

/** One obligation's clock: due, met (or not), breached (past due and unmet, or met late). */
export const ErMlcClockSchema = z.object({
  dueAt: ErInstantSchema,
  metAt: ErInstantSchema.nullable(),
  /** Past due without being met (now), or met after the due instant. */
  breached: z.boolean(),
});
export type ErMlcClock = z.infer<typeof ErMlcClockSchema>;

/** One MLC on the MLC desk (spec §5 E): the owed intimation and countersign with their clocks. No money (0058). */
export const ErMlcRowSchema = z.object({
  mlcId: ErIdSchema,
  mlcNo: z.string(),
  episodeId: ErIdSchema,
  episodeNo: z.string(),
  patientId: ErIdSchema,
  /** The name, or the alias of an unidentified patient (a restricted record shows its alias). */
  patientLabel: z.string(),
  uhid: z.string(),
  category: z.enum(ER_MLC_CATEGORIES),
  openedAt: ErInstantSchema,
  /** Opened by rule at arrival (an unidentified patient, a body brought dead) rather than by a doctor. */
  openedByRule: z.boolean(),
  late: z.boolean(),
  freeByLaw: z.boolean(),
  pocso: z.boolean(),
  episodeState: z.string(),
  intimation: ErMlcClockSchema,
  countersign: ErMlcClockSchema,
});
export type ErMlcRow = z.infer<typeof ErMlcRowSchema>;

export const ErMlcDeskSchema = z.object({
  /** MLCs with an obligation still owed, the oldest due first. */
  owed: z.array(ErMlcRowSchema),
  /** MLCs opened in the last 7 days with nothing owed, the latest first. */
  recent: z.array(ErMlcRowSchema),
  serverNow: ErInstantSchema,
});
export type ErMlcDesk = z.infer<typeof ErMlcDeskSchema>;

const UserNameSchema = z.object({ userId: ErUserRefSchema, name: z.string() });
export const ErMlcDetailSchema = ErMlcRowSchema.extend({
  openedBy: UserNameSchema,
  informant: InformantSchema.nullable(),
  injuries: z.array(InjurySchema),
  /** The category the MLC was opened with (a later addendum may have changed `category`). */
  originalCategory: z.enum(ER_MLC_CATEGORIES),
  addenda: z.array(z.object({
    addendumId: ErIdSchema, text: z.string(), category: z.enum(ER_MLC_CATEGORIES).nullable(), examinationRefused: z.boolean(),
    injuries: z.array(InjurySchema), by: UserNameSchema, at: ErInstantSchema,
  })),
  intimationRecord: z.object({
    mode: z.enum(["written", "phone_then_written", "police_present"]), station: z.string(), receiverName: z.string(),
    receiverRank: z.string().nullable(), gdEntryNo: z.string().nullable(), intimatedAt: ErInstantSchema, recordedBy: UserNameSchema,
  }).nullable(),
  countersignedBy: UserNameSchema.nullable(),
  /** The belongings lists and the evidence chain of custody, in order. */
  custody: z.array(z.object({
    custodyId: ErIdSchema,
    link: z.number().int().positive(),
    kind: z.enum(["belongings", "evidence"]),
    evidenceKind: z.string().nullable(),
    description: z.string().nullable(),
    sealNo: z.string().nullable(),
    action: z.string(),
    items: z.array(z.object({ description: z.string(), qty: z.number().int() })).nullable(),
    keptIn: z.object({ kind: z.string(), ref: z.string() }).nullable(),
    receiver: z.object({ name: z.string(), rank: z.string(), station: z.string() }).nullable(),
    recordedBy: UserNameSchema,
    witnessedBy: UserNameSchema,
    at: ErInstantSchema,
  })),
  /** The IPD mortuary register's entry for a body brought dead (or null). */
  mortuaryEntryId: ErIdSchema.nullable(),
});
export type ErMlcDetail = z.infer<typeof ErMlcDetailSchema>;
