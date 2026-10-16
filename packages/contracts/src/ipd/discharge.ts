import { z } from "zod";
import { IpdAdmissionStateSchema, IpdIdSchema, IpdIdempotencyKeySchema, IpdInstantSchema, IpdPaiseSchema } from "./common";
import { IpdCopilotRecordSchema, IpdCopilotSourceSchema, IpdDraftProvenanceSchema, IpdDraftStampSchema, IpdMedicineFlagSchema } from "./copilot";
import { IPD_DISCHARGE_DEPARTMENTS } from "./intents-discharge";

/**
 * E3.2 (#730) — THE DISCHARGE SURFACES' read models and the summary's shape (spec SPEC-ipd-core §4.7, §4.9 F).
 *
 * The desk tracker shows each admission's steps with clocks (fit → departments → summary → bill → gate pass) and names
 * the blocker. Money rides ONLY in `bill`, which the server fills for a viewer holding `ipd.bill.view` and leaves null
 * for anyone else — a doctor reads the steps, never a rupee (decision 0058).
 */

const SignedPaise = z.number().int();

// ═══════════════════════════════════════ the structured summary ═══════════════════════════════════════

const Text = (max: number) => z.string().trim().max(max);

export const IpdSummaryMedicineSchema = z.strictObject({
  name: z.string().trim().min(1).max(160),
  dose: Text(80).optional(),
  frequency: Text(80).optional(),
  duration: Text(80).optional(),
  /** `typed` = the doctor's own typing; `order` = copied from an active drug order by the drafter (E5.4), with `orderId`. */
  source: z.enum(["typed", "order"]).default("typed"),
  /** E5.4 — the active drug order a drafted row was copied from; a row that names one must still match it at signing. */
  orderId: IpdIdSchema.optional(),
});
export type IpdSummaryMedicine = z.infer<typeof IpdSummaryMedicineSchema>;

/** The template (spec §4.7): every field a reader of a discharge summary looks for, in that order. */
export const IpdSummaryContentSchema = z.strictObject({
  diagnosis: z.strictObject({
    text: z.string().trim().min(1).max(500),
    /** From the ICD-10 catalogue when chosen (checked to exist); free text otherwise. */
    icd10Code: z.string().trim().min(1).max(16).optional(),
  }),
  course: Text(4000).default(""),
  procedures: Text(2000).default(""),
  conditionAtDischarge: Text(500).default(""),
  medicines: z.array(IpdSummaryMedicineSchema).max(40).default([]),
  followUp: Text(500).default(""),
  advice: Text(2000).default(""),
  warningSigns: Text(1000).default(""),
  /** Results still awaited (histopathology, cultures): listed on the summary (§4.7). */
  pendingResults: Text(1000).default(""),
  /**
   * E5.4 — WRITTEN BY THE SERVER, never taken from a client (a save strips them): the medicines no active order carried
   * when the summary was signed, the doctor's reason for signing with them, and the fingerprint of the stay's records
   * the text was last saved against.
   */
  medicineFlags: z.array(IpdMedicineFlagSchema).max(60).optional(),
  medicineAck: z.strictObject({ reason: Text(500), by: z.strictObject({ id: z.string(), name: z.string() }), at: IpdInstantSchema }).optional(),
  recordsHash: z.string().max(64).optional(),
});
export type IpdSummaryContent = z.infer<typeof IpdSummaryContentSchema>;

/** Save (create or replace) the draft. `expectedVersion` is the version the doctor opened; a newer one refuses. */
export const IpdSaveSummaryDraftSchema = z.strictObject({
  idempotencyKey: IpdIdempotencyKeySchema,
  admissionId: IpdIdSchema,
  expectedVersion: z.number().int().nonnegative(),
  content: IpdSummaryContentSchema,
  /** E5.4 — the copilot draft this text was started from: the server stamps its model id and prompt version on the summary. */
  draftId: IpdIdSchema.optional(),
});

export const IpdSummaryViewSchema = z.object({
  summaryId: IpdIdSchema,
  admissionId: IpdIdSchema,
  status: z.enum(["draft", "awaiting_cosign", "signed"]),
  version: z.number().int().positive(),
  content: IpdSummaryContentSchema,
  /** §0B provenance: who or what drafted it; the copilot drafter (M5) fills the model fields. */
  provenance: z.object({
    source: z.enum(["person", "copilot_draft"]),
    draftModelId: z.string().nullable(),
    draftPromptVersion: z.string().nullable(),
    draftedBy: z.object({ id: z.string(), name: z.string() }),
    draftedAt: IpdInstantSchema,
    /** E5.4 — the copilot draft the text was started from (kept on the signed copy); null for a typed summary. */
    draft: IpdDraftProvenanceSchema.nullable(),
  }),
  /** E5.4 — medicines no active order of the stay carries (a typed row is flagged; a drafted row refuses the signature). */
  medicineFlags: z.array(IpdMedicineFlagSchema),
  /** E5.4 — the "Draft" stamp, present whenever the summary is unsigned and started from a copilot draft (screen and print). */
  stamp: IpdDraftStampSchema.nullable(),
  /** "Draft" until a named consultant signs. */
  label: z.enum(["Draft", "Awaiting co-sign", "Signed"]),
  residentSignedBy: z.object({ id: z.string(), name: z.string() }).nullable(),
  signedBy: z.object({ id: z.string(), name: z.string() }).nullable(),
  signedAt: IpdInstantSchema.nullable(),
  documentId: IpdIdSchema.nullable(),
});
export type IpdSummaryView = z.infer<typeof IpdSummaryViewSchema>;

