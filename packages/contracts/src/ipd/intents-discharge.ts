import { z } from "zod";
import {
  IpdIdSchema, IpdInstantSchema, IpdNoteSchema, IpdPaiseSchema, IpdPositivePaiseSchema, IpdSignerSchema,
  IpdTenderSchema, IpdUserRefSchema, ipdInput, ipdIntent,
} from "./common";

/**
 * E0.2 (#714) — fit for discharge, the discharge cascade and the other ways a stay ends (spec §4.5A, §4.7).
 *
 * DECIDED (E0.2): the gate pass is the cascade's single gate. `issue_gate_pass` refuses until every department
 * has confirmed charges, the summary is signed and the bill is settled (or its dues approved); it moves the
 * admission to `discharging`. The security scan (`scan_gate_pass`) ends the stay — `discharged`, or
 * `transferred_out` for a refer-out, which follows the same path (§4.4: refer-out is a discharge type).
 */

export const declareFit = ipdIntent({
  input: ipdInput({
    admissionId: IpdIdSchema,
    when: z.enum(["today", "tomorrow"]),
    disposition: z.enum(["home", "transfer_out"]),
    note: IpdNoteSchema.optional(),
  }),
  output: z.strictObject({
    admissionId: IpdIdSchema,
    state: z.literal("fit_declared"),
    clockStartedAt: IpdInstantSchema,
    /** The 3-hour target for cash; for cashless, the insurer's pace decides. */
    targetAt: IpdInstantSchema,
  }),
  refusals: ["admission_not_found", "admission_wrong_state", "not_treating_consultant"],
  actors: ["doctor"],
  copilotProposable: true,
  agentTier: "none",
  undo: "undo_window",
  events: ["ipd.discharge.fit_declared"],
  idempotent: true,
});

/** The patient worsened: every unsigned step stops; signed documents stay (§4.7). */
export const cancelFit = ipdIntent({
  input: ipdInput({ admissionId: IpdIdSchema, reason: IpdNoteSchema }),
  output: z.strictObject({
    admissionId: IpdIdSchema,
    state: z.literal("admitted"),
    stepsStopped: z.number().int().nonnegative(),
    gatePassVoided: z.boolean(),
  }),
  refusals: ["admission_not_found", "admission_wrong_state", "not_treating_consultant"],
  actors: ["doctor"],
  copilotProposable: true,
  agentTier: "none",
  undo: "entered_in_error",
  events: ["ipd.discharge.fit_cancelled"],
  idempotent: true,
});

const DEPARTMENTS = ["pharmacy", "lab", "radiology", "ot", "ward", "dietary", "cssd", "blood_bank"] as const;

/** Each department confirms it has no pending charge; silence over 30 minutes escalates (§4.7). */
export const confirmCharges = ipdIntent({
  input: ipdInput({ admissionId: IpdIdSchema, department: z.enum(DEPARTMENTS), note: IpdNoteSchema.optional() }),
  output: z.strictObject({
    admissionId: IpdIdSchema,
    department: z.enum(DEPARTMENTS),
    pending: z.array(z.enum(DEPARTMENTS)),
    allConfirmed: z.boolean(),
  }),
  refusals: ["admission_not_found", "admission_wrong_state", "department_not_yours", "medicines_not_returned"],
  actors: ["billing", "pharmacist", "nurse", "desk"],
  copilotProposable: true,
  agentTier: "none",
  undo: "entered_in_error",
  events: ["ipd.discharge.charges_confirmed"],
  idempotent: true,
});

/** Signs the summary draft (copilot T2 or template). Never auto-signed (§4.11). */
export const signSummary = ipdIntent({
  input: ipdInput({
    admissionId: IpdIdSchema,
    draftId: IpdIdSchema,
    /** The version the doctor read; a newer draft refuses `draft_changed`. */
    draftVersion: z.number().int().positive(),
  }),
  output: z.strictObject({
    summaryId: IpdIdSchema,
    status: z.enum(["signed", "awaiting_cosign"]),
    signedBy: IpdUserRefSchema,
    documentId: IpdIdSchema,
  }),
  refusals: [
    "admission_not_found", "admission_wrong_state", "not_treating_team", "draft_changed",
    "medicine_not_on_active_order", "consultant_cosign_required",
  ],
  actors: ["doctor", "resident"],
  copilotProposable: true,
  agentTier: "none",
  undo: "irreversible",
  events: ["ipd.summary.signed"],
  idempotent: true,
});

/** Nobody is detained for unpaid dues: the balance goes to approval and the dues register (§4.7). */
export const settleFinalBill = ipdIntent({
  input: ipdInput({
    admissionId: IpdIdSchema,
    /** The bill version the cashier read; a newer bill refuses `bill_changed`. */
    billVersion: z.number().int().positive(),
    settlement: z.enum(["paid", "refund_due", "dues_approved", "insurer_pending_undertaking"]),
    payments: z.array(z.strictObject({ tender: IpdTenderSchema, amountPaise: IpdPositivePaiseSchema })).max(10),
    duesApprovalId: IpdIdSchema.optional(),
    undertakingDocumentId: IpdIdSchema.optional(),
  }),
  output: z.strictObject({
    billId: IpdIdSchema,
    billNo: z.string().min(1),
    totalPaise: IpdPaiseSchema,
    payerPayablePaise: IpdPaiseSchema,
    patientPayablePaise: IpdPaiseSchema,
    paidPaise: IpdPaiseSchema,
    refundPaise: IpdPaiseSchema,
    duesPaise: IpdPaiseSchema,
  }),
  refusals: [
    "admission_not_found", "admission_wrong_state", "charges_unconfirmed", "bill_changed", "dues_need_approval",
    "cash_limit_reached", "insurer_final_pending",
  ],
  actors: ["billing", "desk"],
  copilotProposable: false,
  agentTier: "none",
  undo: "reversal_line",
  events: ["ipd.bill.settled"],
  idempotent: true,
});

