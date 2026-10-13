import { z } from "zod";
import { IpdBedClassSchema } from "../ipd-bed-classes";
import { IpdAdmissionStateSchema, IpdIdSchema, IpdInstantSchema, IpdPaiseSchema } from "./common";
import { IpdPayerKindSchema } from "./intents-admit";

/**
 * E2.3 (#727) — THE BILL DESK (spec SPEC-ipd-core §4.3 deposit ladder, §4.9 H). EXCEPTIONS ONLY: an admission appears
 * when something needs the desk — the deposit ladder fired (75 % / 90 % of the deposit used by the patient-payable bill),
 * a day could not be posted (rate missing, tariff missing, posting failed), a downtime deposit is unchecked, a denied
 * claim waits for the cash consent, an authorisation has waited over 24 hours, an ICU-class stay has a day or less of
 * deposit left, or a patient whose discharge is under way still owes. A normal running bill makes no row.
 *
 * Served under `ipd.billdesk.view` (cashier, billing manager, front-office supervisor, duty manager, owner) — never a
 * doctor (decision 0058). Amounts are integer paise.
 */

export const IPD_BILLDESK_REASONS = [
  "deposit_90", "deposit_75", "icu_low_days", "posting_failed", "rate_missing", "tariff_missing", "deposit_check_pending",
  "cash_consent_missing", "auth_pending_24h", "discharge_balance",
  // E4.2 review (#734): a round backdated past yesterday 10:00 IST — recorded, not charged; billing reviews it.
  "visit_backdated",
] as const;
export const IpdBillDeskReasonSchema = z.enum(IPD_BILLDESK_REASONS);
export type IpdBillDeskReason = z.infer<typeof IpdBillDeskReasonSchema>;

/** ICU, HDU, NICU and PICU stays: the average patient-payable charge of the last three posted days, recomputed nightly. */
export const IpdIcuBurnSchema = z.object({
  perDayPaise: IpdPaiseSchema,
  /** The posted days the average is over (1–3). */
  days: z.number().int().min(1).max(3),
  /** Whole days the deposit still held covers at that rate (deposit − patient payable) ÷ per day, floored; null at ₹0/day. */
  daysLeft: z.number().int().nullable(),
});
export type IpdIcuBurn = z.infer<typeof IpdIcuBurnSchema>;

export const IpdBillDeskRowSchema = z.object({
  admissionId: IpdIdSchema,
  admissionNo: z.string().nullable(),
  state: IpdAdmissionStateSchema,
  /** The alias for a restricted patient. */
  patient: z.object({ id: IpdIdSchema, uhid: z.string(), name: z.string().nullable() }),
  bedCode: z.string().nullable(),
  billedClass: IpdBedClassSchema.nullable(),
  payerKind: IpdPayerKindSchema.nullable(),
  reasons: z.array(IpdBillDeskReasonSchema).min(1),
  /** Patient-payable ÷ deposit held, in basis points; null when nothing is payable and nothing is held. */
  usedBp: z.number().int().nonnegative().nullable(),
  patientPayablePaise: z.number().int(),
  depositHeldPaise: IpdPaiseSchema,
  /** Deposit held − the patient-payable total rounded to the rupee (negative = the patient owes). */
  balancePaise: z.number().int(),
  icuBurn: IpdIcuBurnSchema.nullable(),
  /** The oldest open fact behind the row (alert fired, exception first seen, request recorded). */
  since: IpdInstantSchema.nullable(),
  /** E4.2 (#734): rounds entered too late to charge — billing charges or waives each, with a reason. */
  backdatedVisits: z.array(z.object({
    exceptionId: z.string(), serviceDate: z.string(), consultantName: z.string(),
  })).optional(),
});
export type IpdBillDeskRow = z.infer<typeof IpdBillDeskRowSchema>;

export const IpdBillDeskSchema = z.object({
  asOf: IpdInstantSchema,
  counts: z.record(IpdBillDeskReasonSchema, z.number().int().nonnegative()),
  rows: z.array(IpdBillDeskRowSchema),
  /** The reader may retry a quarantined admission's posting (`ipd.charges.reverse`, the billing manager). */
  canRetry: z.boolean(),
});
export type IpdBillDesk = z.infer<typeof IpdBillDeskSchema>;

export const IPD_BILLDESK_ROUTES = {
  desk: "/ipd/bill-desk",
  retry: "/ipd/admissions/:id/charges/retry",
  backdatedVisit: "/ipd/charge-exceptions/backdated-visit",
} as const;
