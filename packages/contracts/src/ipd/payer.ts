import { z } from "zod";
import { IpdBedClassSchema } from "../ipd-bed-classes";
import { IpdIdSchema, IpdInstantSchema, IpdPaiseSchema } from "./common";

/**
 * E2.2 (#726) — THE PAYER SPLIT (spec SPEC-ipd-core §2 answer 5, §4.3): every running-bill line is payer-payable or
 * patient-payable, computed on read from the authorisation record, the non-payables list and the room-rent cap. A desk
 * shape: served inside the interim bill (`ipd.bill.view`) — no doctor role holds it (decision 0058). Integer paise.
 */

/** Why (part of) a line is the patient's, or why the payer carries it. */
export const IPD_SPLIT_REASONS = [
  "non_payable", "room_rent_over_cap", "room_rent_cap_proportional", "co_pay", "over_approved_amount", "denied", "cash",
  "auth_pending", "scheme", "reversed",
] as const;
export const IpdSplitReasonSchema = z.enum(IPD_SPLIT_REASONS);
export type IpdSplitReason = z.infer<typeof IpdSplitReasonSchema>;

/** cash: no payer; reimbursement: the patient pays and claims later; insured: cashless insurer or corporate; scheme: PM-JAY/state. */
export const IPD_SPLIT_MODES = ["cash", "reimbursement", "insured", "scheme"] as const;
export const IPD_AUTH_STATES = ["none", "pending", "approved", "denied"] as const;

/** A desk exception the split raises (the bill desk works it). */
export const IPD_SPLIT_EXCEPTIONS = ["cash_consent_missing", "room_rent_cap_unresolved"] as const;
export type IpdSplitException = (typeof IPD_SPLIT_EXCEPTIONS)[number];

const SignedPaise = z.number().int();

export const IpdSplitLineSchema = z.object({
  lineId: IpdIdSchema,
  payerPaise: SignedPaise,
  patientPaise: SignedPaise,
  reasons: z.array(IpdSplitReasonSchema),
});
export type IpdSplitLine = z.infer<typeof IpdSplitLineSchema>;

export const IpdPayerSplitSchema = z.object({
  mode: z.enum(IPD_SPLIT_MODES),
  authState: z.enum(IPD_AUTH_STATES),
  preAuthNumber: z.string().nullable(),
  /** The insurer's approved total (initial + enhancements, or the final figure); null when nothing is approved. */
  approvedTotalPaise: IpdPaiseSchema.nullable(),
  /** The eligible room rent per day, from the letter (absolute, or % of sum insured); null = no cap stated. */
  roomRentCapPaise: IpdPaiseSchema.nullable(),
  coPayBp: z.number().int().nonnegative().nullable(),
  lines: z.array(IpdSplitLineSchema),
  totals: z.object({
    payerPaise: SignedPaise,
    patientPaise: SignedPaise,
    nonPayablePaise: SignedPaise,
    /** Room rent above the cap, plus the proportional deduction on nursing, RMO and visits. */
    capDeductionPaise: SignedPaise,
    coPayPaise: SignedPaise,
    overApprovedPaise: SignedPaise,
  }),
  /** Scheme only: Σ granted non-covered approvals — the only money a scheme patient pays. */
  schemeNonCoveredPaise: IpdPaiseSchema,
  /** The cap deduction and the other deductions in words, one short line each. */
  words: z.array(z.string()),
  exceptions: z.array(z.enum(IPD_SPLIT_EXCEPTIONS)),
});
export type IpdPayerSplit = z.infer<typeof IpdPayerSplitSchema>;

/** Room-rent cap warning before an upgrade consent (spec §4.3 edge case; §4.9 B class cards). */
export const IpdRoomRentCapWarningSchema = z.object({
  targetClass: IpdBedClassSchema,
  capPerDayPaise: IpdPaiseSchema,
  rentPerDayPaise: IpdPaiseSchema,
  /** Rent above the cap, per day: the patient's. */
  overPerDayPaise: IpdPaiseSchema,
  /** The share of nursing, RMO and visits the payer still pays, in basis points (cap / rent). */
  payerShareBp: z.number().int().min(0).max(10_000),
  words: z.string(),
});
export type IpdRoomRentCapWarning = z.infer<typeof IpdRoomRentCapWarningSchema>;

/** A printed interim bill's kept split. */
export const IpdSplitSnapshotSchema = z.object({
  snapshotId: IpdIdSchema,
  printedAt: IpdInstantSchema,
  payerPaise: SignedPaise,
  patientPaise: SignedPaise,
});
export type IpdSplitSnapshot = z.infer<typeof IpdSplitSnapshotSchema>;

export const IpdNonPayableSchema = z.object({
  id: IpdIdSchema,
  matchKind: z.enum(["service", "category"]),
  matchValue: z.string(),
  reason: z.string(),
  createdAt: IpdInstantSchema,
});
export type IpdNonPayable = z.infer<typeof IpdNonPayableSchema>;

export const IpdNonPayableInputSchema = z.strictObject({
  matchKind: z.enum(["service", "category"]),
  matchValue: z.string().trim().min(1).max(64),
  reason: z.string().trim().min(1).max(200),
});

export const IPD_PAYER_ROUTES = {
  printSnapshot: "/ipd/admissions/:id/interim-bill/print",
  capWarning: "/ipd/admissions/:id/room-rent-warning",
  nonPayables: "/ipd/payer/non-payables",
  retireNonPayable: "/ipd/payer/non-payables/:id/retire",
} as const;