export const IpdDischargeDraftSchema = z.object({
  draftId: IpdIdSchema,
  admissionId: IpdIdSchema,
  stamp: IpdDraftStampSchema,
  /** The proposed summary: diagnosis, results and medicines from the record; only `course` may hold model words. */
  content: IpdSummaryContentSchema,
  /** One source per filled field of `content`. */
  sources: z.array(z.object({ field: z.string(), source: IpdCopilotSourceSchema, records: z.array(IpdCopilotRecordSchema) })),
  flags: z.array(IpdMedicineFlagSchema),
  /** Lists cut at the read's limit (newest kept), e.g. `orders`. A truncated draft is never `complete`. */
  truncated: z.array(z.string()),
  complete: z.boolean(),
});
export type IpdDischargeDraft = z.infer<typeof IpdDischargeDraftSchema>;

// ═══════════════════════════════════════ the final bill ═══════════════════════════════════════

export const IpdFinalBillLineSchema = z.object({
  lineId: IpdIdSchema,
  serviceDate: z.string(),
  serviceName: z.string(),
  component: z.string(),
  qty: z.number().int(),
  netPaise: SignedPaise,
  payerPaise: SignedPaise,
  patientPaise: SignedPaise,
});

/** The composed (not yet settled) final bill: the cashier reads `billVersion` and settles against it. */
export const IpdFinalBillSchema = z.object({
  admissionId: IpdIdSchema,
  admissionNo: z.string().nullable(),
  billVersion: z.number().int().nonnegative(),
  lines: z.array(IpdFinalBillLineSchema),
  /** Σ the non-reversed lines' net, before rounding. */
  totalPaise: SignedPaise,
  payerPaise: SignedPaise,
  patientPaise: SignedPaise,
  /** The patient portion rounded to the rupee once (billing's invoice rule). */
  patientRoundedPaise: SignedPaise,
  depositHeldPaise: IpdPaiseSchema,
  /** Positive: the patient pays this; negative: the excess deposit comes back. */
  balancePaise: SignedPaise,
  payerKind: z.string().nullable(),
  settled: z.object({
    billNo: z.string().nullable(),
    settlement: z.enum(["paid", "refund_due", "dues_recorded", "insurer_pending_undertaking"]),
    paidPaise: IpdPaiseSchema,
    refundPaise: IpdPaiseSchema,
    /** E3.2 review: `refund_pending` until billing issues the refund voucher. */
    refundState: z.enum(["none", "refund_pending", "refund_issued"]),
    duesPaise: IpdPaiseSchema,
    /** E3.2 review ⚖: dues are recorded at once; the approval is a ledger step after the exit. */
    duesApproved: z.boolean(),
    settledAt: IpdInstantSchema,
  }).nullable(),
  /** The bill desk's open questions on this bill (see `IPD_BILL_DESK_EXCEPTIONS`). */
  exceptions: z.array(z.enum(["settled_not_exited", "ended_after_bill", "dues_awaiting_approval", "refund_pending", "supplementary_owed"])),
});

/**
 * E3.2 review — what the bill desk must still do about a settled bill. #763: `supplementary_owed` — charges posted after the
 * live bills (another night, services) wait for a supplementary bill.
 */
export const IPD_BILL_DESK_EXCEPTIONS = ["settled_not_exited", "ended_after_bill", "dues_awaiting_approval", "refund_pending", "supplementary_owed"] as const;

/** #763 — one settled bill of an admission: the final bill (seq 0) or a supplementary bill (seq 1, 2…). */
export const IpdSettledBillSchema = z.object({
  billId: IpdIdSchema,
  kind: z.enum(["final", "supplementary"]),
  seq: z.number().int().nonnegative(),
  billNo: z.string().nullable(),
  totalPaise: IpdPaiseSchema,
  patientPaise: IpdPaiseSchema,
  duesPaise: IpdPaiseSchema,
  refundPaise: IpdPaiseSchema,
  settledAt: IpdInstantSchema,
  /** The void asked for this bill: the approval and its state (null when none was asked). */
  voidApproval: z.object({ approvalId: IpdIdSchema, status: z.enum(["pending", "granted", "rejected"]) }).nullable(),
});
export type IpdSettledBill = z.infer<typeof IpdSettledBillSchema>;

