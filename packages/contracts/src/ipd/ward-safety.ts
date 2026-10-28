import { z } from "zod";
import { IpdIdSchema, IpdInstantSchema, IpdNoteSchema, ipdInput } from "./common";

/**
 * WM-2 (#983, decisions 0089 and 0091) — WARD SAFETY, STOCK AND QUALITY: the daily Morse / Braden safety round and its
 * care plans with timed checks, restraints on a doctor's order, lines and their line-days, the crash cart and its seal,
 * the ward's narcotic keys, ward stock against par (one indent to stores, expiring lots, charging per 0089 / 0091), the
 * student and agency limits, and the ward's monthly quality read. Module acts with their own contracts (like WM-1).
 *
 * Instants are ISO with offset; a month is `YYYY-MM` in IST.
 */

export const IpdMonthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "a month YYYY-MM");

// ═══════════════════════════════════════════ the safety round (pure) ═══════════════════════════════════════════

/** Morse at or above this, or Braden at or below that, starts a care plan (spec #983; editable per ward). */
export const IPD_SAFETY_THRESHOLDS = { morse: 45, braden: 12 } as const;
export const IPD_CARE_PLAN_KINDS = ["fall", "pressure"] as const;
export type IpdCarePlanKind = (typeof IPD_CARE_PLAN_KINDS)[number];
/** Minutes between timed checks: the fall bundle every 4 hours, pressure-area turns every 2 hours (DECIDED). */
export const IPD_CARE_CHECK_MINUTES: Record<IpdCarePlanKind, number> = { fall: 240, pressure: 120 };

/** The ward's thresholds: its `safetyThresholds` attribute when set and sane, else the spec's. */
export function safetyThresholdsOf(attrs: { safetyThresholds?: unknown } | null | undefined): { morse: number; braden: number } {
  const t = attrs?.safetyThresholds as { morse?: unknown; braden?: unknown } | undefined;
  const morse = typeof t?.morse === "number" && Number.isInteger(t.morse) && t.morse >= 0 && t.morse <= 125 ? t.morse : IPD_SAFETY_THRESHOLDS.morse;
  const braden = typeof t?.braden === "number" && Number.isInteger(t.braden) && t.braden >= 6 && t.braden <= 23 ? t.braden : IPD_SAFETY_THRESHOLDS.braden;
  return { morse, braden };
}

/** Which care plans a pair of scores calls for. */
export function carePlansFor(morse: number, braden: number, th: { morse: number; braden: number } = IPD_SAFETY_THRESHOLDS): IpdCarePlanKind[] {
  const out: IpdCarePlanKind[] = [];
  if (morse >= th.morse) out.push("fall");
  if (braden <= th.braden) out.push("pressure");
  return out;
}

export const IpdRecordRiskScoreInputSchema = ipdInput({
  admissionId: IpdIdSchema,
  morse: z.number().int().min(0).max(125),
  braden: z.number().int().min(6).max(23),
});

export const IpdRecordCareCheckInputSchema = ipdInput({
  planId: IpdIdSchema,
  note: IpdNoteSchema.optional(),
});

// ═══════════════════════════════════════════ restraint ═══════════════════════════════════════════

export const IPD_RESTRAINT_KINDS = ["physical", "chemical", "seclusion"] as const;
/** Checks every 2 hours; the order lapses 24 hours after the doctor's last sign. */
export const IPD_RESTRAINT_CHECK_MINUTES = 120;
export const IPD_RESTRAINT_REVIEW_HOURS = 24;
/** MHCA 2017 s.97: on a psychiatric ward the nominated representative is told within 24 hours. */
export const IPD_RESTRAINT_REPRESENTATIVE_HOURS = 24;

