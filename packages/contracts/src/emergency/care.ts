import { z } from "zod";
import { ErIdSchema, ErInstantSchema, ErNoteSchema, ErUserRefSchema, ErWordsSchema, erInput, erIntent } from "./common";

/**
 * ER lane 3 (#810) — CARE (spec SPEC-emergency §3.10–§3.11, §4.3). Notes, the ordering door at STAT, the ER satellite
 * issue and the medication record, procedures, consent, specialty calls, criticals to the ER doctor, and "stabilised".
 *
 * Care is never gated (spec §0): no intent here reads the bill, the identity status or the MLC state to refuse. No answer
 * names money (decision 0058) — the ER charge lines exist (the `ER` episode's charge sink) but are lane 6's to show.
 */
const LongNoteSchema = z.string().trim().min(1).max(4000);

/* ═══ notes ═══ */
export const ER_NOTE_KINDS = ["assessment", "progress", "nursing", "procedure", "handover"] as const;
export const recordErNote = erIntent({
  input: erInput({ episodeId: ErIdSchema, kind: z.enum(ER_NOTE_KINDS), text: LongNoteSchema }),
  output: z.strictObject({ noteId: ErIdSchema, status: z.enum(["signed", "draft"]), at: ErInstantSchema }),
  refusals: ["episode_not_found", "episode_wrong_state"],
  actors: ["er_nurse", "doctor"],
  copilotProposable: true,
  agentTier: "none",
  undo: "entered_in_error",
  events: ["er.note_recorded"],
  idempotent: true,
});

/** A resident's ER note is a DRAFT until a senior (a doctor who is not a resident) co-signs it within the shift. */
export const cosignErNote = erIntent({
  input: erInput({ noteId: ErIdSchema, addendum: ErNoteSchema.optional() }),
  output: z.strictObject({ noteId: ErIdSchema, status: z.literal("signed"), cosignedAt: ErInstantSchema }),
  refusals: ["note_not_found", "note_signed", "cosign_own_note", "cosigner_not_senior"],
  actors: ["doctor"],
  copilotProposable: false,
  agentTier: "none",
  undo: "irreversible",
  events: ["er.note_cosigned"],
  idempotent: true,
});

/* ═══ orders: the ordering door (decision 0067), STAT by default ═══ */
export const placeErOrder = erIntent({
  input: erInput({
    episodeId: ErIdSchema,
    /** Tariff service ids (not all ULIDs: seeded catalogues carry their own grammar). */
    serviceIds: z.array(z.string().min(1).max(64)).min(1).max(30),
    indication: ErNoteSchema,
    priority: z.enum(["stat", "urgent", "routine"]).optional(),
  }),
  output: z.strictObject({
    episodeId: ErIdSchema,
    labOrderId: ErIdSchema.nullable(),
    imagingOrderId: ErIdSchema.nullable(),
    /** What a department refused (its code and words) — the rest went. */
    skipped: z.array(z.strictObject({ department: z.string(), serviceIds: z.array(z.string()), code: z.string(), message: z.string() })),
    /** Same test already ordered on this episode in the last 6 hours: a WARNING, never a block (spec §4.3). */
    duplicates: z.array(z.string()),
  }),
  refusals: ["episode_not_found", "episode_wrong_state", "not_a_doctor"],
  actors: ["doctor"],
  copilotProposable: true,
  agentTier: "none",
  undo: "reversal_line",
  events: ["er.order_placed"],
  idempotent: true,
});

/* ═══ medicines: ER satellite issue, the medication record ═══ */
export const ER_MED_ROUTES = ["iv", "im", "sc", "oral", "neb", "sl", "pr", "topical", "inhaled", "other"] as const;
export const issueErMed = erIntent({
  input: erInput({
    episodeId: ErIdSchema,
    /** The stocked item (crash cart / ER satellite store). Absent with `ownMedicine` (brought by the family). */
    itemId: ErIdSchema.optional(),
    ownMedicine: ErWordsSchema.optional(),
    doseWords: z.string().trim().min(1).max(60),
    route: z.enum(ER_MED_ROUTES),
    units: z.number().int().min(1).max(100),
    /** The doctor who ordered it. A verbal order (resus) is read back now and signed by that doctor within 2 hours. */
    orderedBy: ErUserRefSchema,
    verbal: z.strictObject({ readBack: z.literal(true) }).optional(),
    /** A recorded allergy matches: the issue needs the reason it goes ahead (never a hard block in an emergency). */
    allergyOverride: ErNoteSchema.optional(),
  }).refine((i) => (i.itemId === undefined) !== (i.ownMedicine === undefined), { message: "a stocked item or the patient's own medicine, exactly one", path: ["itemId"] }),
  output: z.strictObject({
    issueId: ErIdSchema, highAlert: z.boolean(), labels: z.number().int().nonnegative(), verbal: z.boolean(),
    /** The patient-label lines printed with the issue (drug, dose, route, patient alias/name, ER number). */
    labelLines: z.array(z.string()),
  }),
  refusals: ["episode_not_found", "episode_wrong_state", "not_a_doctor", "item_not_stocked", "stock_short", "allergy_override_needed"],
  actors: ["er_nurse", "doctor"],
  copilotProposable: false,
  agentTier: "none",
  undo: "reversal_line",
  events: ["er.med_issued"],
  idempotent: true,
});