export const issueGatePass = ipdIntent({
  input: ipdInput({
    admissionId: IpdIdSchema,
    followUpAppointmentId: IpdIdSchema.optional(),
    /** A refer-out: the confirmed receiving hospital. */
    receivingHospital: z.strictObject({ name: z.string().trim().min(1).max(160), confirmedBy: IpdNoteSchema }).optional(),
  }),
  output: z.strictObject({
    gatePassId: IpdIdSchema,
    code: z.string().min(1),
    state: z.literal("discharging"),
    issuedAt: IpdInstantSchema,
  }),
  refusals: [
    "admission_not_found", "admission_wrong_state", "charges_unconfirmed", "summary_unsigned", "bill_unsettled",
    "receiving_hospital_missing",
  ],
  actors: ["billing", "desk", "nurse"],
  copilotProposable: true,
  agentTier: "none",
  undo: "undo_window",
  events: ["ipd.gate_pass.issued"],
  idempotent: true,
});

/** Security's scan at the gate: a registered scanner (device), or the duty manager by hand. */
export const scanGatePass = ipdIntent({
  input: ipdInput({ gatePassCode: z.string().trim().min(1).max(64), gateId: IpdIdSchema, scannedAt: IpdInstantSchema }),
  output: z.strictObject({
    admissionId: IpdIdSchema,
    state: z.enum(["discharged", "transferred_out"]),
    bedId: IpdIdSchema,
    bedStatus: z.literal("cleaning"),
  }),
  refusals: ["gate_pass_not_found", "gate_pass_void", "gate_pass_used", "device_not_registered"],
  actors: ["device", "duty_manager"],
  copilotProposable: false,
  agentTier: "none",
  undo: "irreversible",
  events: ["ipd.gate_pass.scanned", "ipd.admission.discharged", "ipd.bed.to_cleaning"],
  idempotent: true,
});

/** LAMA / DAMA: risks explained, form signed, a summary still given (§4.7). */
export const recordLama = ipdIntent({
  input: ipdInput({
    admissionId: IpdIdSchema,
    kind: z.enum(["lama", "dama"]),
    signedBy: IpdSignerSchema,
    representativeReason: IpdNoteSchema.optional(),
    risksExplainedBy: IpdUserRefSchema,
    formDocumentId: IpdIdSchema,
    at: IpdInstantSchema,
  }),
  output: z.strictObject({ admissionId: IpdIdSchema, state: z.literal("lama"), summaryTaskId: IpdIdSchema }),
  refusals: ["admission_not_found", "admission_wrong_state", "representative_reason_missing", "time_in_future"],
  actors: ["doctor", "nurse", "duty_manager"],
  copilotProposable: true,
  agentTier: "none",
  undo: "entered_in_error",
  events: ["ipd.admission.lama"],
  idempotent: true,
});

/** Absconded: security search, police if MLC, bill frozen, bed held until security closes the case (§4.10 edge 17). */
export const recordAbscond = ipdIntent({
  input: ipdInput({
    admissionId: IpdIdSchema,
    lastSeenAt: IpdInstantSchema,
    searchDone: z.literal(true),
    policeIntimationRef: z.string().trim().min(1).max(64).optional(),
    note: IpdNoteSchema.optional(),
  }),
  output: z.strictObject({ admissionId: IpdIdSchema, state: z.literal("absconded"), billFrozen: z.literal(true) }),
  refusals: ["admission_not_found", "admission_wrong_state", "police_intimation_required", "time_in_future"],
  actors: ["nurse", "supervisor", "duty_manager"],
  copilotProposable: true,
  agentTier: "none",
  undo: "entered_in_error",
  events: ["ipd.admission.absconded"],
  idempotent: true,
});

/** Death: certification by a doctor; certificate and mortuary-handover tasks follow (§4.7, §4.10 edge 16). */
export const recordDeath = ipdIntent({
  input: ipdInput({
    admissionId: IpdIdSchema,
    diedAt: IpdInstantSchema,
    certifiedBy: IpdUserRefSchema,
    policeIntimationRef: z.string().trim().min(1).max(64).optional(),
    note: IpdNoteSchema.optional(),
  }),
  output: z.strictObject({ admissionId: IpdIdSchema, state: z.literal("deceased"), taskIds: z.array(IpdIdSchema) }),
  refusals: ["admission_not_found", "admission_wrong_state", "time_in_future", "police_intimation_required"],
  actors: ["doctor", "resident"],
  copilotProposable: false,
  agentTier: "none",
  undo: "irreversible",
  events: ["ipd.admission.deceased"],
  idempotent: true,
});