export const IpdOrderRestraintInputSchema = ipdInput({
  admissionId: IpdIdSchema,
  kind: z.enum(IPD_RESTRAINT_KINDS),
  reason: IpdNoteSchema,
});
export const IpdRestraintRefInputSchema = ipdInput({ restraintId: IpdIdSchema });
export const IpdRestraintCheckInputSchema = ipdInput({
  restraintId: IpdIdSchema,
  circulation: z.boolean(),
  skin: z.boolean(),
  hydration: z.boolean(),
  toileting: z.boolean(),
  note: IpdNoteSchema.optional(),
});
export const IpdReviewRestraintInputSchema = ipdInput({
  restraintId: IpdIdSchema,
  decision: z.enum(["continue", "remove"]),
  note: IpdNoteSchema.optional(),
});
export const IpdRestraintFamilyInputSchema = ipdInput({
  restraintId: IpdIdSchema,
  toldName: z.string().trim().min(1).max(120),
  relation: z.string().trim().min(1).max(60),
  toldAt: IpdInstantSchema,
  /** The MHCA nominated representative (psychiatric wards). */
  nominatedRepresentative: z.boolean().optional(),
});
export const IpdEndRestraintInputSchema = ipdInput({ restraintId: IpdIdSchema, reason: IpdNoteSchema });

// ═══════════════════════════════════════════ lines ═══════════════════════════════════════════

export const IPD_LINE_KINDS = ["urinary_catheter", "central_line", "cannula"] as const;
export type IpdLineKind = (typeof IPD_LINE_KINDS)[number];
/** Hours from insertion (or from the last "keep") to the line's due-removal / review: a cannula 72, the others daily. */
export const IPD_LINE_DUE_HOURS: Record<IpdLineKind, number> = { cannula: 72, urinary_catheter: 24, central_line: 24 };

export const IpdInsertLineInputSchema = ipdInput({
  admissionId: IpdIdSchema,
  kind: z.enum(IPD_LINE_KINDS),
  site: z.string().trim().min(1).max(60),
  insertedAt: IpdInstantSchema,
});
export const IpdReviewLineInputSchema = ipdInput({ lineId: IpdIdSchema, decision: z.enum(["keep", "remove"]), note: IpdNoteSchema.optional() });
export const IpdRemoveLineInputSchema = ipdInput({ lineId: IpdIdSchema, removedAt: IpdInstantSchema, reason: IpdNoteSchema });

/** A line on the round page and the ward screen. `stillNeededAsked`: no doctor's review yet today (IST). */
export const IpdLineViewSchema = z.object({
  lineId: IpdIdSchema,
  admissionId: IpdIdSchema,
  kind: z.enum(IPD_LINE_KINDS),
  site: z.string(),
  insertedAt: IpdInstantSchema,
  dueRemovalAt: IpdInstantSchema,
  overdue: z.boolean(),
  days: z.number().int().nonnegative(),
  stillNeededAsked: z.boolean(),
});
export type IpdLineView = z.infer<typeof IpdLineViewSchema>;

// ═══════════════════════════════════════════ crash cart and narcotic keys ═══════════════════════════════════════════

/** The hospital's standard crash-cart list (DECIDED; editable per ward type when registering a cart). */
export const IPD_CRASH_CART_STANDARD: readonly { item: string; qty: number }[] = [
  { item: "Adrenaline 1 mg/ml amp", qty: 10 }, { item: "Atropine 0.6 mg amp", qty: 5 }, { item: "Amiodarone 150 mg amp", qty: 4 },
  { item: "Sodium bicarbonate 8.4% 25 ml", qty: 4 }, { item: "Calcium gluconate 10% 10 ml", qty: 2 }, { item: "Dextrose 25% 25 ml", qty: 2 },
  { item: "Adenosine 6 mg vial", qty: 3 }, { item: "Midazolam 5 mg/ml amp", qty: 2 }, { item: "Endotracheal tube (set)", qty: 1 },
  { item: "Laryngoscope with blades", qty: 1 }, { item: "Bag-valve-mask (adult)", qty: 1 }, { item: "IV cannula 18G", qty: 4 },
];
export const IpdCartLineSchema = z.strictObject({ item: z.string().trim().min(1).max(80), qty: z.number().int().nonnegative() });

