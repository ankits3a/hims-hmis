import { z } from "zod";
import { IpdBedClassSchema } from "../ipd-bed-classes";
import {
  IpdIdSchema, IpdInstantSchema, IpdNoteSchema, IpdProvenanceSchema, IpdUserRefSchema, ipdInput,
  ipdIntent,
} from "./common";
import { IpdConsentSchema } from "./intents-admit";

/** E4.1 (#733) — the lines and devices a nursing admission assessment records. */
export const IPD_LINE_DEVICE_KINDS = [
  "peripheral_iv", "central_line", "urinary_catheter", "ng_tube", "drain", "tracheostomy", "oxygen", "other",
] as const;

/**
 * E0.2 (#714) — transfer, nursing, task and round intents (spec §4.4 ipd-transfer, §4.5 ipd-nursing, §4.5A
 * ipd-rounds). Contracts only.
 */

/** The SBAR handover a transfer carries; drafted by the copilot (T2) or typed, always signed by the nurse. */
const SbarSchema = z.strictObject({
  situation: IpdNoteSchema,
  background: IpdNoteSchema,
  assessment: IpdNoteSchema,
  recommendation: IpdNoteSchema,
  draftId: IpdIdSchema.optional(),
});

export const startTransfer = ipdIntent({
  input: ipdInput({
    admissionId: IpdIdSchema,
    toBedId: IpdIdSchema,
    reason: z.enum([
      "clinical_step_up", "clinical_step_down", "post_op", "isolation", "gender_fix", "patient_request", "bed_management",
      // E3.1 review (#759): the bed needs repair — hospital-initiated, so the lower class is kept.
      "maintenance",
    ]),
    handover: SbarSchema,
    intensivistApprovalId: IpdIdSchema.optional(),
  }),
  output: z.strictObject({
    transferId: IpdIdSchema,
    fromBedId: IpdIdSchema,
    toBedId: IpdIdSchema,
    state: z.literal("transferring"),
    /** No acceptance by then escalates to the nursing supervisor (§4.4). */
    escalatesAt: IpdInstantSchema,
  }),
  refusals: [
    "admission_not_found", "admission_wrong_state", "transfer_already_open", "bed_not_available", "bed_gender_mismatch",
    "bed_isolation_mismatch", "bed_age_mismatch", "icu_needs_intensivist",
    // E3.1 (#729): every bed rule the target bed is checked against, as the bed intents refuse them.
    "bed_not_found", "bed_class_mismatch", "room_gender_unknown", "bed_retired", "overflow_needs_duty_manager",
    "patient_not_found", "state_changed",
  ],
  actors: ["nurse", "doctor", "supervisor", "duty_manager", "agent"],
  copilotProposable: true,
  agentTier: "T2",
  undo: "undo_window",
  events: ["ipd.transfer.started"],
  idempotent: true,
});

/** The transfer completes only here; the origin bed goes to cleaning only now (§4.4). */
export const acceptHandover = ipdIntent({
  input: ipdInput({ transferId: IpdIdSchema }),
  output: z.strictObject({
    admissionId: IpdIdSchema,
    bedId: IpdIdSchema,
    originBedId: IpdIdSchema,
    state: z.literal("admitted"),
    acceptedAt: IpdInstantSchema,
  }),
  refusals: [
    "transfer_not_found", "transfer_not_open", "not_receiving_ward", "sender_cannot_accept",
    // E3.1 (#729): the reserved target bed is re-checked under its lock at acceptance.
    "bed_not_available", "state_changed",
    // E3.1 review (#759): the target's hold ran out before acceptance.
    "transfer_hold_lapsed",
  ],
  // E3.1 (DECIDED): the duty manager accepts at night (no ward_nurse / nursing_supervisor role is seeded yet).
  actors: ["nurse", "supervisor", "duty_manager"],
  copilotProposable: true,
  agentTier: "none",
  undo: "entered_in_error",
  events: ["ipd.transfer.accepted", "ipd.bed.occupied", "ipd.bed.to_cleaning"],
  idempotent: true,
});

/**
 * E3.1 (#729, DECIDED) — the transfer is called off before acceptance: the patient worsened, the receiving ward
 * cannot take them, or the plan changed. The target bed's hold is released and the admission is back to `admitted`
 * on its origin bed (which it never left). Not in §0B's list: §4.4's edge "cancel back or continue" needs it. It
 * rides the workflow's one `transferring → admitted` edge (the engine allows one edge per pair), so its actors are
 * `accept_handover`'s.
 */
