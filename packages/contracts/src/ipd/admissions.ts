import { z } from "zod";
import { IpdBedClassSchema } from "../ipd-bed-classes";
import { IpdAdmissionStateSchema, IpdIdSchema, IpdInstantSchema, IpdPaiseSchema, IpdUserRefSchema } from "./common";
import { IpdRoomRentCapWarningSchema } from "./payer";
import { IpdBedNeedSchema } from "./intents-admit";

/**
 * E1.2 (#719) — THE ADMISSION DESK'S READ MODELS AND ROUTES (spec §4.2, §4.9 B "Admit — one flowing sheet").
 *
 * The sheet reads one admission (`IpdAdmissionView`), the class cards (`IpdClassQuote`, from the active tariff) and the
 * top three rule-valid beds (`IpdBedProposal`). Money appears only in these desk shapes: a doctor's request answers
 * with `request_admission`'s output, which carries none (decision 0058).
 */

export const IPD_ADMISSION_SOURCES = ["opd_advice", "ot_daycare_conversion", "er", "direct", "transfer_in", "downtime"] as const;
export const IpdAdmissionSourceSchema = z.enum(IPD_ADMISSION_SOURCES);
export type IpdAdmissionSource = z.infer<typeof IpdAdmissionSourceSchema>;

const ConsentView = z.object({
  signedBy: z.enum(["patient", "guardian", "representative"]),
  method: z.enum(["tablet_signature", "otp", "paper"]).nullable(),
  signerName: z.string().nullable(),
  relation: z.string().nullable(),
  witnessName: z.string().nullable(),
  at: IpdInstantSchema,
});

export const IpdAdmissionViewSchema = z.object({
  id: IpdIdSchema,
  admissionNo: z.string().nullable(),
  state: IpdAdmissionStateSchema,
  source: IpdAdmissionSourceSchema,
  patient: z.object({
    id: IpdIdSchema,
    uhid: z.string(),
    name: z.string().nullable(),
    initials: z.string(),
    ageSex: z.string(),
    /** Every recorded allergy in words; empty when none is recorded. */
    allergies: z.array(z.string()),
  }),
  consultant: z.object({ id: IpdUserRefSchema, name: z.string() }),
  department: z.string().nullable(),
  provisionalDiagnosis: z.string().nullable(),
  mlc: z.boolean(),
  requestedClass: IpdBedClassSchema,
  isolation: z.enum(["none", "contact", "droplet", "airborne"]),
  icu: z.boolean(),
  requestedAt: IpdInstantSchema,
  plannedFor: IpdInstantSchema.nullable(),
  expiresAt: IpdInstantSchema,
  payerKind: z.string().nullable(),
  coverageId: z.string().nullable(),
  estimatePaise: IpdPaiseSchema.nullable(),
  depositRequiredPaise: IpdPaiseSchema.nullable(),
  depositBasis: z.string().nullable(),
  depositPaidPaise: IpdPaiseSchema,
  /** Review #7: a downtime admission whose paper deposit the bill desk has not yet checked. */
  depositCheckPending: z.boolean(),
  deposits: z.array(z.object({ receiptId: z.string(), receiptNo: z.string(), amountPaise: IpdPaiseSchema, takenAt: IpdInstantSchema })),
  consent: ConsentView.nullable(),
  reservation: z.object({ id: IpdIdSchema, bedId: IpdIdSchema, bedCode: z.string(), expiresAt: IpdInstantSchema }).nullable(),
  bed: z.object({ id: IpdIdSchema, code: z.string(), wardName: z.string().nullable() }).nullable(),
  band: z.object({ id: IpdIdSchema, serial: z.string(), printedAt: IpdInstantSchema }).nullable(),
  /** ICU class: the intensivist's approval, when one was asked for. */
  icuApproval: z.object({ id: IpdIdSchema, status: z.string() }).nullable(),
  admittedAt: IpdInstantSchema.nullable(),
  stabilisedAt: IpdInstantSchema.nullable(),
  downtimeSerial: z.string().nullable(),
  incomplete: z.array(z.string()),
});
export type IpdAdmissionView = z.infer<typeof IpdAdmissionViewSchema>;

/** One class card: the daily components from the active tariff, or which of them are missing. Never a guess. */
export const IpdClassQuoteSchema = z.object({
  class: IpdBedClassSchema,
  label: z.string(),
  perDay: z.object({ room: IpdPaiseSchema, nursing: IpdPaiseSchema, visit: IpdPaiseSchema }).nullable(),
  /** Components with no rate on the active tariff ("room", "nursing", "visit", "non_payables"). */
  missing: z.array(z.string()),
  estimatePaise: IpdPaiseSchema.nullable(),
  depositPaise: IpdPaiseSchema.nullable(),
  depositBasis: z.string().nullable(),
  /** Free rule-valid beds of the class right now. */
  freeBeds: z.number().int().nonnegative(),
  /** E2.2 (#726): the room-rent cap warning for this class (null: no cap recorded, or the rent is within it). */
  capWarning: IpdRoomRentCapWarningSchema.nullable().optional(),
});
export type IpdClassQuote = z.infer<typeof IpdClassQuoteSchema>;

