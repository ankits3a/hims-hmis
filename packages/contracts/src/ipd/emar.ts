import { z } from "zod";
import { IpdIdSchema, IpdInstantSchema, IpdUserRefSchema } from "./common";
import { IPD_DRUG_ROUTES } from "./intents-meds";
import { IPD_ORDER_STATUSES, IPD_ORDER_VERIFICATIONS, IpdRoundIdentitySchema } from "./rounds";

/**
 * E4.3 (#735) — THE eMAR: the pharmacist's verify queue, the issue labels, the dose schedule, the bedside (board D2)
 * and the ward MAR chart (spec SPEC-ipd-core §4.6, §4.9 D, §0B "Offline"). Clinical: NO MONEY anywhere (decision 0058) —
 * an issue and a return count UNITS; nothing here names a price.
 *
 * DOSES ARE NEVER QUEUED OFFLINE (§0B): the phone disables Give with "No network — use paper MAR", and the server refuses
 * a give stamped more than `IPD_EMAR_GIVE_STALE_MS` before its clock (`give_expired`) — a give that sat in a queue or an
 * interrupted give (§4.10 edge 8) is never recorded late by accident.
 */

/** Due window either side of the due time (§4.6). */
export const IPD_EMAR_WINDOW_MINUTES = 60;
/** Time-critical drugs: antibiotics, insulin, anti-epileptics, Parkinson's (§4.6). */
export const IPD_EMAR_TIME_CRITICAL_WINDOW_MINUTES = 30;
/** DECIDED: a missed dose may still be given late, with a reason, until one more window has passed. */
export const IPD_EMAR_CATCH_UP_WINDOWS = 1;
/** A give whose `givenAt` is older than this is refused `give_expired` (doses never queue; §4.10 edge 8). */
export const IPD_EMAR_GIVE_STALE_MS = 2 * 60_000;
/** The second nurse's PIN proof lives this long and is spent by one act. */
export const IPD_EMAR_SECOND_CHECK_MINUTES = 5;
/** A verbal order is signed by the doctor within this many hours (§4.6); the nudge goes at the deadline minus 4 h. */
export const IPD_EMAR_VERBAL_SIGN_HOURS = 24;
/** Doses are scheduled this far ahead; the minute sweep keeps the horizon filled. */
export const IPD_EMAR_HORIZON_HOURS = 36;

/** The label a bedside scan reads: `EML-` + the label id (QR and barcode carry the same text). */
export const IPD_EMAR_LABEL_PREFIX = "EML-";

export const IPD_EMAR_DOSE_STATUSES = ["scheduled", "given", "held", "missed", "refused", "cancelled"] as const;
export type IpdEmarDoseStatus = (typeof IPD_EMAR_DOSE_STATUSES)[number];
export const IPD_EMAR_ACT_KINDS = [
  "given", "held", "missed", "refused", "reoffered", "cancelled", "entered_in_error", "medication_incident",
] as const;
export type IpdEmarActKind = (typeof IPD_EMAR_ACT_KINDS)[number];
export const IPD_EMAR_CHECKS = ["allergy", "interaction", "dose", "duplicate"] as const;
export type IpdEmarCheck = (typeof IPD_EMAR_CHECKS)[number];

/** A check's finding at verify. `stop` (an allergy, a severe interaction) needs the pharmacist's note to verify through. */
export const IpdEmarFindingSchema = z.object({
  check: z.enum(IPD_EMAR_CHECKS),
  severity: z.enum(["stop", "warn", "info"]),
  words: z.string(),
});
export type IpdEmarFinding = z.infer<typeof IpdEmarFindingSchema>;

