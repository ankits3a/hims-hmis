import { z } from "zod";
import { IpdLineViewSchema, IpdRestraintViewSchema } from "./ward-safety";
import { IpdAdmissionStateSchema, IpdIdSchema, IpdInstantSchema, IpdProvenanceSchema, IpdUserRefSchema } from "./common";
import { IPD_DRUG_ROUTES } from "./intents-meds";
import { IPD_ROUND_SOURCES } from "./intents-ward";

/**
 * E4.2 (#734) — ROUNDS: the doctor's inpatient list, the patient's round page, and THE ORDER EVENT CONTRACT the eMAR
 * lane (E4.3) builds on (spec SPEC-ipd-core §4.5A, §4.6, §4.9 E; decisions 0058, 0067, 0072).
 *
 * NO MONEY ANYWHERE (decision 0058): no key in these read models names a fee, a charge or a bill, and the round's
 * answer never says whether a visit was charged.
 */

// ═══════════════════════════════════════ the order event contract (eMAR consumes it) ═══════════════════════════════════════

/** The kinds this lane places. Diet, nursing and procedure orders belong to their own lanes. */
export const IPD_ORDER_KINDS_PLACED = ["drug", "lab", "imaging"] as const;
export type IpdOrderKindPlaced = (typeof IPD_ORDER_KINDS_PLACED)[number];
/** An order's life: active until stopped (any time) or cancelled (before issue, with a reason). */
export const IPD_ORDER_STATUSES = ["active", "stopped", "cancelled"] as const;
export type IpdOrderStatus = (typeof IPD_ORDER_STATUSES)[number];
/** The pharmacist's verification (eMAR owns every move after `pending`). Null for lab and imaging orders. */
export const IPD_ORDER_VERIFICATIONS = ["pending", "verified", "rejected", "query"] as const;
export type IpdOrderVerification = (typeof IPD_ORDER_VERIFICATIONS)[number];

/** The drug block of a placed order, exactly as the eMAR schedules it. Times are ISO instants. */
export const IpdOrderDrugFactsSchema = z.object({
  medicineId: IpdIdSchema,
  doseValue: z.number().positive(),
  doseUnit: z.string().min(1),
  route: z.enum(IPD_DRUG_ROUTES),
  /** As written: `OD` `BD` `TDS` `QID` `HS` `SOS` `STAT` or the prescriber's own text (`frequencyOf` reads it). */
  frequency: z.string().min(1),
  startAt: IpdInstantSchema,
  /** Null only for a non-antibiotic with `durationDays`; an antibiotic always carries it. */
  stopAt: IpdInstantSchema.nullable(),
  durationDays: z.number().int().positive().nullable(),
  antibiotic: z.boolean(),
  prn: z.object({ minIntervalMinutes: z.number().int().positive(), max24h: z.number().int().positive() }).nullable(),
  weightBasedPerKg: z.boolean(),
  /** The weight the dose was ordered against (kg), or null. */
  weightKg: z.number().positive().nullable(),
});
export type IpdOrderDrugFacts = z.infer<typeof IpdOrderDrugFactsSchema>;

/**
 * `ipd.order.placed` — one per order row. A drug order arrives `pending_verify` (the eMAR's verify queue); a lab or
 * imaging order arrives `active` with the department's own order id (the ordering door placed it). Ids, codes and
 * the drug's schedule only: no patient name, no money. A consumer re-reads the row with `readIpdOrder` for display.
 */
export const IpdOrderPlacedPayloadSchema = z.object({
  orderId: IpdIdSchema,
  admissionId: IpdIdSchema,
  kind: z.enum(IPD_ORDER_KINDS_PLACED),
  status: z.enum(["pending_verify", "active"]),
  orderedBy: IpdUserRefSchema,
  /** A consultant (on the doctor master) or a resident / intern. */
  orderedByKind: z.enum(["consultant", "resident"]),
  placedAt: IpdInstantSchema,
  roundId: IpdIdSchema.nullable(),
  drug: IpdOrderDrugFactsSchema.nullable(),
  /** The prescriber ordered through a recorded allergy (reason on the row): the pharmacist must re-check it. */
  allergyOverride: z.boolean(),
  tests: z.object({
    department: z.enum(["lab", "imaging"]),
    serviceIds: z.array(z.string().min(1)).min(1),
    /** The kernel order id the department placed (`orders.id`). */
    departmentOrderId: z.string().min(1).nullable(),
  }).nullable(),
  provenance: IpdProvenanceSchema,
});
export type IpdOrderPlacedPayload = z.infer<typeof IpdOrderPlacedPayloadSchema>;