/** Give, hold or refuse one issue (IPD eMAR's shape). A high-alert drug given needs a SECOND person's PIN. */
export const giveErDose = erIntent({
  input: erInput({
    issueId: ErIdSchema,
    outcome: z.enum(["given", "held", "refused"]),
    reason: ErNoteSchema.optional(),
    secondCheck: z.strictObject({ username: z.string().trim().min(1).max(64), pin: z.string().regex(/^\d{4,6}$/) }).optional(),
  }).refine((i) => i.outcome === "given" || i.reason !== undefined, { message: "a held or refused dose says why", path: ["reason"] }),
  output: z.strictObject({ doseId: ErIdSchema, outcome: z.enum(["given", "held", "refused"]), at: ErInstantSchema, secondCheckedBy: ErUserRefSchema.nullable() }),
  refusals: [
    "issue_not_found", "dose_already_recorded", "second_check_needed", "second_check_failed", "second_checker_same", "episode_wrong_state",
    "issue_returned",
  ],
  actors: ["er_nurse", "doctor"],
  copilotProposable: false,
  agentTier: "none",
  undo: "entered_in_error",
  events: ["er.dose_recorded"],
  idempotent: true,
});

/**
 * ER review 2 (2026-10-15, DECIDED) — a medicine not given goes back. UNOPENED: the units return to ER-SAT (FEFO batches
 * of the issue) and the issue's charge is reversed. OPENED: wastage — no stock movement (the issue took it), and the
 * charge STANDS unless the bill desk waives it; a high-alert or controlled drug's wastage names a witness who confirms
 * with username and PIN. Never after a dose was given; once per issue. A held or refused dose prompts it on the screen.
 */
export const returnErMed = erIntent({
  input: erInput({
    issueId: ErIdSchema,
    condition: z.enum(["unopened", "opened"]),
    reason: ErNoteSchema,
    witness: z.strictObject({ username: z.string().trim().min(1).max(64), pin: z.string().regex(/^\d{4,6}$/) }).optional(),
  }),
  output: z.strictObject({
    returnId: ErIdSchema, kind: z.enum(["returned", "wasted"]), units: z.number().int().positive(), witnessedBy: ErUserRefSchema.nullable(),
  }),
  refusals: [
    "issue_not_found", "episode_wrong_state", "dose_given", "already_returned", "nothing_to_return", "wastage_needs_witness",
    "second_check_failed", "second_checker_same",
  ],
  actors: ["er_nurse", "doctor"],
  copilotProposable: false,
  agentTier: "none",
  undo: "irreversible",
  events: ["er.med_returned"],
  idempotent: true,
});

export const signErVerbalOrder = erIntent({
  input: erInput({ issueId: ErIdSchema }),
  output: z.strictObject({ issueId: ErIdSchema, signedAt: ErInstantSchema }),
  refusals: ["issue_not_found", "verbal_not_pending", "not_ordering_doctor"],
  actors: ["doctor"],
  copilotProposable: false,
  agentTier: "none",
  undo: "irreversible",
  events: ["er.verbal_signed"],
  idempotent: true,
});

/* ═══ procedures and consent ═══ */
export const recordProcedure = erIntent({
  input: erInput({
    episodeId: ErIdSchema,
    name: ErWordsSchema,
    /** The tariff service, when the procedure has one (it posts to the ER charge sink). */
    serviceId: z.string().min(1).max(64).optional(),
    performedBy: ErUserRefSchema,
    performedAt: ErInstantSchema.optional(),
    consentId: ErIdSchema.optional(),
    notes: LongNoteSchema.optional(),
  }),
  output: z.strictObject({ procedureId: ErIdSchema, at: ErInstantSchema }),
  refusals: ["episode_not_found", "episode_wrong_state", "time_in_future", "consent_not_found"],
  actors: ["er_nurse", "doctor"],
  copilotProposable: true,
  agentTier: "none",
  undo: "entered_in_error",
  events: ["er.procedure_recorded"],
  idempotent: true,
});