/** One drug order as the eMAR shows it. `tallMan` is the item master's LASA note ("hydrOXYzine vs hydrALAZINE"). */
export const IpdEmarOrderLineSchema = z.object({
  orderId: IpdIdSchema,
  title: z.string(),
  tallMan: z.string().nullable(),
  lasa: z.boolean(),
  highAlert: z.boolean(),
  narcotic: z.boolean(),
  timeCritical: z.boolean(),
  doseWords: z.string(),
  doseValue: z.number(),
  doseUnit: z.string(),
  route: z.enum(IPD_DRUG_ROUTES),
  frequency: z.string(),
  prn: z.object({ minIntervalMinutes: z.number().int(), max24h: z.number().int() }).nullable(),
  weightBased: z.boolean(),
  weightKg: z.number().nullable(),
  startAt: IpdInstantSchema,
  stopAt: IpdInstantSchema.nullable(),
  status: z.enum(IPD_ORDER_STATUSES),
  verification: z.enum(IPD_ORDER_VERIFICATIONS).nullable(),
  issued: z.boolean(),
  ownMedicine: z.boolean(),
  /** A verbal order: by when the doctor signs; null once signed. */
  verbalSignBy: IpdInstantSchema.nullable(),
  verbal: z.boolean(),
  /** An allergy recorded after the order conflicts with it: no dose until the doctor and pharmacist decide. */
  allergyFlag: z.boolean(),
  infusion: z.enum(["running", "paused", "stopped"]).nullable(),
  /** PRN: when the next dose may be given (null = now) and how many in the last 24 h. */
  prnNextAt: IpdInstantSchema.nullable(),
  prnGiven24h: z.number().int().nonnegative(),
});
export type IpdEmarOrderLine = z.infer<typeof IpdEmarOrderLineSchema>;

export const IpdEmarOutcomeSchema = z.object({
  actId: IpdIdSchema,
  kind: z.enum(IPD_EMAR_ACT_KINDS),
  at: IpdInstantSchema,
  byName: z.string(),
  reason: z.string().nullable(),
  /** Given: how the patient was identified. */
  patientCheck: z.enum(["scan", "override"]).nullable(),
  late: z.boolean(),
  secondNurseName: z.string().nullable(),
  /** The record was later corrected (never deleted): entered in error, or a medication incident. */
  corrected: z.enum(["entered_in_error", "medication_incident"]).nullable(),
});
export type IpdEmarOutcome = z.infer<typeof IpdEmarOutcomeSchema>;

export const IpdEmarDoseSchema = z.object({
  doseId: IpdIdSchema,
  orderId: IpdIdSchema,
  dueAt: IpdInstantSchema,
  windowStart: IpdInstantSchema,
  windowEnd: IpdInstantSchema,
  status: z.enum(IPD_EMAR_DOSE_STATUSES),
  /** Held for NPO / off the ward: offered again when the patient returns. */
  reoffer: z.boolean(),
  prn: z.boolean(),
  outcome: IpdEmarOutcomeSchema.nullable(),
});
export type IpdEmarDose = z.infer<typeof IpdEmarDoseSchema>;

export const IpdEmarNarcoticEntrySchema = z.object({
  entryId: IpdIdSchema,
  orderId: IpdIdSchema,
  kind: z.enum(["received", "given", "wasted", "returned"]),
  qty: z.number(),
  unit: z.string(),
  at: IpdInstantSchema,
  byName: z.string(),
  witnessName: z.string().nullable(),
});
export type IpdEmarNarcoticEntry = z.infer<typeof IpdEmarNarcoticEntrySchema>;

/** One patient's MAR: the bedside (D2) and the chart. Sealed: alias or "Sealed patient", no UHID, no bed. */
export const IpdEmarPatientSchema = z.object({
  asOf: IpdInstantSchema,
  admissionId: IpdIdSchema,
  admissionNo: z.string().nullable(),
  identity: IpdRoundIdentitySchema,
  bedCode: z.string().nullable(),
  wardName: z.string().nullable(),
  /** Allergies in words ("Allergy: none recorded" when none) — the band's rule. */
  alerts: z.array(z.string()),
  npo: z.boolean(),
  weightKg: z.number().nullable(),
  orders: z.array(IpdEmarOrderLineSchema),
  doses: z.array(IpdEmarDoseSchema),
  narcotic: z.array(IpdEmarNarcoticEntrySchema),
});
export type IpdEmarPatient = z.infer<typeof IpdEmarPatientSchema>;