export const cancelTransfer = ipdIntent({
  input: ipdInput({
    transferId: IpdIdSchema,
    reason: z.enum(["patient_deteriorated", "receiving_ward_declined", "bed_unsuitable", "plan_changed", "other"]),
    note: IpdNoteSchema.optional(),
  }),
  output: z.strictObject({ admissionId: IpdIdSchema, bedId: IpdIdSchema, state: z.literal("admitted"), cancelledAt: IpdInstantSchema }),
  refusals: ["transfer_not_found", "transfer_not_open", "state_changed"],
  actors: ["nurse", "supervisor", "duty_manager"],
  copilotProposable: false,
  agentTier: "none",
  undo: "irreversible",
  events: ["ipd.transfer.cancelled"],
  idempotent: true,
});

/** One atomic act: both beds or neither (§4.4, §6). */
export const swapBeds = ipdIntent({
  input: ipdInput({
    admissionIdA: IpdIdSchema,
    admissionIdB: IpdIdSchema,
    reason: z.enum(["gender_fix", "isolation_fix", "clinical", "patient_request"]),
    /** E3.1 review (#759): a patient moving onto an ICU bed from a ward bed needs a granted intensivist approval. */
    intensivistApprovalIdA: IpdIdSchema.optional(),
    intensivistApprovalIdB: IpdIdSchema.optional(),
  }),
  output: z.strictObject({
    a: z.strictObject({ admissionId: IpdIdSchema, bedId: IpdIdSchema }),
    b: z.strictObject({ admissionId: IpdIdSchema, bedId: IpdIdSchema }),
  }),
  refusals: [
    "admission_not_found", "admission_wrong_state", "swap_same_admission", "transfer_already_open",
    "bed_gender_mismatch", "bed_isolation_mismatch", "state_changed",
    // E3.1 (#729): both patients are checked against every rule of the other's bed.
    "bed_age_mismatch", "bed_class_mismatch", "room_gender_unknown", "overflow_needs_duty_manager", "patient_not_found",
    // E3.1 review (#759)
    "icu_needs_intensivist", "swap_isolation",
  ],
  actors: ["nurse", "supervisor", "duty_manager", "agent"],
  copilotProposable: true,
  agentTier: "T2",
  undo: "entered_in_error",
  events: ["ipd.bed.swapped"],
  idempotent: true,
});

/** A class change on request: consent, effective next noon. A clinical move goes through start_transfer. */
export const changeClass = ipdIntent({
  input: ipdInput({
    admissionId: IpdIdSchema,
    toClass: IpdBedClassSchema,
    /**
     * E3.1 (#729): the admission consent's shape — who signed, their relation, the method (paper names its witness).
     * The E0.2 shape `{ signedBy, documentId, representativeReason }` still parses.
     */
    consent: IpdConsentSchema,
    /** The room-rent cap warning was shown before the consent (§4.3). Required true for an upgrade. */
    roomRentCapAcknowledged: z.boolean(),
  }),
  output: z.strictObject({ admissionId: IpdIdSchema, toClass: IpdBedClassSchema, effectiveFrom: IpdInstantSchema }),
  refusals: [
    "admission_not_found", "admission_wrong_state", "class_unchanged", "consent_missing",
    "representative_reason_missing", "room_rent_cap_not_acknowledged",
    // E3.1 (#729): a class change in place is for ward room classes; critical care is a transfer.
    "class_not_ward",
  ],
  actors: ["desk", "billing", "supervisor"],
  copilotProposable: true,
  agentTier: "none",
  undo: "undo_window",
  events: ["ipd.admission.class_changed"],
  idempotent: true,
});