export const IpdDischargeBillDeskSchema = z.object({
  rows: z.array(z.object({
    admissionId: IpdIdSchema,
    admissionNo: z.string().nullable(),
    state: IpdAdmissionStateSchema,
    billNo: z.string().nullable(),
    duesPaise: IpdPaiseSchema,
    refundPaise: IpdPaiseSchema,
    settledAt: IpdInstantSchema,
    exceptions: z.array(z.enum(IPD_BILL_DESK_EXCEPTIONS)),
    /** #763 — the admission's LIVE bills, final first; the newest is the one a void may take. */
    bills: z.array(IpdSettledBillSchema),
  })),
});

/** #763 — ask billing's approval to void a settled bill (`ipd_bill_void`; the approver is never the requester). */
export const IpdAskBillVoidSchema = z.strictObject({
  admissionId: IpdIdSchema,
  billId: IpdIdSchema,
  reason: z.string().trim().min(1).max(500),
});

/** #763 — void a settled bill with its GRANTED approval: credit note, claim withdrawn, refund request cancelled, running bill reopened. */
export const IpdVoidBillSchema = z.strictObject({
  idempotencyKey: IpdIdempotencyKeySchema,
  admissionId: IpdIdSchema,
  billId: IpdIdSchema,
  approvalId: IpdIdSchema,
  reason: z.string().trim().min(1).max(500),
});
export type IpdDischargeBillDesk = z.infer<typeof IpdDischargeBillDeskSchema>;
export type IpdFinalBill = z.infer<typeof IpdFinalBillSchema>;

// ═══════════════════════════════════════ the desk tracker ═══════════════════════════════════════

export const IPD_DISCHARGE_STEPS = ["fit", "departments", "summary", "bill", "gate_pass", "exit"] as const;
export type IpdDischargeStep = (typeof IPD_DISCHARGE_STEPS)[number];

export const IpdDischargeStepSchema = z.object({
  key: z.enum(IPD_DISCHARGE_STEPS),
  state: z.enum(["done", "now", "waiting", "skipped"]),
  at: IpdInstantSchema.nullable(),
  /** Whom the step waits for, in words ("Pharmacy, Billing"; "Dr Rao"). Null when done or not reached. */
  waitingFor: z.string().nullable(),
});

export const IpdDischargeTrackerSchema = z.object({
  admissionId: IpdIdSchema,
  admissionNo: z.string().nullable(),
  state: IpdAdmissionStateSchema,
  patient: z.object({ id: IpdIdSchema, uhid: z.string(), name: z.string().nullable(), ageSex: z.string() }),
  bedCode: z.string().nullable(),
  wardName: z.string().nullable(),
  consultant: z.object({ id: z.string(), name: z.string() }),
  disposition: z.enum(["home", "transfer_out"]).nullable(),
  fitAt: IpdInstantSchema.nullable(),
  targetAt: IpdInstantSchema.nullable(),
  steps: z.array(IpdDischargeStepSchema),
  departments: z.array(z.object({
    department: z.enum(IPD_DISCHARGE_DEPARTMENTS),
    basis: z.enum(["lines", "open_orders", "always"]),
    confirmedAt: IpdInstantSchema.nullable(),
    confirmedBy: z.string().nullable(),
  })),
  summary: z.object({ status: z.enum(["none", "draft", "awaiting_cosign", "signed"]), signedBy: z.string().nullable(), version: z.number().int() }),
  gatePass: z.object({
    code: z.string(), status: z.enum(["issued", "used", "void"]), kind: z.enum(["discharge", "transfer_out"]),
    /** Null for a viewer without money (0058). */
    duesRecorded: z.boolean().nullable(), issuedAt: IpdInstantSchema, scannedAt: IpdInstantSchema.nullable(),
    receivingHospital: z.string().nullable(),
  }).nullable(),
  /** The ending, when the stay ended another way (LAMA / DAMA, absconded, death). */
  exit: z.object({ kind: z.enum(["lama", "dama", "absconded", "deceased"]), at: IpdInstantSchema }).nullable(),
  /** The blocker in words when the next act would be refused ("Waiting: Pharmacy, Billing"). */
  blocker: z.string().nullable(),
  /** Money: filled for `ipd.bill.view` holders only; null for every other viewer (0058). */
  bill: IpdFinalBillSchema.nullable(),
  /** What the viewer may do next (the screen shows only these buttons). */
  can: z.object({
    declareFit: z.boolean(), cancelFit: z.boolean(), confirm: z.array(z.enum(IPD_DISCHARGE_DEPARTMENTS)), editSummary: z.boolean(),
    signSummary: z.boolean(), settle: z.boolean(), issueGatePass: z.boolean(), scan: z.boolean(), exit: z.boolean(),
  }),
});
export type IpdDischargeTracker = z.infer<typeof IpdDischargeTrackerSchema>;

