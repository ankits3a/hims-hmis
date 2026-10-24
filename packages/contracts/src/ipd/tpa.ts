import { z } from "zod";
import { IpdIdSchema, IpdInstantSchema, IpdPaiseSchema } from "./common";
import {
  IPD_CLAIM_DEDUCTION_REASONS, IpdTpaDocumentKindSchema, IpdTpaStageSchema,
} from "./intents-tpa";

/**
 * #604 (decision 0075) — THE TPA DESK'S READS (SPEC-tpa-desk-2026-10-15): the board, the per-admission panel and the
 * package master. Money desk shapes: `ipd.payer.manage` (front office, its supervisor, the duty manager, the billing
 * manager) — no doctor role holds it (decision 0058). Integer paise; clocks are minutes computed at read time.
 */

/**
 * The ageing clock's due times in minutes (DECIDED: IRDAI health master circular 2024 — a cashless decision within one
 * hour, the final authorisation within three; NHA TMS — a scheme pre-auth within six hours). A row is hot at twice the
 * due time. An open payer query is the hospital's to answer: due in an hour, hot at four.
 */
export const IPD_TPA_SLA_MINUTES = {
  preauth: 60,
  enhancement: 60,
  final: 180,
  scheme_preauth: 360,
  query_due: 60,
  query_hot: 240,
} as const;
/** DECIDED $: an enhancement is due once the claimable reaches this share of the approved total (basis points). */
export const IPD_TPA_ENHANCE_AT_BP = 9_000;
/** DECIDED: a claim with the payer is ageing at 30 days (IRDAI's settlement window) and hot at 60. */
export const IPD_TPA_CLAIM_AGEING_DAYS = 30;
export const IPD_TPA_CLAIM_HOT_DAYS = 60;
/** DECIDED: a settled bill's claim not yet filed is late after 7 days. */
export const IPD_TPA_CLAIM_FILE_DAYS = 7;
/** DECIDED $ (PM-JAY HBP multiple-package rule): highest package 100 %, second 50 %, third onward 25 % (basis points). */
export const IPD_PACKAGE_SHARES_BP = [10_000, 5_000, 2_500] as const;

export const IPD_TPA_ROW_KINDS = ["preauth_waiting", "query_open", "enhancement_due", "claim_to_submit", "claim_with_payer"] as const;
export const IpdTpaRowKindSchema = z.enum(IPD_TPA_ROW_KINDS);
export type IpdTpaRowKind = z.infer<typeof IpdTpaRowKindSchema>;

export const IpdTpaBoardRowSchema = z.object({
  /** `<kind>:<admission or claim or query id>` — stable. */
  id: z.string(),
  kind: IpdTpaRowKindSchema,
  admissionId: IpdIdSchema,
  admissionNo: z.string().nullable(),
  /** Name, alias for a restricted patient, or "Sealed patient". */
  patientName: z.string(),
  payerKind: z.string().nullable(),
  preAuthNumber: z.string().nullable(),
  stage: IpdTpaStageSchema.nullable(),
  claimId: IpdIdSchema.nullable(),
  queryId: IpdIdSchema.nullable(),
  since: IpdInstantSchema,
  waitMinutes: z.number().int().nonnegative(),
  dueMinutes: z.number().int().nonnegative(),
  severity: z.enum(["ok", "warn", "hot"]),
  approvedTotalPaise: IpdPaiseSchema.nullable(),
  /** enhancement_due: the payer share the bill has reached (incl. what the approval holds back). */
  claimablePaise: IpdPaiseSchema.nullable(),
  /** claim rows: the amount claimed (or, before filing, the default that will be claimed). */
  claimedPaise: IpdPaiseSchema.nullable(),
});
export type IpdTpaBoardRow = z.infer<typeof IpdTpaBoardRowSchema>;

export const IpdTpaBoardSchema = z.object({
  asOf: IpdInstantSchema,
  rows: z.array(IpdTpaBoardRowSchema),
  counts: z.record(IpdTpaRowKindSchema, z.number().int().nonnegative()),
});
export type IpdTpaBoard = z.infer<typeof IpdTpaBoardSchema>;

export const IpdTpaAuthEntrySchema = z.object({
  id: IpdIdSchema,
  entry: z.string(),
  status: z.string(),
  preAuthNumber: z.string().nullable(),
  approvedAmountPaise: IpdPaiseSchema.nullable(),
  approvedTotalPaise: IpdPaiseSchema,
  recordedAt: IpdInstantSchema,
});

export const IpdTpaQuerySchema = z.object({
  id: IpdIdSchema,
  stage: IpdTpaStageSchema,
  claimId: IpdIdSchema.nullable(),
  raisedAt: IpdInstantSchema,
  queryText: z.string(),
  answeredAt: IpdInstantSchema.nullable(),
  responseText: z.string().nullable(),
  waitMinutes: z.number().int().nonnegative(),
});
export type IpdTpaQuery = z.infer<typeof IpdTpaQuerySchema>;

export const IpdTpaDocumentSchema = z.object({
  id: IpdIdSchema,
  stage: IpdTpaStageSchema,
  kind: IpdTpaDocumentKindSchema,
  patientDocumentId: IpdIdSchema,
  claimId: IpdIdSchema.nullable(),
  attachedAt: IpdInstantSchema,
});

