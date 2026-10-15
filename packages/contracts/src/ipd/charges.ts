import { z } from "zod";
import { IPD_RATE_COMPONENTS, IpdBedClassSchema } from "../ipd-bed-classes";
import { IpdAdmissionStateSchema, IpdIdSchema, IpdInstantSchema, IpdPaiseSchema } from "./common";
import { IpdPayerSplitSchema } from "./payer";

/**
 * E2.1 (#725) — THE RUNNING BILL'S READ MODEL (spec SPEC-ipd-core §4.3, §4.9 H). The interim bill is a desk shape:
 * it is served only under `ipd.bill.view`, which no doctor role holds (decision 0058 — a doctor's screen shows no
 * money). Amounts are integer paise; a reversal line carries negative amounts and names the line it reverses.
 */

/** #785: `ipd.order` — a lab or imaging order on a live admission, posted by the ordering door (one line per order item). */
/** ER lane 6 (#813): `ipd.er` — an ER line (registration, physician, observation, procedure, drug) rolled in at admission. */
export const IPD_CHARGE_SOURCES = ["ipd.nightly", "ipd.visit", "ipd.reversal", "ipd.order", "ipd.er"] as const;
export const IpdChargeSourceSchema = z.enum(IPD_CHARGE_SOURCES);
export type IpdChargeSource = z.infer<typeof IpdChargeSourceSchema>;

/**
 * #785 — what a line of the running bill is FOR: the rate card's components (`IPD_RATE_COMPONENTS`, priced per bed class)
 * plus the two order departments, `lab` and `imaging` (priced per service from the tariff; no bed class).
 */
export const IPD_ORDER_COMPONENTS = ["lab", "imaging"] as const;
/** ER lane 6 (#813): `er` — the emergency department's own lines, carried onto the running bill at admission. */
export const IPD_ER_COMPONENTS = ["er"] as const;
export const IPD_CHARGE_COMPONENTS = [...IPD_RATE_COMPONENTS, ...IPD_ORDER_COMPONENTS, ...IPD_ER_COMPONENTS] as const;
export const IpdChargeComponentSchema = z.enum(IPD_CHARGE_COMPONENTS);
export type IpdChargeComponent = z.infer<typeof IpdChargeComponentSchema>;

/** The IST calendar day a charge is for, `YYYY-MM-DD`. */
export const IpdIstDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const SignedPaise = z.number().int();

export const IpdChargeLineViewSchema = z.object({
  id: IpdIdSchema,
  serviceDate: IpdIstDateSchema,
  component: IpdChargeComponentSchema,
  billedClass: IpdBedClassSchema.nullable(),
  serviceCode: z.string(),
  serviceName: z.string(),
  qty: z.number().int().positive(),
  unitPaise: SignedPaise,
  grossPaise: SignedPaise,
  discountPaise: SignedPaise,
  gstPaise: SignedPaise,
  netPaise: SignedPaise,
  source: IpdChargeSourceSchema,
  /** The visiting consultant's display name (visit lines). */
  consultantName: z.string().nullable(),
  reversalOf: IpdIdSchema.nullable(),
  /** True on a line a later reversal cancelled. */
  reversed: z.boolean(),
  reason: z.string().nullable(),
  postedAt: IpdInstantSchema,
});
export type IpdChargeLineView = z.infer<typeof IpdChargeLineViewSchema>;

/** One IST day of the bill: its lines and its total (net, after GST). */
export const IpdBillDaySchema = z.object({
  date: IpdIstDateSchema,
  billedClass: IpdBedClassSchema.nullable(),
  lines: z.array(IpdChargeLineViewSchema),
  totalPaise: SignedPaise,
});
export type IpdBillDay = z.infer<typeof IpdBillDaySchema>;

/** A bed the patient held, with the hour of each move (spec §4.3 "the bill shows the hour of each move"). */
export const IpdBillStaySchema = z.object({
  bedCode: z.string(),
  bedClass: IpdBedClassSchema,
  billedClass: IpdBedClassSchema,
  startedAt: IpdInstantSchema,
  endedAt: IpdInstantSchema.nullable(),
});
export type IpdBillStay = z.infer<typeof IpdBillStaySchema>;

/** A charge not posted. `posting_failed` names no day or component: the whole admission's posting failed (`errorCode`). */
export const IpdChargeExceptionViewSchema = z.object({
  serviceDate: IpdIstDateSchema.nullable(),
  component: IpdChargeComponentSchema.nullable(),
  billedClass: IpdBedClassSchema.nullable(),
  serviceCode: z.string().nullable(),
  reason: z.enum(["rate_missing", "tariff_missing", "posting_failed", "visit_backdated", "order_cancelled_after_bill", "order_cancelled_after_work"]),
  errorCode: z.string().nullable(),
  failCount: z.number().int().nonnegative(),
  firstSeenAt: IpdInstantSchema,
});
export type IpdChargeExceptionView = z.infer<typeof IpdChargeExceptionViewSchema>;

export const IpdInterimBillSchema = z.object({
  admissionId: IpdIdSchema,
  admissionNo: z.string().nullable(),
  state: IpdAdmissionStateSchema,
  patient: z.object({ id: IpdIdSchema, uhid: z.string(), name: z.string().nullable() }),
  admittedAt: IpdInstantSchema.nullable(),
  dischargedAt: IpdInstantSchema.nullable(),
  payerKind: z.string().nullable(),
  tariffVersionNo: z.number().int().nullable(),
  /** Days are posted by the nightly job up to yesterday (IST); today's charges post after midnight. */
  postedThrough: IpdIstDateSchema.nullable(),
  stays: z.array(IpdBillStaySchema),
  days: z.array(IpdBillDaySchema),
  byComponent: z.array(z.object({ component: IpdChargeComponentSchema, netPaise: SignedPaise })),
  totals: z.object({
    grossPaise: SignedPaise,
    discountPaise: SignedPaise,
    gstPaise: SignedPaise,
    netPaise: SignedPaise,
    /** The net rounded once to the rupee (the invoice rounding the final bill will apply). */
    roundedPaise: SignedPaise,
  }),
  /** Deposit receipts for the admission (entered-in-error excepted) minus the patient's advance refunds since the request. */
  depositPaidPaise: IpdPaiseSchema,
  /** Deposit paid minus the rounded total: positive = deposit left, negative = due. */
  balancePaise: SignedPaise,
  exceptions: z.array(IpdChargeExceptionViewSchema),
  /** E2.2 (#726): each line payer- or patient-payable, the cap deduction in words, and the patient's balance. */
  payerSplit: IpdPayerSplitSchema,
  /** Deposit paid minus the patient-payable total rounded to the rupee (E2.2): positive = deposit left. */
  patientBalancePaise: SignedPaise,
});
export type IpdInterimBill = z.infer<typeof IpdInterimBillSchema>;

export const IPD_CHARGE_ROUTES = {
  interimBill: "/ipd/admissions/:id/interim-bill",
} as const;