/** Nursing admission within 1 hour (§4.5). Late entries are dual-stamped: `happenedAt` and the server's now. */
export const recordNursingAssessment = ipdIntent({
  input: ipdInput({
    admissionId: IpdIdSchema,
    happenedAt: IpdInstantSchema,
    source: IpdProvenanceSchema,
    morse: z.number().int().min(0).max(125),
    braden: z.number().int().min(6).max(23),
    nutrition: z.enum(["no_risk", "at_risk", "malnourished"]),
    allergyChecked: z.literal(true),
    allergies: z.array(z.string().trim().min(1).max(120)).max(50),
    homeMedicines: z.array(z.strictObject({
      name: z.string().trim().min(1).max(120),
      dose: z.string().trim().min(1).max(60),
      frequency: z.string().trim().min(1).max(30),
    })).max(50),
    painScore: z.number().int().min(0).max(10),
    /** Pressure injuries photographed and marked present on admission. */
    pressureInjuriesOnAdmission: z.array(z.strictObject({
      site: z.string().trim().min(1).max(60),
      stage: z.number().int().min(1).max(4),
      photoDocumentId: IpdIdSchema,
    })).max(20),
    /** E4.1 (#733, DECIDED) — lines and devices in place at admission (cannula, catheter, tubes, drains, oxygen). */
    linesDevices: z.array(z.strictObject({
      kind: z.enum(IPD_LINE_DEVICE_KINDS),
      site: z.string().trim().min(1).max(60).optional(),
      insertedAt: IpdInstantSchema.optional(),
    })).max(20).optional(),
    /**
     * E4.1 (#733) — pregnant, or within 42 days after delivery: the early-warning score is MEOWS (`ews.ts` `ewsKindFor`).
     * Unanswered, an obstetric department or labour bed decides.
     */
    obstetric: z.enum(["none", "pregnant", "postpartum"]).optional(),
  }),
  output: z.strictObject({ assessmentId: IpdIdSchema, lateEntry: z.boolean(), tasksRaised: z.number().int().nonnegative() }),
  refusals: ["admission_not_found", "admission_wrong_state", "assessment_already_recorded", "time_in_future"],
  actors: ["nurse"],
  copilotProposable: true,
  agentTier: "none",
  undo: "entered_in_error",
  events: ["ipd.nursing.assessed"],
  idempotent: true,
});

/** Vitals by a person or a registered device; both are kept with their source (§4.10 edge 25). */
export const recordVitals = ipdIntent({
  input: ipdInput({
    admissionId: IpdIdSchema,
    observedAt: IpdInstantSchema,
    source: IpdProvenanceSchema,
    deviceId: IpdIdSchema.optional(),
    /** The patient refused observations: recorded as refused, not missing (§4.5). */
    refused: z.literal(true).optional(),
    values: z.strictObject({
      temperatureC: z.number().min(25).max(45).optional(),
      pulse: z.number().int().min(0).max(300).optional(),
      respRate: z.number().int().min(0).max(80).optional(),
      systolic: z.number().int().min(0).max(300).optional(),
      diastolic: z.number().int().min(0).max(200).optional(),
      spo2: z.number().int().min(0).max(100).optional(),
      onOxygen: z.boolean().optional(),
      consciousness: z.enum(["alert", "confused", "voice", "pain", "unresponsive"]).optional(),
      painScore: z.number().int().min(0).max(10).optional(),
      /** E4.1 (#733) — capillary refill in seconds (PEWS's cardiovascular row). */
      capRefillSec: z.number().int().min(0).max(10).optional(),
    }),
    /** The person confirmed a value outside physiological limits (the typo guard). */
    confirmedOutOfRange: z.literal(true).optional(),
  }).superRefine((v, ctx) => {
    const given = Object.values(v.values).some((x) => x !== undefined);
    if (v.refused === true && given) ctx.addIssue({ code: "custom", path: ["values"], message: "refused observations carry no values" });
    if (v.refused !== true && !given) ctx.addIssue({ code: "custom", path: ["values"], message: "at least one value, or refused" });
    if (v.source === "device" && v.deviceId === undefined) ctx.addIssue({ code: "custom", path: ["deviceId"], message: "a device reading names its device" });
    if (v.source !== "device" && v.deviceId !== undefined) ctx.addIssue({ code: "custom", path: ["deviceId"], message: "only a device reading names a device" });
  }),
  output: z.strictObject({
    vitalsId: IpdIdSchema,
    score: z.strictObject({ kind: z.enum(["news2", "meows", "pews"]), value: z.number().int(), band: z.enum(["low", "low_medium", "medium", "high"]) }).nullable(),
    /** E4.1 review: a notice actually went out for this set (raise or re-raise). */
    alertRaised: z.boolean(),
    /**
     * E4.1 review: when this set raised the alert, whether a DOCTOR was among those told; false → the phone says
     * "No doctor reached — call" (the fallback chain was told instead). Null when this set raised nothing.
     */
    doctorReached: z.boolean().nullable().optional(),
    lateEntry: z.boolean(),
  }),
  refusals: [
    "admission_not_found", "admission_wrong_state", "value_needs_confirm", "time_in_future", "device_not_registered",
    // E4.1 review: a set taken more than 24 hours ago is not charted by this act (record it on paper / as a note).
    "observation_too_old",
  ],
  actors: ["nurse", "doctor", "resident", "device"],
  copilotProposable: true,
  agentTier: "none",
  undo: "entered_in_error",
  events: ["ipd.vitals.recorded"],
  idempotent: true,
});

