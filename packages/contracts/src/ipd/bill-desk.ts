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
});
export type IpdBillDeskRow = z.infer<typeof IpdBillDeskRowSchema>;

/**
 * #761 — whether the daily totals to the attendant can be sent at all. OFF until config names an approved template
 * (`IPD_DAILY_TOTALS_WHATSAPP_TEMPLATE` and/or `IPD_DAILY_TOTALS_DLT_TEMPLATE_ID`) and the desk phone the message names
 * (`IPD_BILL_DESK_PHONE`); `missing` lists what is not set. `channels` are the ones with an approved id.
 */
export const IpdDailyTotalsSendingSchema = z.object({
  on: z.boolean(),
  channels: z.array(z.enum(["whatsapp", "sms"])),
  missing: z.array(z.string()),
  /** The fixed IST hour the day's message is sent at (DECIDED, #761). */
  sendHourIst: z.number().int().min(0).max(23),
});
export type IpdDailyTotalsSending = z.infer<typeof IpdDailyTotalsSendingSchema>;

/** #761 — one day's message for one admission, as the desk reads it: `words` is the visible line ("Not sent: …"). */
export const IPD_DAILY_TOTALS_STATUSES = ["sent", "waiting", "not_sent"] as const;
export const IpdDailyTotalsLineSchema = z.object({
  admissionId: IpdIdSchema,
  admissionNo: z.string().nullable(),
  billDate: z.string(),
  status: z.enum(IPD_DAILY_TOTALS_STATUSES),
  words: z.string(),
});
export type IpdDailyTotalsLine = z.infer<typeof IpdDailyTotalsLineSchema>;

/** #761 — the bill desk's daily-totals strip: the day the nightly run reported, the switch, the counts, the not-sent lines. */
export const IpdBillDeskDailyTotalsSchema = z.object({
  billDate: z.string(),
  sending: IpdDailyTotalsSendingSchema,
  sent: z.number().int().nonnegative(),
  waiting: z.number().int().nonnegative(),
  notSent: z.array(IpdDailyTotalsLineSchema),
});
export type IpdBillDeskDailyTotals = z.infer<typeof IpdBillDeskDailyTotalsSchema>;

export const IpdBillDeskSchema = z.object({
  asOf: IpdInstantSchema,
  counts: z.record(IpdBillDeskReasonSchema, z.number().int().nonnegative()),
  rows: z.array(IpdBillDeskRowSchema),
  /** The reader may retry a quarantined admission's posting (`ipd.charges.reverse`, the billing manager). */
  canRetry: z.boolean(),
  /** #761 — the daily totals to attendants: sent, waiting and NOT SENT with the reason, never silent. */
  dailyTotals: IpdBillDeskDailyTotalsSchema,
});
export type IpdBillDesk = z.infer<typeof IpdBillDeskSchema>;

/** #761 — record the attendant's consent to the daily totals (the attendant is `attendantOf`; no number is typed). */
export const IpdAttendantConsentSchema = z.strictObject({
  consent: z.strictObject({
    consentedBy: z.string().trim().min(2).max(120),
    relation: z.enum(["self", "spouse", "parent", "child", "sibling", "relative", "guardian", "other"]),
    method: z.enum(["verbal", "paper"]),
  }),
});
export type IpdAttendantConsent = z.infer<typeof IpdAttendantConsentSchema>;

/** #761 — the admission's daily-totals card: who it goes to (masked), consent, stop, and the last day's line. */
export const IpdAttendantMessagesSchema = z.object({
  admissionId: IpdIdSchema,
  attendant: z.object({ kind: z.enum(["guardian", "deposit_payer"]), phoneMasked: z.string() }).nullable(),
  consent: z.object({ consentedBy: z.string(), relation: z.string(), method: z.string(), at: IpdInstantSchema }).nullable(),
  /** A live family link to the same attendant: its consent covers the daily totals too. */
  viaFamilyLink: z.boolean(),
  stoppedAt: IpdInstantSchema.nullable(),
  /** What happens to tomorrow's message, in one word. */
  state: z.enum(["will_send", "not_configured", "no_attendant", "no_consent", "number_changed", "stopped", "blocked"]),
  words: z.string(),
  sending: IpdDailyTotalsSendingSchema,
  last: IpdDailyTotalsLineSchema.nullable(),
  /** The reader may record consent or a stop (`ipd.family.issue`). */
  canManage: z.boolean(),
});
export type IpdAttendantMessages = z.infer<typeof IpdAttendantMessagesSchema>;

export const IPD_BILLDESK_ROUTES = {
  desk: "/ipd/bill-desk",
  retry: "/ipd/admissions/:id/charges/retry",
  attendantMessages: "/ipd/admissions/:id/attendant-messages",
  attendantConsent: "/ipd/admissions/:id/attendant-messages/consent",
  attendantStop: "/ipd/admissions/:id/attendant-messages/stop",
} as const;