export const IpdRegisterCrashCartInputSchema = ipdInput({
  wardId: IpdIdSchema,
  code: z.string().trim().min(1).max(30),
  sealNo: z.string().trim().min(1).max(40),
  contents: z.array(IpdCartLineSchema).min(1).max(80).optional(),
});
export const IpdCheckCrashCartInputSchema = ipdInput({
  cartId: IpdIdSchema,
  sealNo: z.string().trim().min(1).max(40),
  /** Required when the seal differs from the last check or the cart needs a restock: every content line, counted. */
  recount: z.array(IpdCartLineSchema).max(80).optional(),
  note: IpdNoteSchema.optional(),
});
export const IpdUseCrashCartInputSchema = ipdInput({ cartId: IpdIdSchema, note: IpdNoteSchema.optional() });
export const IpdNarcoticKeysInputSchema = ipdInput({ wardId: IpdIdSchema });

// ═══════════════════════════════════════════ ward stock ═══════════════════════════════════════════

/** Lots expiring within this many days are listed for return to stores (decision 0091). */
export const IPD_WARD_STOCK_RETURN_DAYS = 30;
export const IPD_WARD_STOCK_OUTCOMES = ["used", "issued", "wasted", "refused"] as const;
export type IpdWardStockOutcome = (typeof IPD_WARD_STOCK_OUTCOMES)[number];

export const IpdSetWardParInputSchema = ipdInput({
  wardId: IpdIdSchema,
  /** The store the ward indents on (the central store). */
  supplyStoreId: IpdIdSchema,
  items: z.array(z.strictObject({ itemId: IpdIdSchema, par: z.number().int().nonnegative() })).min(1).max(300),
});
export const IpdRaiseWardIndentInputSchema = ipdInput({ wardId: IpdIdSchema, note: IpdNoteSchema.optional() });

/**
 * One ward-stock item on a patient (0089 / 0091): `used` and `issued` (indented for this patient) are charged; `wasted`
 * needs a reason and is charged unless staff error or the in-charge waives it; `refused` (unopened) is not charged and
 * stays on the shelf. An item inside a package is recorded, not charged. An expired lot is never charged.
 */
export const IpdRecordWardStockUseInputSchema = ipdInput({
  admissionId: IpdIdSchema,
  itemId: IpdIdSchema,
  batchId: IpdIdSchema,
  qty: z.number().int().positive().max(1000),
  outcome: z.enum(IPD_WARD_STOCK_OUTCOMES),
  reason: IpdNoteSchema.optional(),
  staffError: z.boolean().optional(),
  inPackage: z.boolean().optional(),
  /** The in-charge's waiver of a wastage charge (logged). */
  waive: z.strictObject({ reason: IpdNoteSchema }).optional(),
});

// ═══════════════════════════════════════════ safety events and quality ═══════════════════════════════════════════

export const IPD_SAFETY_EVENT_KINDS = ["fall", "pressure_injury", "medication_error", "line_infection"] as const;
export type IpdSafetyEventKind = (typeof IPD_SAFETY_EVENT_KINDS)[number];

export const IpdRecordSafetyEventInputSchema = ipdInput({
  admissionId: IpdIdSchema,
  kind: z.enum(IPD_SAFETY_EVENT_KINDS),
  occurredAt: IpdInstantSchema,
  /** Found on admission: recorded, never counted against the ward. */
  presentOnAdmission: z.boolean().optional(),
  /** A line infection names its line. */
  lineId: IpdIdSchema.optional(),
  note: IpdNoteSchema.optional(),
});

/** An EWS alert is answered in time when a doctor acknowledges it (or a nurse sees it) within this many minutes. */
export const IPD_EWS_ANSWER_MINUTES = 10;
/** A shift handover is on time when accepted within this many minutes of being given. */
export const IPD_HANDOVER_ON_TIME_MINUTES = 30;

const Indicator = z.object({
  /** The count (numerator). */
  count: z.number().nonnegative(),
  /** The denominator the rate is over: bed-days, line-days, alerts, handovers or shifts. */
  over: z.number().nonnegative(),
  /** Per 1,000 (falls, pressure injuries, medication errors, line infections) or a percentage; null when `over` is 0. */
  value: z.number().nullable(),
  unit: z.enum(["per_1000_bed_days", "per_1000_line_days", "percent"]),
  /** The rows behind it (ids), so every number is traceable. */
  sources: z.array(z.string()),
});