/** Tasks are addressable to a person, a role or a machine alike (§0 lens 8). */
export const raiseTask = ipdIntent({
  input: ipdInput({
    admissionId: IpdIdSchema.optional(),
    kind: z.enum([
      "vitals_due", "reassessment", "result_recall", "social_worker", "mlc_check", "restraint_check",
      "cause_of_death_certificate", "mortuary_handover", "auto_move", "other",
    ]),
    assignee: z.strictObject({ kind: z.enum(["person", "role", "machine"]), ref: z.string().trim().min(1).max(64) }),
    dueAt: IpdInstantSchema,
    note: IpdNoteSchema.optional(),
  }),
  output: z.strictObject({ taskId: IpdIdSchema, dueAt: IpdInstantSchema }),
  refusals: ["admission_not_found", "admission_wrong_state", "assignee_unknown", "agent_open_limit"],
  actors: ["nurse", "doctor", "resident", "supervisor", "desk", "device", "agent"],
  copilotProposable: true,
  agentTier: "T1",
  undo: "undo_window",
  events: ["ipd.task.raised"],
  idempotent: true,
});

export const completeTask = ipdIntent({
  input: ipdInput({
    taskId: IpdIdSchema,
    outcome: z.enum(["done", "refused_by_patient", "not_needed"]),
    completedAt: IpdInstantSchema,
    note: IpdNoteSchema.optional(),
    /** Photo proof for low-literacy flows (§4.10 edge 21). */
    proofDocumentId: IpdIdSchema.optional(),
  }),
  output: z.strictObject({ taskId: IpdIdSchema, completedAt: IpdInstantSchema, lateEntry: z.boolean() }),
  refusals: ["task_not_found", "task_closed", "not_task_assignee", "time_in_future"],
  actors: ["nurse", "doctor", "resident", "supervisor", "desk", "device"],
  copilotProposable: true,
  agentTier: "none",
  undo: "entered_in_error",
  events: ["ipd.task.completed"],
  idempotent: true,
});

/**
 * The round sign (E4.2 #734, spec §4.5A). A structured S/O/A/P note with its source. A consultant's bedside round posts
 * the day's visit through the charges seam (one chargeable visit per consultant per patient per day); a remote review
 * is recorded as such and posts none. A resident's or intern's round is a draft until the treating consultant
 * co-signs it (`cosign_round`). "Fit for discharge" on the round starts the discharge cascade (`declare_fit`) in the
 * same act — the treating consultant's only. The doctor sees no money (decision 0058): the output never says
 * whether a visit was charged.
 */
const RoundTextSchema = z.string().trim().max(2000);
export const IpdRoundSoapSchema = z.strictObject({
  subjective: RoundTextSchema.optional(),
  objective: RoundTextSchema.optional(),
  assessment: RoundTextSchema.optional(),
  plan: RoundTextSchema.optional(),
}).refine((s) => Object.values(s).some((v) => typeof v === "string" && v.length > 0), { message: "write at least one of S, O, A, P" });
export type IpdRoundSoap = z.infer<typeof IpdRoundSoapSchema>;
/** Where the note's words came from (§0B provenance): typed by the person, dictated, or a copilot draft they signed. */
export const IPD_ROUND_SOURCES = ["typed", "voice", "copilot_draft"] as const;

export const signRound = ipdIntent({
  input: ipdInput({
    admissionId: IpdIdSchema,
    seenAt: IpdInstantSchema,
    mode: z.enum(["bedside", "remote_review"]),
    soap: IpdRoundSoapSchema,
    source: z.enum(IPD_ROUND_SOURCES).optional(),
    /** "Fit for discharge: today / tomorrow" from the plan bar — starts the discharge cascade. Consultant only. */
    fit: z.strictObject({ when: z.enum(["today", "tomorrow"]), disposition: z.enum(["home", "transfer_out"]) }).optional(),
  }),
  output: z.strictObject({
    roundId: IpdIdSchema,
    status: z.enum(["signed", "awaiting_cosign"]),
    signedBy: IpdUserRefSchema,
    seenAt: IpdInstantSchema,
    mode: z.enum(["bedside", "remote_review"]),
    /** The discharge clock started by this round (null when no fit was declared). */
    fitDeclaredAt: IpdInstantSchema.nullable(),
  }),
  refusals: [
    "admission_not_found", "admission_wrong_state", "not_treating_team", "time_in_future", "consultant_cosign_required",
    "not_treating_consultant",
  ],
  actors: ["doctor", "resident"],
  copilotProposable: true,
  agentTier: "none",
  undo: "entered_in_error",
  events: ["ipd.round.signed"],
  idempotent: true,
});
