import { z } from "zod";
import { ErIdSchema, ErInstantSchema, ErNoteSchema, ErWordsSchema, erInput, erIntent } from "./common";

/**
 * ER lane 6 (#813) — THE ER BILL (spec SPEC-emergency §4.6; decision 0076). THESE SHAPES ARE THE ONLY ER SHAPES THAT
 * NAME MONEY: they are read and written by the ER bill desk and billing roles — never by a clinical screen (0058).
 *
 * - ER tariff lines (0076 §1): ER registration and ER physician fee, once per visit; after the first 6 hours, one
 *   observation charge per started 6 hours. Procedures, consumables, drugs and tests itemised at the hospital tariff
 *   (drugs at the batch MRP).
 * - THE STABILISATION GATE (0076 §2): while the patient is in the department, no money act (an advance, a settlement)
 *   before the ER doctor records "stabilised". A patient who has left is settled whatever their clinical course.
 * - Settle at departure, or dues against a signed undertaking — the invoice HELD until paid, never credit (0013); the
 *   patient is never held.
 * - ₹0 payers: PM-JAY; road-accident cashless (up to ₹1.5 lakh for 7 days from the accident); BNSS s.397 (sexual
 *   assault, acid attack — free by law: no patient-payable line, ever); a mass-casualty event account (full tariff to
 *   the event; the owner decides afterwards). The claim is filed by hand at the TPA desk: a claim row is its seam.
 */
export const ER_PAYER_KINDS = ["self", "pmjay", "road_accident", "bnss_free", "mci_event"] as const;
export type ErPayerKind = (typeof ER_PAYER_KINDS)[number];
/** 0076 §3: the central road-accident cashless scheme. */
export const ER_ROAD_ACCIDENT_CAP_PAISE = 15_000_000;
export const ER_ROAD_ACCIDENT_DAYS = 7;
/** 0076 §1: observation after the first 6 hours, per started 6 hours. */
export const ER_OBSERVATION_FREE_HOURS = 6;
export const ER_OBSERVATION_BLOCK_HOURS = 6;
/** The ER tariff's own service codes (the sample fixture, and the incumbent's rates at go-live). */
export const ER_SERVICE_CODES = { registration: "ER-REG", physician: "ER-PHYS", observation: "ER-OBS", drug: "ER-DRUG" } as const;

const TenderSchema = z.strictObject({
  tender: z.enum(["cash", "upi", "card"]), amountPaise: z.number().int().positive(), ref: z.string().trim().min(1).max(60).optional(),
});

export const setErPayer = erIntent({
  input: erInput({
    episodeId: ErIdSchema,
    payer: z.enum(ER_PAYER_KINDS),
    /** PM-JAY: the beneficiary id; road accident: the police / scheme reference. */
    schemeRef: ErWordsSchema.optional(),
    /** Road accident: when it happened (the 7-day window runs from here; default the ER gate time). */
    accidentAt: ErInstantSchema.optional(),
    eventAccountId: ErIdSchema.optional(),
  }),
  output: z.strictObject({
    episodeId: ErIdSchema, payer: z.enum(ER_PAYER_KINDS), coverCapPaise: z.number().int().nullable(), coverUntil: ErInstantSchema.nullable(),
  }),
  refusals: ["episode_not_found", "payer_ref_needed", "bnss_needs_mlc", "event_account_not_found", "bill_settled"],
  actors: ["desk", "duty_manager"],
  copilotProposable: false,
  agentTier: "none",
  undo: "irreversible",
  events: ["er.payer_set"],
  idempotent: true,
});

export const takeErAdvance = erIntent({
  input: erInput({ episodeId: ErIdSchema, tender: TenderSchema, payerName: ErWordsSchema }),
  output: z.strictObject({ receiptId: ErIdSchema, receiptNo: z.string(), amountPaise: z.number().int() }),
  refusals: ["episode_not_found", "not_stabilised", "payer_pays_nothing", "bill_settled", "rolled_to_ip"],
  actors: ["desk"],
  copilotProposable: false,
  agentTier: "none",
  undo: "reversal_line",
  events: ["er.advance_taken"],
  idempotent: true,
});

