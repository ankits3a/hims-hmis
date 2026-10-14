import { z } from "zod";
import { IpdIdSchema, IpdInstantSchema, IpdPaiseSchema, IpdPositivePaiseSchema, ipdInput, ipdIntent } from "./common";

/**
 * #604 (decision 0075) — THE TPA DESK'S INTENTS (SPEC-tpa-desk-2026-10-15). The desk types what the insurer, TPA or
 * scheme portal said; portal filing stays manual. Billing and front-office acts only: no doctor or resident is an actor,
 * and none is copilot-proposable (money acts, decision 0058/0069). Amounts are integer paise.
 */

/** Which step of the payer's process a query or a document belongs to. */
export const IPD_TPA_STAGES = ["preauth", "enhancement", "final", "claim"] as const;
export const IpdTpaStageSchema = z.enum(IPD_TPA_STAGES);
export type IpdTpaStage = z.infer<typeof IpdTpaStageSchema>;

/** What a document attached to a stage is (the insurer's checklist words). */
export const IPD_TPA_DOCUMENT_KINDS = [
  "preauth_form", "id_proof", "policy_card", "doctor_notes", "investigations", "estimate", "approval_letter",
  "discharge_summary", "final_bill", "pharmacy_bills", "consent", "other",
] as const;
export const IpdTpaDocumentKindSchema = z.enum(IPD_TPA_DOCUMENT_KINDS);
export type IpdTpaDocumentKind = z.infer<typeof IpdTpaDocumentKindSchema>;

/** DECIDED (standard claim checklist): a claim is submitted only with these attached at stage `claim`. */
export const IPD_CLAIM_REQUIRED_DOCUMENTS = ["discharge_summary", "final_bill"] as const satisfies readonly IpdTpaDocumentKind[];

/** Why the payer deducted (the settlement advice's reasons, in the desk's words). `other` needs a note. */
export const IPD_CLAIM_DEDUCTION_REASONS = [
  "non_payable_items", "room_rent_cap", "proportionate", "co_pay", "tariff_difference", "over_package", "documents_missing",
  "policy_exclusion", "other",
] as const;
export const IpdClaimDeductionReasonSchema = z.enum(IPD_CLAIM_DEDUCTION_REASONS);
export type IpdClaimDeductionReason = z.infer<typeof IpdClaimDeductionReasonSchema>;

const Text = z.string().trim().min(1).max(1000);
const Ref = z.string().trim().min(1).max(64);

export const recordTpaQuery = ipdIntent({
  input: ipdInput({
    admissionId: IpdIdSchema,
    stage: IpdTpaStageSchema,
    /** Required for stage `claim`: the claim the query is on. */
    claimId: IpdIdSchema.optional(),
    /** When the payer raised it (typed from the portal or the mail): the hospital's clock starts here. */
    raisedAt: IpdInstantSchema,
    queryText: Text,
  }).refine((v) => (v.stage === "claim") === (v.claimId !== undefined), { message: "A claim query names its claim; other stages do not", path: ["claimId"] }),
  output: z.strictObject({ queryId: IpdIdSchema }),
  refusals: ["admission_not_found", "claim_not_found", "time_in_future"],
  actors: ["desk", "billing"],
  copilotProposable: false,
  agentTier: "none",
  undo: "entered_in_error",
  events: ["ipd.tpa.query_recorded"],
  idempotent: true,
});

export const answerTpaQuery = ipdIntent({
  input: ipdInput({
    queryId: IpdIdSchema,
    responseText: Text,
  }),
  output: z.strictObject({ queryId: IpdIdSchema, answeredAt: IpdInstantSchema }),
  refusals: ["query_not_found", "query_already_answered"],
  actors: ["desk", "billing"],
  copilotProposable: false,
  agentTier: "none",
  undo: "entered_in_error",
  events: ["ipd.tpa.query_answered"],
  idempotent: true,
});

export const attachTpaDocument = ipdIntent({
  input: ipdInput({
    admissionId: IpdIdSchema,
    stage: IpdTpaStageSchema,
    kind: IpdTpaDocumentKindSchema,
    /** An ACTIVE document already filed for this patient (patients' documents). */
    patientDocumentId: IpdIdSchema,
    claimId: IpdIdSchema.optional(),
  }),
  output: z.strictObject({ attachmentId: IpdIdSchema }),
  refusals: ["admission_not_found", "tpa_document_invalid", "claim_not_found"],
  actors: ["desk", "billing"],
  copilotProposable: false,
  agentTier: "none",
  undo: "entered_in_error",
  events: ["ipd.tpa.document_attached"],
  idempotent: true,
});