/**
 * `ipd.order.stopped` — future doses are cancelled from `stoppedAt`. `afterIssue` true = the medicine has been issued
 * (`issuedAt` set by eMAR): the return to pharmacy and its credit are eMAR's / pharmacy's to finish. No reason text rides
 * the event (it is on the row).
 */
export const IpdOrderStoppedPayloadSchema = z.object({
  orderId: IpdIdSchema,
  admissionId: IpdIdSchema,
  kind: z.enum(IPD_ORDER_KINDS_PLACED),
  stoppedAt: IpdInstantSchema,
  afterIssue: z.boolean(),
  provenance: IpdProvenanceSchema,
});
export type IpdOrderStoppedPayload = z.infer<typeof IpdOrderStoppedPayloadSchema>;

/** `ipd.order.cancelled` — never issued; nothing to return. The row keeps the reason. */
export const IpdOrderCancelledPayloadSchema = z.object({
  orderId: IpdIdSchema,
  admissionId: IpdIdSchema,
  kind: z.enum(IPD_ORDER_KINDS_PLACED),
  cancelledAt: IpdInstantSchema,
  provenance: IpdProvenanceSchema,
});
export type IpdOrderCancelledPayload = z.infer<typeof IpdOrderCancelledPayloadSchema>;

/** The event names, in one place, for the eMAR's subscriptions. */
export const IPD_ORDER_EVENT_NAMES = {
  placed: "ipd.order.placed",
  stopped: "ipd.order.stopped",
  cancelled: "ipd.order.cancelled",
} as const;

// ═══════════════════════════════════════ read models ═══════════════════════════════════════

/** The one identity header (§0A principle 4). A sealed patient shows an alias or "Sealed patient", no UHID, no bed. */
export const IpdRoundIdentitySchema = z.object({
  name: z.string(),
  uhid: z.string(),
  ageYears: z.number().int().nonnegative().nullable(),
  sex: z.string().nullable(),
  sealed: z.boolean(),
});
export type IpdRoundIdentity = z.infer<typeof IpdRoundIdentitySchema>;

/** Why a patient is on this doctor's list. */
export const IPD_ROUNDS_WHY = ["own", "covering", "unit", "consult"] as const;
export type IpdRoundsWhy = (typeof IPD_ROUNDS_WHY)[number];

export const IpdRoundsRowSchema = z.object({
  admissionId: IpdIdSchema,
  admissionNo: z.string().nullable(),
  patient: IpdRoundIdentitySchema,
  bedCode: z.string().nullable(),
  wardCode: z.string().nullable(),
  wardName: z.string().nullable(),
  /** Lying on a ward that is not the admitting department's (spec §4.5A: marked with the ward). */
  boarded: z.boolean(),
  why: z.enum(IPD_ROUNDS_WHY),
  consultantName: z.string(),
  state: IpdAdmissionStateSchema,
  /** Day 1 = the admission's IST day. */
  dayOfStay: z.number().int().positive(),
  /** The best round signed on the patient today (IST): a consultant's bedside one wins. */
  roundToday: z.enum(["none", "draft", "remote", "signed"]),
  lastRoundAt: IpdInstantSchema.nullable(),
  activeOrders: z.number().int().nonnegative(),
  fitWhen: z.enum(["today", "tomorrow"]).nullable(),
  /** Set when the patient is here because this doctor was asked to see them. */
  consultId: IpdIdSchema.nullable(),
});
export type IpdRoundsRow = z.infer<typeof IpdRoundsRowSchema>;

export const IpdRoundViewSchema = z.object({
  roundId: IpdIdSchema,
  admissionId: IpdIdSchema,
  authorId: IpdUserRefSchema,
  authorName: z.string(),
  authorKind: z.enum(["consultant", "resident"]),
  mode: z.enum(["bedside", "remote_review"]),
  seenAt: IpdInstantSchema,
  soap: z.object({
    subjective: z.string().optional(), objective: z.string().optional(), assessment: z.string().optional(), plan: z.string().optional(),
  }),
  status: z.enum(["signed", "awaiting_cosign"]),
  /** §0B provenance: the source of the words and the person who signed them. */
  source: z.enum(IPD_ROUND_SOURCES),
  provenance: IpdProvenanceSchema,
  cosignedByName: z.string().nullable(),
  cosignedAt: IpdInstantSchema.nullable(),
});
export type IpdRoundView = z.infer<typeof IpdRoundViewSchema>;