/** The ward MAR chart (16:9): every patient on the ward, their orders and the doses of the chart's day. */
export const IpdEmarWardChartSchema = z.object({
  asOf: IpdInstantSchema,
  dayStart: IpdInstantSchema,
  dayEnd: IpdInstantSchema,
  ward: z.object({ id: z.string(), code: z.string(), name: z.string() }).nullable(),
  wards: z.array(z.object({ id: z.string(), code: z.string(), name: z.string() })),
  patients: z.array(IpdEmarPatientSchema.omit({ asOf: true, narcotic: true })),
});
export type IpdEmarWardChart = z.infer<typeof IpdEmarWardChartSchema>;

export const IpdEmarVerifyItemSchema = z.object({
  order: IpdEmarOrderLineSchema,
  admissionId: IpdIdSchema,
  identity: IpdRoundIdentitySchema,
  bedCode: z.string().nullable(),
  wardName: z.string().nullable(),
  alerts: z.array(z.string()),
  orderedByName: z.string(),
  orderedAt: IpdInstantSchema,
  /** The prescriber ordered through a recorded allergy, with this reason. */
  allergyOverrideReason: z.string().nullable(),
  findings: z.array(IpdEmarFindingSchema),
  /** Interaction data present in the formulary (false = the check could not run: none adopted). */
  interactionDataPresent: z.boolean(),
});
export type IpdEmarVerifyItem = z.infer<typeof IpdEmarVerifyItemSchema>;

export const IpdEmarAllergyFlagSchema = z.object({
  flagId: IpdIdSchema,
  orderId: IpdIdSchema,
  admissionId: IpdIdSchema,
  identity: IpdRoundIdentitySchema,
  bedCode: z.string().nullable(),
  title: z.string(),
  substances: z.array(z.string()),
  raisedAt: IpdInstantSchema,
  orderActive: z.boolean(),
});
export type IpdEmarAllergyFlag = z.infer<typeof IpdEmarAllergyFlagSchema>;

export const IpdEmarIssueRowSchema = z.object({
  issueId: IpdIdSchema,
  orderId: IpdIdSchema,
  admissionId: IpdIdSchema,
  identity: IpdRoundIdentitySchema,
  bedCode: z.string().nullable(),
  title: z.string(),
  units: z.number().int(),
  returnedUnits: z.number().int(),
  ownMedicine: z.boolean(),
  issuedAt: IpdInstantSchema,
});
export type IpdEmarIssueRow = z.infer<typeof IpdEmarIssueRowSchema>;

/** The pharmacist's desktop queue: to verify, to issue, open allergy flags, returns owed. */
export const IpdEmarPharmacyQueueSchema = z.object({
  asOf: IpdInstantSchema,
  toVerify: z.array(IpdEmarVerifyItemSchema),
  toIssue: z.array(IpdEmarVerifyItemSchema.omit({ findings: true, interactionDataPresent: true })),
  allergyFlags: z.array(IpdEmarAllergyFlagSchema),
  returnsOwed: z.array(IpdEmarIssueRowSchema),
});
export type IpdEmarPharmacyQueue = z.infer<typeof IpdEmarPharmacyQueueSchema>;

/** One printed label: QR, drug (tall-man), dose, UHID — a sealed patient by alias, no UHID. */
export const IpdEmarLabelSchema = z.object({
  labelId: IpdIdSchema,
  code: z.string(),
  seq: z.number().int().positive(),
  of: z.number().int().positive(),
  units: z.number().int().positive(),
  drug: z.string(),
  tallMan: z.string().nullable(),
  doseWords: z.string(),
  uhid: z.string(),
  name: z.string(),
  admissionNo: z.string().nullable(),
  bedCode: z.string().nullable(),
  issuedAt: IpdInstantSchema,
  ownMedicine: z.boolean(),
  highAlert: z.boolean(),
});
export type IpdEmarLabel = z.infer<typeof IpdEmarLabelSchema>;