export const selectSchemePackage = ipdIntent({
  input: ipdInput({ admissionId: IpdIdSchema, packageId: IpdIdSchema }),
  output: z.strictObject({
    selectionId: IpdIdSchema,
    /** Σ of the selected packages after the multiple-package rule (100 % / 50 % / 25 %): the payer amount. */
    packageAmountPaise: IpdPaiseSchema,
  }),
  refusals: ["admission_not_found", "admission_wrong_state", "package_needs_scheme", "package_not_found", "package_already_selected", "package_claim_filed"],
  actors: ["desk", "billing"],
  copilotProposable: false,
  agentTier: "none",
  undo: "entered_in_error",
  events: ["ipd.tpa.package_selected"],
  idempotent: true,
});

export const removeSchemePackage = ipdIntent({
  input: ipdInput({ admissionId: IpdIdSchema, selectionId: IpdIdSchema, reason: Text }),
  output: z.strictObject({ packageAmountPaise: IpdPaiseSchema }),
  refusals: ["admission_not_found", "admission_wrong_state", "package_selection_not_found", "package_claim_filed"],
  actors: ["desk", "billing"],
  copilotProposable: false,
  agentTier: "none",
  undo: "entered_in_error",
  events: ["ipd.tpa.package_removed"],
  idempotent: true,
});

export const submitClaim = ipdIntent({
  input: ipdInput({
    claimId: IpdIdSchema,
    /** When it was filed on the portal. */
    submittedAt: IpdInstantSchema,
    /** The payer's claim or TMS number, once the portal gives one. */
    claimRef: Ref.optional(),
    /**
     * Absent = the default: on a scheme stay with packages, what the packages leave unclaimed by the stay's other filed
     * claims (one package is claimed once across a final and supplementary bills); else the bill's payer portion. A typed
     * amount above that refuses `claim_exceeds_claimable`.
     */
    claimedPaise: IpdPositivePaiseSchema.optional(),
  }),
  output: z.strictObject({ claimId: IpdIdSchema, claimedPaise: IpdPositivePaiseSchema }),
  refusals: ["claim_not_found", "claim_wrong_state", "claim_documents_missing", "claim_exceeds_claimable", "time_in_future"],
  actors: ["desk", "billing"],
  copilotProposable: false,
  agentTier: "none",
  undo: "entered_in_error",
  events: ["ipd.tpa.claim_submitted"],
  idempotent: true,
});

export const IpdClaimDeductionSchema = z.strictObject({
  reason: IpdClaimDeductionReasonSchema,
  amountPaise: IpdPositivePaiseSchema,
  note: z.string().trim().min(1).max(200).optional(),
}).refine((d) => d.reason !== "other" || d.note !== undefined, { message: "An `other` deduction says what it is", path: ["note"] });
export type IpdClaimDeduction = z.infer<typeof IpdClaimDeductionSchema>;

export const recordClaimSettlement = ipdIntent({
  input: ipdInput({
    claimId: IpdIdSchema,
    /** Money that reached the bank (the UTR's amount). */
    netPaidPaise: IpdPaiseSchema,
    /** TDS the payer deducted, typed from the settlement advice; never computed (DECIDED $). */
    tdsPaise: IpdPaiseSchema,
    deductions: z.array(IpdClaimDeductionSchema).max(30),
    utrRef: Ref,
    settledOn: z.iso.date(),
  }),
  output: z.strictObject({
    claimId: IpdIdSchema,
    outcome: z.enum(["settled", "short_paid"]),
    deductionsPaise: IpdPaiseSchema,
  }),
  refusals: ["claim_not_found", "claim_wrong_state", "settlement_does_not_add_up"],
  actors: ["billing"],
  copilotProposable: false,
  agentTier: "none",
  undo: "entered_in_error",
  events: ["ipd.tpa.claim_settled"],
  idempotent: true,
});

export const recordClaimRejection = ipdIntent({
  input: ipdInput({ claimId: IpdIdSchema, rejectedAt: IpdInstantSchema, reason: Text }),
  output: z.strictObject({ claimId: IpdIdSchema }),
  refusals: ["claim_not_found", "claim_wrong_state", "time_in_future"],
  actors: ["desk", "billing"],
  copilotProposable: false,
  agentTier: "none",
  undo: "entered_in_error",
  events: ["ipd.tpa.claim_rejected"],
  idempotent: true,
});
