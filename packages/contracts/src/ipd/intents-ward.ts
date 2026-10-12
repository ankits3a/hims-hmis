import { z } from "zod";
import { IpdBedClassSchema } from "../ipd-bed-classes";
import {
  IpdIdSchema, IpdInstantSchema, IpdNoteSchema, IpdProvenanceSchema, IpdSignerSchema, IpdUserRefSchema, ipdInput,
  ipdIntent,
} from "./common";

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
  refusals: ["transfer_not_found", "transfer_not_open", "not_receiving_ward", "sender_cannot_accept"],
  actors: ["nurse", "supervisor"],
  copilotProposable: true,
  agentTier: "none",
  undo: "entered_in_error",
  events: ["ipd.transfer.accepted", "ipd.bed.occupied", "ipd.bed.to_cleaning"],
  idempotent: true,
});

/** One atomic act: both beds or neither (§4.4, §6). */
export const swapBeds = ipdIntent({
  input: ipdInput({
    admissionIdA: IpdIdSchema,
    admissionIdB: IpdIdSchema,
    reason: z.enum(["gender_fix", "isolation_fix", "clinical", "patient_request"]),
  }),
  output: z.strictObject({
    a: z.strictObject({ admissionId: IpdIdSchema, bedId: IpdIdSchema }),
    b: z.strictObject({ admissionId: IpdIdSchema, bedId: IpdIdSchema }),
  }),
  refusals: [
    "admission_not_found", "admission_wrong_state", "swap_same_admission", "transfer_already_open",
    "bed_gender_mismatch", "bed_isolation_mismatch", "state_changed",
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
    consent: z.strictObject({ signedBy: IpdSignerSchema, documentId: IpdIdSchema, representativeReason: IpdNoteSchema.optional() }),
    /** The room-rent cap warning was shown before the consent (§4.3). Required true for an upgrade. */
    roomRentCapAcknowledged: z.boolean(),
  }),
  output: z.strictObject({ admissionId: IpdIdSchema, toClass: IpdBedClassSchema, effectiveFrom: IpdInstantSchema }),
  refusals: [
    "admission_not_found", "admission_wrong_state", "class_unchanged", "consent_missing",
    "representative_reason_missing", "room_rent_cap_not_acknowledged",
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
    alertRaised: z.boolean(),
    lateEntry: z.boolean(),
  }),
  refusals: ["admission_not_found", "admission_wrong_state", "value_needs_confirm", "time_in_future", "device_not_registered"],
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
 * The round sign. One chargeable visit per consultant per patient per day posts from here, but the doctor sees
 * no money (decision 0058): the output says signed or awaiting co-sign, never a fee.
 */
export const signRound = ipdIntent({
  input: ipdInput({
    admissionId: IpdIdSchema,
    seenAt: IpdInstantSchema,
    mode: z.enum(["bedside", "remote_review"]),
    note: IpdNoteSchema,
    /** A consultant co-signing a resident's draft. */
    coSignOfRoundId: IpdIdSchema.optional(),
  }),
  output: z.strictObject({
    roundId: IpdIdSchema,
    status: z.enum(["signed", "awaiting_cosign"]),
    signedBy: IpdUserRefSchema,
    seenAt: IpdInstantSchema,
  }),
  refusals: ["admission_not_found", "admission_wrong_state", "not_treating_team", "time_in_future", "consultant_cosign_required"],
  actors: ["doctor", "resident"],
  copilotProposable: true,
  agentTier: "none",
  undo: "entered_in_error",
  events: ["ipd.round.signed"],
  idempotent: true,
});