export const IpdCosignItemSchema = IpdRoundViewSchema.extend({
  patient: IpdRoundIdentitySchema,
  bedCode: z.string().nullable(),
});
export type IpdCosignItem = z.infer<typeof IpdCosignItemSchema>;

export const IpdRoundsListSchema = z.object({
  asOf: IpdInstantSchema,
  /** On the doctor master: their bedside round is the day's consultant visit; they co-sign. */
  isConsultant: z.boolean(),
  rows: z.array(IpdRoundsRowSchema),
  cosignQueue: z.array(IpdCosignItemSchema),
});
export type IpdRoundsList = z.infer<typeof IpdRoundsListSchema>;

export const IpdOrderViewSchema = z.object({
  orderId: IpdIdSchema,
  kind: z.enum(IPD_ORDER_KINDS_PLACED),
  status: z.enum(IPD_ORDER_STATUSES),
  verification: z.enum(IPD_ORDER_VERIFICATIONS).nullable(),
  /** One line a person reads: "Ceftriaxone 1 g IV BD · till 14 Mar" / "CBC, CRP". */
  title: z.string(),
  drug: IpdOrderDrugFactsSchema.extend({ medicineName: z.string() }).nullable(),
  tests: z.object({ department: z.enum(["lab", "imaging"]), names: z.array(z.string()) }).nullable(),
  orderedByName: z.string(),
  orderedAt: IpdInstantSchema,
  issuedAt: IpdInstantSchema.nullable(),
  endedAt: IpdInstantSchema.nullable(),
  endReason: z.string().nullable(),
  returnOwed: z.boolean(),
});
export type IpdOrderView = z.infer<typeof IpdOrderViewSchema>;

export const IpdConsultViewSchema = z.object({
  consultId: IpdIdSchema,
  consultantId: IpdUserRefSchema,
  consultantName: z.string(),
  question: z.string(),
  urgency: z.enum(["routine", "urgent"]),
  status: z.enum(["open", "closed"]),
  requestedByName: z.string(),
  requestedAt: IpdInstantSchema,
});
export type IpdConsultView = z.infer<typeof IpdConsultViewSchema>;

export const IpdRoundPatientSchema = z.object({
  asOf: IpdInstantSchema,
  admissionId: IpdIdSchema,
  admissionNo: z.string().nullable(),
  patient: IpdRoundIdentitySchema,
  /** Allergies in words ("Allergy: none recorded" when none) — the band's rule. */
  alerts: z.array(z.string()),
  bedCode: z.string().nullable(),
  wardName: z.string().nullable(),
  boarded: z.boolean(),
  state: IpdAdmissionStateSchema,
  admittedAt: IpdInstantSchema.nullable(),
  dayOfStay: z.number().int().positive(),
  provisionalDiagnosis: z.string().nullable(),
  consultantName: z.string(),
  coveringName: z.string().nullable(),
  fitWhen: z.enum(["today", "tomorrow"]).nullable(),
  /** The nursing lane's latest vitals, read-only; null until that lane exports them. */
  vitals: z.null(),
  rounds: z.array(IpdRoundViewSchema),
  orders: z.array(IpdOrderViewSchema),
  consults: z.array(IpdConsultViewSchema),
  /** WM-2 (#983): the lines in (catheter, central line, cannula), each asking "still needed?" once a day. */
  lines: z.array(IpdLineViewSchema).optional(),
  /** #1007: restraints ordered, on or lapsed — the doctor orders and reviews on the round page. */
  restraints: z.array(IpdRestraintViewSchema).optional(),
  /** What this viewer may do here. */
  can: z.object({ sign: z.boolean(), order: z.boolean(), cosign: z.boolean(), declareFit: z.boolean() }),
});
export type IpdRoundPatient = z.infer<typeof IpdRoundPatientSchema>;

/** The consultants a consult can be asked of: active doctor-master users, with their department. */
export const IpdConsultantChoiceSchema = z.object({ userId: IpdUserRefSchema, name: z.string(), department: z.string().nullable() });
export type IpdConsultantChoice = z.infer<typeof IpdConsultantChoiceSchema>;

export const IPD_ROUNDS_ROUTES = {
  list: "/ipd/rounds",
  patient: "/ipd/rounds/:admissionId",
  consultants: "/ipd/rounds/consultants",
  sign: "/ipd/rounds/sign",
  cosign: "/ipd/rounds/cosign",
  placeOrder: "/ipd/orders",
  stopOrder: "/ipd/orders/stop",
  cancelOrder: "/ipd/orders/cancel",
  requestConsult: "/ipd/consults",
  closeConsult: "/ipd/consults/close",
} as const;