/** The desk list: every admission in the discharge cascade, plus the stays ended today. */
export const IpdDischargeBoardSchema = z.object({
  rows: z.array(z.object({
    admissionId: IpdIdSchema,
    admissionNo: z.string().nullable(),
    state: IpdAdmissionStateSchema,
    patientName: z.string().nullable(),
    uhid: z.string(),
    bedCode: z.string().nullable(),
    fitAt: IpdInstantSchema.nullable(),
    targetAt: IpdInstantSchema.nullable(),
    nextStep: z.enum(IPD_DISCHARGE_STEPS).nullable(),
    blocker: z.string().nullable(),
  })),
});
export type IpdDischargeBoard = z.infer<typeof IpdDischargeBoardSchema>;

// ═══════════════════════════════════════ the mortuary register ═══════════════════════════════════════

export const IpdMortuaryEntrySchema = z.object({
  id: IpdIdSchema,
  /** The holder: an IPD admission, or (ER lane 4, #811) an ER episode for a body brought dead — exactly one is set. */
  admissionId: IpdIdSchema.nullable(),
  admissionNo: z.string().nullable(),
  erEpisodeId: IpdIdSchema.nullable(),
  erEpisodeNo: z.string().nullable(),
  patientName: z.string().nullable(),
  uhid: z.string(),
  status: z.enum(["expected", "received", "released"]),
  diedAt: IpdInstantSchema,
  mlc: z.boolean(),
  receivedAt: IpdInstantSchema.nullable(),
  policeClearance: z.boolean(),
  releasedTo: z.object({ name: z.string(), relation: z.string(), idProofRef: z.string() }).nullable(),
  releasedAt: IpdInstantSchema.nullable(),
});
export type IpdMortuaryEntry = z.infer<typeof IpdMortuaryEntrySchema>;

export const IpdReceiveBodySchema = z.strictObject({
  idempotencyKey: IpdIdempotencyKeySchema,
  entryId: IpdIdSchema,
  /** The second person of the two-person identity check (a user id; never the receiver). */
  identityCheckedBy: z.string().min(1).max(64),
});

export const IpdPoliceClearanceSchema = z.strictObject({
  idempotencyKey: IpdIdempotencyKeySchema,
  entryId: IpdIdSchema,
  ref: z.string().trim().min(1).max(64),
});

export const IpdReleaseBodySchema = z.strictObject({
  idempotencyKey: IpdIdempotencyKeySchema,
  entryId: IpdIdSchema,
  releasedTo: z.strictObject({
    name: z.string().trim().min(1).max(120),
    relation: z.string().trim().min(1).max(60),
    idProofRef: z.string().trim().min(1).max(64),
  }),
});

export const IpdPrepareFinalBillSchema = z.strictObject({ admissionId: IpdIdSchema });

export const IPD_DISCHARGE_ROUTES = {
  board: "/ipd/discharge/board",
  tracker: "/ipd/discharge/:admissionId",
  declareFit: "/ipd/discharge/declare-fit",
  cancelFit: "/ipd/discharge/cancel-fit",
  confirm: "/ipd/discharge/confirm",
  summary: "/ipd/discharge/:admissionId/summary",
  saveSummary: "/ipd/discharge/summary",
  signSummary: "/ipd/discharge/summary/sign",
  prepareBill: "/ipd/discharge/bill/prepare",
  finalBill: "/ipd/discharge/:admissionId/bill",
  settle: "/ipd/discharge/bill/settle",
  askDues: "/ipd/discharge/bill/ask-dues",
  duesApproval: "/ipd/discharge/bill/dues-approval",
  billDesk: "/ipd/discharge/bill-desk",
  supplementaryPrepare: "/ipd/discharge/bill/supplementary/prepare",
  supplementarySettle: "/ipd/discharge/bill/supplementary/settle",
  askVoid: "/ipd/discharge/bill/void/ask",
  voidBill: "/ipd/discharge/bill/void",
  issueGatePass: "/ipd/discharge/gate-pass",
  scanGatePass: "/ipd/discharge/gate-pass/scan",
  lama: "/ipd/discharge/lama",
  abscond: "/ipd/discharge/abscond",
  death: "/ipd/discharge/death",
  mortuary: "/ipd/mortuary",
  mortuaryReceive: "/ipd/mortuary/receive",
  mortuaryClearance: "/ipd/mortuary/police-clearance",
  mortuaryRelease: "/ipd/mortuary/release",
} as const;

export { IPD_DISCHARGE_DEPARTMENTS } from "./intents-discharge";
export type { IpdDischargeDepartment } from "./intents-discharge";