export const ER_CONSENT_KINDS = ["general", "procedure", "blood", "high_risk", "refusal_of_treatment"] as const;
/**
 * Consent, or its lawful absence. `emergency` (no capacity, no relative, life at risk): treatment goes ahead on the
 * treating doctor's word with a SECOND doctor's concurrence — the standard Indian emergency-consent practice.
 */
export const recordConsent = erIntent({
  input: erInput({
    episodeId: ErIdSchema,
    kind: z.enum(ER_CONSENT_KINDS),
    about: ErWordsSchema,
    signedBy: z.enum(["patient", "guardian", "representative", "emergency"]),
    signerName: ErWordsSchema.optional(),
    relation: z.string().trim().min(1).max(40).optional(),
    method: z.enum(["paper", "tablet_signature", "otp"]),
    witnessName: ErWordsSchema.optional(),
    /**
     * ER review 2 (2026-10-15, DECIDED): an emergency consent's second doctor CONFIRMS with their own username and PIN
     * (the high-alert dose's check), never a name picked by the treating doctor.
     */
    secondDoctor: z.strictObject({ username: z.string().trim().min(1).max(64), pin: z.string().regex(/^\d{4,6}$/) }).optional(),
    language: z.enum(["hi", "en"]).optional(),
  }),
  output: z.strictObject({ consentId: ErIdSchema, at: ErInstantSchema }),
  refusals: [
    "episode_not_found", "episode_wrong_state", "consent_witness_needed", "emergency_needs_second_doctor", "not_a_doctor", "second_check_failed",
  ],
  actors: ["er_nurse", "doctor"],
  copilotProposable: false,
  agentTier: "none",
  undo: "entered_in_error",
  events: ["er.consent_recorded"],
  idempotent: true,
});

/* ═══ specialty calls ═══ */
export const callSpecialty = erIntent({
  input: erInput({
    episodeId: ErIdSchema,
    departmentCode: z.string().trim().min(2).max(16),
    urgency: z.enum(["immediate", "urgent", "routine"]),
    reason: ErNoteSchema,
  }),
  output: z.strictObject({
    callId: ErIdSchema,
    /** The unit on take at the GATE instant (seam E2), and the rungs the roster names for it (consultant names). */
    takeTeamId: z.string().nullable(),
    takeSource: z.enum(["published", "none"]),
    callees: z.array(z.strictObject({ userId: ErUserRefSchema, name: z.string() })),
    calledAt: ErInstantSchema,
  }),
  refusals: ["episode_not_found", "episode_wrong_state", "department_not_found", "call_already_open"],
  actors: ["doctor", "er_nurse"],
  copilotProposable: true,
  agentTier: "none",
  undo: "irreversible",
  events: ["er.call_raised"],
  idempotent: true,
});

export const answerCall = erIntent({
  input: erInput({ callId: ErIdSchema, step: z.enum(["answered", "seen"]), note: ErNoteSchema.optional() }),
  output: z.strictObject({ callId: ErIdSchema, answeredAt: ErInstantSchema.nullable(), seenAt: ErInstantSchema.nullable() }),
  refusals: ["call_not_found", "call_closed", "not_a_doctor"],
  actors: ["doctor"],
  copilotProposable: false,
  agentTier: "none",
  undo: "irreversible",
  events: ["er.call_answered"],
  idempotent: true,
});

/* ═══ stabilised ═══ */
/**
 * "Stabilised" is a CLINICAL word only (spec §3.6): the ER doctor's judgement that the emergency condition is controlled.
 * Lane 6 reads it (no money act before it); lane 5 copies it to the admission. Nothing on a clinical screen ties it to money.
 */
export const declareStabilised = erIntent({
  input: erInput({ episodeId: ErIdSchema, note: ErNoteSchema.optional() }),
  output: z.strictObject({ episodeId: ErIdSchema, stabilisedAt: ErInstantSchema }),
  refusals: ["episode_not_found", "episode_wrong_state", "not_a_doctor", "already_stabilised"],
  actors: ["doctor"],
  copilotProposable: true,
  agentTier: "none",
  undo: "irreversible",
  events: ["er.stabilised"],
  idempotent: true,
});