export const IpdWardQualitySchema = z.object({
  wardId: IpdIdSchema,
  wardName: z.string(),
  month: IpdMonthSchema,
  bedDays: z.number().nonnegative(),
  lineDays: z.number().int().nonnegative(),
  indicators: z.object({
    falls: Indicator,
    pressureInjuries: Indicator,
    medicationErrors: Indicator,
    lineInfections: Indicator,
    ewsAnsweredInTime: Indicator,
    handoversOnTime: Indicator,
    shiftsRatioKept: Indicator,
  }),
  /** Present-on-admission events recorded this month (shown, never counted). */
  presentOnAdmission: z.array(z.string()),
});
export type IpdWardQuality = z.infer<typeof IpdWardQualitySchema>;

// ═══════════════════════════════════════════ reads ═══════════════════════════════════════════

const WardRef = z.object({ id: IpdIdSchema, code: z.string(), name: z.string() });

export const IpdCarePlanViewSchema = z.object({
  planId: IpdIdSchema,
  admissionId: IpdIdSchema,
  kind: z.enum(IPD_CARE_PLAN_KINDS),
  score: z.number().int(),
  startedAt: IpdInstantSchema,
  nextDueAt: IpdInstantSchema,
  overdue: z.boolean(),
  lastCheckAt: IpdInstantSchema.nullable(),
});
export type IpdCarePlanView = z.infer<typeof IpdCarePlanViewSchema>;

export const IpdRestraintViewSchema = z.object({
  restraintId: IpdIdSchema,
  admissionId: IpdIdSchema,
  bedCode: z.string().nullable(),
  name: z.string(),
  wardId: IpdIdSchema.nullable(),
  kind: z.enum(IPD_RESTRAINT_KINDS),
  reason: z.string(),
  status: z.enum(["ordered", "active", "ended", "lapsed"]),
  psychiatric: z.boolean(),
  orderedBy: z.string(),
  orderedAt: IpdInstantSchema,
  startedAt: IpdInstantSchema.nullable(),
  endedAt: IpdInstantSchema.nullable(),
  reviewDueAt: IpdInstantSchema,
  nextCheckAt: IpdInstantSchema.nullable(),
  checkOverdue: z.boolean(),
  checks: z.number().int().nonnegative(),
  missedChecks: z.number().int().nonnegative(),
  familyTold: z.object({ name: z.string(), relation: z.string(), at: IpdInstantSchema, nominatedRepresentative: z.boolean() }).nullable(),
  /** Psychiatric ward: the nominated representative not told within 24 hours of the order. */
  representativeLate: z.boolean(),
});
export type IpdRestraintView = z.infer<typeof IpdRestraintViewSchema>;

export const IpdRestraintRegisterSchema = z.object({
  month: IpdMonthSchema,
  wardId: IpdIdSchema.nullable(),
  episodes: z.array(IpdRestraintViewSchema),
  /** The MHCA monthly summary (psychiatric episodes) for the Review Board. */
  mhca: z.object({ episodes: z.number().int().nonnegative(), lapsed: z.number().int().nonnegative(), representativeLate: z.number().int().nonnegative() }),
});
export type IpdRestraintRegister = z.infer<typeof IpdRestraintRegisterSchema>;

export const IpdCrashCartViewSchema = z.object({
  cartId: IpdIdSchema,
  code: z.string(),
  sealNo: z.string(),
  status: z.enum(["ready", "needs_restock"]),
  contents: z.array(z.object({ item: z.string(), qty: z.number().int() })),
  lastCheckAt: IpdInstantSchema.nullable(),
  checkedThisShift: z.boolean(),
});
export type IpdCrashCartView = z.infer<typeof IpdCrashCartViewSchema>;

export const IpdWardStockSchema = z.object({
  wardId: IpdIdSchema,
  storeId: IpdIdSchema.nullable(),
  supplyStoreId: IpdIdSchema.nullable(),
  items: z.array(z.object({ itemId: IpdIdSchema, code: z.string(), name: z.string(), par: z.number().int(), onHand: z.number(), shortfall: z.number().int() })),
  /** Lots at the ward expiring within 30 days (or already expired): return to stores. */
  expiring: z.array(z.object({ itemId: IpdIdSchema, name: z.string(), batchId: IpdIdSchema, batchNo: z.string(), expiryDate: z.string(), daysRemaining: z.number().int(), onHand: z.number() })),
});
export type IpdWardStock = z.infer<typeof IpdWardStockSchema>;