export const IpdBedProposalSchema = z.object({
  bedId: IpdIdSchema,
  code: z.string(),
  wardName: z.string().nullable(),
  class: IpdBedClassSchema,
  /** Why the bed fits, in words ("Male bay", "Oxygen point", "Same ward as the unit"). */
  reasons: z.array(z.string()),
});
export type IpdBedProposal = z.infer<typeof IpdBedProposalSchema>;

/**
 * E5.2 (#739) — BED FLOW T0's proposal for one waiting admission (spec §4.8, §4.9 A): the best rule-valid free bed by the
 * same rule check every bed act asks, chosen by a fixed tie-break (requested class, the admitting department's own ward,
 * the bed free longest). `reasons` are the short rules it passed and why it won, as CODES (the client words them;
 * stored as codes in the proposal log); `freeMinutes` is computed at read time. `patientId` and `need` are what the
 * Confirm button sends to `reserve_bed`, unchanged.
 */
export const IPD_BED_FLOW_REASONS = [
  "class_requested", "gender_male_bay", "gender_female_bay", "gender_any", "gender_paediatric", "room_shared_male",
  "room_shared_female", "isolation_contact", "isolation_droplet", "isolation_airborne", "icu_bed", "own_department",
] as const;
export type IpdBedFlowReason = (typeof IPD_BED_FLOW_REASONS)[number];
export const IpdBedFlowProposalSchema = z.object({
  proposalId: IpdIdSchema,
  admissionId: IpdIdSchema,
  patientId: IpdIdSchema,
  need: IpdBedNeedSchema,
  bedId: IpdIdSchema,
  bedCode: z.string(),
  wardName: z.string().nullable(),
  class: IpdBedClassSchema,
  reasons: z.array(z.enum(IPD_BED_FLOW_REASONS)),
  /** The admitting department's code when `own_department` is a reason (the client's "MED ward"). */
  department: z.string().nullable(),
  /** Minutes the bed has been free, as of this read; null when unknown. */
  freeMinutes: z.number().int().nonnegative().nullable(),
  proposedAt: IpdInstantSchema,
});
export type IpdBedFlowProposal = z.infer<typeof IpdBedFlowProposalSchema>;

/** A request waiting for a bed, as the Beds board's left column shows it. Wall mode: initials only. */
export const IpdWaitingCardSchema = z.object({
  admissionId: IpdIdSchema,
  state: z.enum(["requested", "reserved"]),
  source: IpdAdmissionSourceSchema,
  initials: z.string(),
  name: z.string().nullable(),
  requestedClass: IpdBedClassSchema,
  isolation: z.enum(["none", "contact", "droplet", "airborne"]),
  icu: z.boolean(),
  requestedAt: IpdInstantSchema,
  waitMinutes: z.number().int().nonnegative(),
  reservedBedCode: z.string().nullable(),
  /** E5.2 (#739): the UHID (empty on the wall display). */
  uhid: z.string().optional(),
  /** E5.2 (#739): Bed Flow's proposal for a request with no bed held; null when no free bed passes every rule. Never on the wall. */
  flow: IpdBedFlowProposalSchema.nullable().optional(),
});
export type IpdWaitingCard = z.infer<typeof IpdWaitingCardSchema>;

/** A recent OPD advice to admit that has no admission request yet (the sheet's "From OPD advice" list). */
export const IpdAdviceSchema = z.object({
  encounterId: IpdIdSchema,
  patientId: IpdIdSchema,
  doctorId: IpdUserRefSchema,
  doctorName: z.string(),
  departmentId: z.string(),
  patientName: z.string().nullable(),
  uhid: z.string(),
  note: z.string().nullable(),
  advisedAt: IpdInstantSchema,
});
export type IpdAdvice = z.infer<typeof IpdAdviceSchema>;

/** The approval kinds the desk may ask for on an admission (kernel approvals). */
/** E3.2 (#730): `discharge_dues` — leaving with an unpaid balance (billing manager or MS; never a detention). */
/** #763: `bill_void` — voiding a settled final or supplementary bill (billing manager or owner; requester ≠ approver). */
export const IPD_APPROVAL_KINDS = ["icu", "non_covered", "deposit_waiver", "discharge_dues", "bill_void"] as const;
export type IpdApprovalKind = (typeof IPD_APPROVAL_KINDS)[number];

export const IPD_ADMIT_ROUTES = {
  list: "/ipd/admissions",
  advice: "/ipd/admissions/advice",
  depositChecks: "/ipd/admissions/deposit-checks",
  emergencyApproval: "/ipd/admissions/emergency/icu-approval",
  consultants: "/ipd/admissions/consultants",
  one: "/ipd/admissions/:id",
  quotes: "/ipd/admissions/:id/quotes",
  beds: "/ipd/admissions/:id/beds",
  approvals: "/ipd/admissions/:id/approvals",
  request: "/ipd/admissions/request",
  plan: "/ipd/admissions/plan",
  admit: "/ipd/admissions/admit",
  cancel: "/ipd/admissions/cancel",
  emergency: "/ipd/admissions/emergency",
  backfill: "/ipd/admissions/backfill",
  consent: "/ipd/admissions/consent",
  stabilised: "/ipd/admissions/stabilised",
  payerAuth: "/ipd/admissions/payer-auth",
  deposit: "/ipd/admissions/deposit",
  printBand: "/ipd/admissions/band/print",
  reprintBand: "/ipd/admissions/band/reprint",
} as const;