export const IpdAdmissionPackageSchema = z.object({
  id: IpdIdSchema,
  code: z.string(),
  name: z.string(),
  ratePaise: IpdPaiseSchema,
  shareBp: z.number().int(),
  amountPaise: IpdPaiseSchema,
});
export type IpdAdmissionPackage = z.infer<typeof IpdAdmissionPackageSchema>;

export const IpdClaimDeductionRowSchema = z.object({
  reason: z.enum(IPD_CLAIM_DEDUCTION_REASONS),
  amountPaise: IpdPaiseSchema,
  note: z.string().nullable(),
});

export const IPD_CLAIM_STATES = ["to_submit", "with_payer", "settled", "short_paid", "rejected", "withdrawn"] as const;
export const IpdClaimStateSchema = z.enum(IPD_CLAIM_STATES);
export type IpdClaimState = z.infer<typeof IpdClaimStateSchema>;

/** One claim and its reconciliation against the bill (all on read). */
export const IpdTpaClaimSchema = z.object({
  id: IpdIdSchema,
  finalBillId: IpdIdSchema,
  state: IpdClaimStateSchema,
  claimRef: z.string().nullable(),
  submittedAt: IpdInstantSchema.nullable(),
  /** Days with the payer since the latest submission (null before filing, after settlement or rejection). */
  ageDays: z.number().int().nonnegative().nullable(),
  /** The bill's payer portion (the claim row). */
  billPayerPaise: IpdPaiseSchema,
  claimedPaise: IpdPaiseSchema.nullable(),
  /** The default a submission will claim: Σ scheme packages when chosen, else the bill's payer portion. */
  defaultClaimPaise: IpdPaiseSchema,
  netPaidPaise: IpdPaiseSchema.nullable(),
  tdsPaise: IpdPaiseSchema.nullable(),
  utrRef: z.string().nullable(),
  settledOn: z.string().nullable(),
  deductions: z.array(IpdClaimDeductionRowSchema),
  deductionsPaise: IpdPaiseSchema,
  /** Bill payer portion − claimed: for a scheme package, what the hospital absorbs over the package. Signed. */
  packageVariancePaise: z.number().int().nullable(),
  /** Claimed − (net + TDS + deductions) after a settlement; 0 when it reconciles. Signed. */
  unexplainedPaise: z.number().int().nullable(),
  rejectionReason: z.string().nullable(),
  missingDocuments: z.array(IpdTpaDocumentKindSchema),
});
export type IpdTpaClaim = z.infer<typeof IpdTpaClaimSchema>;

export const IpdTpaPanelSchema = z.object({
  admissionId: IpdIdSchema,
  admissionNo: z.string().nullable(),
  payerKind: z.string().nullable(),
  isScheme: z.boolean(),
  preAuthNumber: z.string().nullable(),
  approvedTotalPaise: IpdPaiseSchema.nullable(),
  /** The current authorisation's waiting request, if any: its stage and how long. */
  waiting: z.object({ stage: IpdTpaStageSchema, since: IpdInstantSchema, waitMinutes: z.number().int().nonnegative(), dueMinutes: z.number().int() }).nullable(),
  enhancementDue: z.boolean(),
  claimablePaise: IpdPaiseSchema.nullable(),
  auths: z.array(IpdTpaAuthEntrySchema),
  queries: z.array(IpdTpaQuerySchema),
  documents: z.array(IpdTpaDocumentSchema),
  packages: z.array(IpdAdmissionPackageSchema),
  /** Σ packages after the multiple-package rule: the scheme's payer amount. */
  packageAmountPaise: IpdPaiseSchema,
  claims: z.array(IpdTpaClaimSchema),
});
export type IpdTpaPanel = z.infer<typeof IpdTpaPanelSchema>;

export const IpdSchemePackageSchema = z.object({
  id: IpdIdSchema,
  scheme: z.enum(["pmjay", "state_scheme"]),
  code: z.string(),
  name: z.string(),
  specialty: z.string(),
  kind: z.enum(["surgical", "medical", "day_care"]),
  ratePaise: IpdPaiseSchema,
  preauthRequired: z.boolean(),
});
export type IpdSchemePackage = z.infer<typeof IpdSchemePackageSchema>;

export const IpdPackageImportInputSchema = z.strictObject({
  scheme: z.enum(["pmjay", "state_scheme"]),
  csv: z.string().min(1).max(5_000_000),
  /** Dry run unless `apply` is true. */
  apply: z.boolean(),
});

export const IpdPackageImportResultSchema = z.object({
  applied: z.boolean(),
  batch: z.string(),
  rows: z.number().int().nonnegative(),
  added: z.number().int().nonnegative(),
  changed: z.number().int().nonnegative(),
  unchanged: z.number().int().nonnegative(),
});
export type IpdPackageImportResult = z.infer<typeof IpdPackageImportResultSchema>;

export const IPD_TPA_ROUTES = {
  board: "/ipd/tpa/board",
  panel: "/ipd/admissions/:id/tpa",
  packages: "/ipd/tpa/packages",
  importPackages: "/ipd/tpa/packages/import",
  recordQuery: "/ipd/tpa/queries",
  answerQuery: "/ipd/tpa/queries/:id/answer",
  attachDocument: "/ipd/tpa/documents",
  selectPackage: "/ipd/admissions/:id/packages",
  removePackage: "/ipd/admissions/:id/packages/:selectionId/remove",
  submitClaim: "/ipd/tpa/claims/:id/submit",
  settleClaim: "/ipd/tpa/claims/:id/settle",
  rejectClaim: "/ipd/tpa/claims/:id/reject",
} as const;