export const priceErLines = erIntent({
  input: erInput({ episodeId: ErIdSchema }),
  output: z.strictObject({ priced: z.number().int(), stillMissing: z.number().int() }),
  refusals: ["episode_not_found", "bill_settled"],
  actors: ["desk"],
  copilotProposable: false,
  agentTier: "none",
  undo: "irreversible",
  events: ["er.lines_priced"],
  idempotent: true,
});

export const settleErBill = erIntent({
  input: erInput({
    episodeId: ErIdSchema,
    settlement: z.enum(["paid", "dues", "nothing_payable"]),
    tenders: z.array(TenderSchema).max(4).optional(),
    /** Dues: the undertaking signed by the patient or the next of kin (the paper's reference). */
    undertaking: z.strictObject({ signerName: ErWordsSchema, relation: z.string().trim().min(1).max(40), documentRef: ErWordsSchema }).optional(),
    note: ErNoteSchema.optional(),
  }),
  output: z.strictObject({
    episodeId: ErIdSchema, invoiceNo: z.string().nullable(), totalPaise: z.number().int(), payerPaise: z.number().int(),
    patientPaise: z.number().int(), paidPaise: z.number().int(), duesPaise: z.number().int(), claimId: ErIdSchema.nullable(),
  }),
  refusals: [
    "episode_not_found", "episode_wrong_state", "not_stabilised", "bill_settled", "lines_unpriced", "tender_short", "undertaking_needed",
    "patient_payable_forbidden", "rolled_to_ip",
  ],
  actors: ["desk"],
  copilotProposable: false,
  agentTier: "none",
  undo: "reversal_line",
  events: ["er.bill_settled"],
  idempotent: true,
});

/** A mass-casualty event's account (0076 §4): every tagged episode's charges post to it at full tariff. */
export const openErEventAccount = erIntent({
  input: erInput({ name: ErWordsSchema, startedAt: ErInstantSchema.optional() }),
  output: z.strictObject({ eventAccountId: ErIdSchema, name: z.string() }),
  refusals: ["time_in_future"],
  actors: ["duty_manager"],
  copilotProposable: false,
  agentTier: "none",
  undo: "irreversible",
  events: ["er.event_account_opened"],
  idempotent: true,
});

// ═══════════════════════════════════════ the ER bill desk (reads; money) ═══════════════════════════════════════

export const ErBillLineSchema = z.object({
  /** A stored ER line's id, or a visit line's stable key (`er-registration:<episode>`). */
  lineId: z.string(), source: z.string(), name: z.string(), qty: z.number().int(), amountPaise: z.number().int().nullable(),
  status: z.string(), postedAt: ErInstantSchema,
});
export const ErBillSchema = z.object({
  episodeId: ErIdSchema, episodeNo: z.string(), patientLabel: z.string(), uhid: z.string(), state: z.string(), outcome: z.string().nullable(),
  stabilised: z.boolean(), payer: z.enum(ER_PAYER_KINDS), coverCapPaise: z.number().int().nullable(), coverUntil: ErInstantSchema.nullable(),
  lines: z.array(ErBillLineSchema),
  totalPaise: z.number().int(), payerPaise: z.number().int(), patientPaise: z.number().int(), advancePaise: z.number().int(),
  balancePaise: z.number().int(), unpriced: z.number().int(),
  settled: z.object({ settlement: z.string(), invoiceNo: z.string().nullable(), paidPaise: z.number().int(), duesPaise: z.number().int(), at: ErInstantSchema }).nullable(),
});
export type ErBill = z.infer<typeof ErBillSchema>;
export const ErBillDeskSchema = z.object({
  /** Departed, unsettled (the queue); then the ones still in the department with their running total. */
  toSettle: z.array(ErBillSchema), inDepartment: z.array(ErBillSchema), serverNow: ErInstantSchema,
});
export type ErBillDesk = z.infer<typeof ErBillDeskSchema>;