export const IpdEmarLabelSheetSchema = z.object({ issueId: IpdIdSchema, labels: z.array(IpdEmarLabelSchema) });
export type IpdEmarLabelSheet = z.infer<typeof IpdEmarLabelSheetSchema>;

/** The bedside scan's answer: the patient the band names, and — with a label — the five checks (§4.9 D). */
export const IpdEmarScanSchema = z.object({
  asOf: IpdInstantSchema,
  admissionId: IpdIdSchema,
  bandSerial: z.string().nullable(),
  label: z.object({
    labelId: IpdIdSchema,
    orderId: IpdIdSchema,
    order: IpdEmarOrderLineSchema,
    dose: IpdEmarDoseSchema.nullable(),
    checks: z.array(z.object({ key: z.enum(["patient", "drug", "dose", "time", "route"]), ok: z.boolean(), words: z.string() })),
    needs: z.object({ secondNurse: z.boolean(), lasaConfirm: z.boolean(), weight: z.boolean(), lateReason: z.boolean() }),
  }).nullable(),
});
export type IpdEmarScan = z.infer<typeof IpdEmarScanSchema>;

export const IpdEmarOverrideCountsSchema = z.object({
  from: IpdInstantSchema,
  to: IpdInstantSchema,
  byNurse: z.array(z.object({ userId: IpdUserRefSchema, name: z.string(), overrides: z.number().int(), gives: z.number().int() })),
  byWard: z.array(z.object({ wardId: z.string(), wardCode: z.string(), overrides: z.number().int(), gives: z.number().int() })),
});
export type IpdEmarOverrideCounts = z.infer<typeof IpdEmarOverrideCountsSchema>;

/** The phone's "doses due" list for a ward (board D2): open doses inside or near their window, oldest first. */
export const IpdEmarDueItemSchema = z.object({
  doseId: IpdIdSchema,
  admissionId: IpdIdSchema,
  bedCode: z.string().nullable(),
  name: z.string(),
  sealed: z.boolean(),
  orderId: IpdIdSchema,
  title: z.string(),
  doseWords: z.string(),
  route: z.enum(IPD_DRUG_ROUTES),
  dueAt: IpdInstantSchema,
  windowEnd: IpdInstantSchema,
  status: z.enum(IPD_EMAR_DOSE_STATUSES),
  overdue: z.boolean(),
  highAlert: z.boolean(),
});
export type IpdEmarDueItem = z.infer<typeof IpdEmarDueItemSchema>;
export const IpdEmarDueListSchema = z.object({ asOf: IpdInstantSchema, items: z.array(IpdEmarDueItemSchema) });
export type IpdEmarDueList = z.infer<typeof IpdEmarDueListSchema>;

export const IPD_EMAR_ROUTES = {
  due: "/ipd/emar/due",
  pharmacyQueue: "/ipd/emar/pharmacy",
  verify: "/ipd/emar/verify",
  issue: "/ipd/emar/issue",
  labels: "/ipd/emar/issues/:issueId/labels",
  returnMed: "/ipd/emar/return",
  resolveFlag: "/ipd/emar/allergy-flags/resolve",
  patient: "/ipd/emar/admissions/:admissionId",
  ward: "/ipd/emar/ward",
  scan: "/ipd/emar/scan",
  give: "/ipd/emar/give",
  hold: "/ipd/emar/hold",
  refuse: "/ipd/emar/refuse",
  miss: "/ipd/emar/miss",
  reoffer: "/ipd/emar/reoffer",
  correct: "/ipd/emar/correct",
  secondCheck: "/ipd/emar/second-check",
  infusion: "/ipd/emar/infusion",
  wastage: "/ipd/emar/narcotic-wastage",
  verbal: "/ipd/emar/verbal-orders",
  signVerbal: "/ipd/emar/verbal-orders/sign",
  overrides: "/ipd/emar/overrides",
} as const;