export const IpdWardSafetySchema = z.object({
  asOf: IpdInstantSchema,
  wards: z.array(WardRef),
  ward: WardRef.nullable(),
  /** #1007 — the ward's patients now (whom a score, a line or an event is recorded for); sealed patients without a bed. */
  patients: z.array(z.object({ admissionId: IpdIdSchema, bedCode: z.string().nullable(), name: z.string() })),
  carePlans: z.array(IpdCarePlanViewSchema.extend({ bedCode: z.string().nullable(), name: z.string() })),
  restraints: z.array(IpdRestraintViewSchema),
  lines: z.array(IpdLineViewSchema.extend({ bedCode: z.string().nullable(), name: z.string() })),
  carts: z.array(IpdCrashCartViewSchema),
  keys: z.object({ userId: IpdIdSchema, name: z.string(), takenAt: IpdInstantSchema }).nullable(),
  incidents: z.array(z.object({ incidentId: IpdIdSchema, kind: z.string(), text: z.string(), raisedAt: IpdInstantSchema })),
});
export type IpdWardSafety = z.infer<typeof IpdWardSafetySchema>;

/** #1007 — what the in-charge sets par from: active stores items and the stores (no materials read permission needed). */
export const IpdWardStockCatalogueSchema = z.object({
  items: z.array(z.object({ itemId: IpdIdSchema, code: z.string(), name: z.string(), baseUom: z.string() })),
  stores: z.array(z.object({ id: IpdIdSchema, code: z.string(), name: z.string() })),
});
export type IpdWardStockCatalogue = z.infer<typeof IpdWardStockCatalogueSchema>;

/** #1019 — the lots held at the patient's ward, for the bedside ward-stock form; an expired lot is marked (never used). */
export const IpdWardLotsSchema = z.object({
  wardId: IpdIdSchema.nullable(),
  lots: z.array(z.object({
    itemId: IpdIdSchema, name: z.string(), baseUom: z.string(), batchId: IpdIdSchema, batchNo: z.string(),
    expiryDate: z.string().nullable(), onHand: z.number(), expired: z.boolean(),
  })),
});
export type IpdWardLots = z.infer<typeof IpdWardLotsSchema>;

export const IPD_WARD_SAFETY_ROUTES = {
  safety: "/ipd/ward-safety",
  riskScore: "/ipd/ward-safety/risk-score",
  careCheck: "/ipd/ward-safety/care-check",
  restraintOrder: "/ipd/ward-safety/restraint/order",
  restraintApply: "/ipd/ward-safety/restraint/apply",
  restraintCheck: "/ipd/ward-safety/restraint/check",
  restraintReview: "/ipd/ward-safety/restraint/review",
  restraintFamily: "/ipd/ward-safety/restraint/family",
  restraintEnd: "/ipd/ward-safety/restraint/end",
  restraintRegister: "/ipd/ward-safety/restraint/register",
  lineInsert: "/ipd/ward-safety/line/insert",
  lineReview: "/ipd/ward-safety/line/review",
  lineRemove: "/ipd/ward-safety/line/remove",
  cartRegister: "/ipd/ward-safety/cart/register",
  cartCheck: "/ipd/ward-safety/cart/check",
  cartUse: "/ipd/ward-safety/cart/use",
  keys: "/ipd/ward-safety/narcotic-keys",
  stock: "/ipd/ward-safety/stock",
  stockPar: "/ipd/ward-safety/stock/par",
  stockIndent: "/ipd/ward-safety/stock/indent",
  stockUse: "/ipd/ward-safety/stock/use",
  stockCatalogue: "/ipd/ward-safety/stock/catalogue",
  stockLots: "/ipd/ward-safety/stock/lots",
  safetyEvent: "/ipd/ward-safety/event",
  quality: "/ipd/ward-safety/quality",
} as const;
