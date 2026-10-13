import { z } from "zod";
import { IpdIdSchema, IpdInstantSchema, IpdNoteSchema, IpdUserRefSchema, ipdInput, ipdIntent } from "./common";

/**
 * E0.2 (#714) — inpatient orders and the eMAR (spec §4.5A ipd-rounds orders, §4.6 ipd-emar). Contracts only.
 *
 * §4.11: doses and orders have NO agent tier and are never on a copilot proposal card — not today, not later.
 * The acceptance suite pins that for every intent in this file.
 */

const DoseSchema = z.strictObject({ value: z.number().positive(), unit: z.string().trim().min(1).max(16) });
/** The dose is due at `doseDueAt` — the slot on the MAR this outcome belongs to. */
const DoseSlot = { orderId: IpdIdSchema, doseDueAt: IpdInstantSchema };

/**
 * E4.2 (#734) — the doctor's inpatient order. A DRUG order names a formulary medicine with dose, route, frequency, start
 * and duration (days, or a stop time); an antibiotic (by the formulary's AWaRe class, or flagged) needs a stop time. It is
 * placed `pending_verify` for the pharmacist (eMAR, E4.3). LAB and IMAGING orders go through the ordering door (decision
 * 0067: `orderTests`, the inpatient's IP number as the episode) and are `active` at once — the department owns them from
 * there. Diet, nursing and procedure orders are placed on their own lanes' screens (`order_kind_not_here`).
 */
export const IPD_DRUG_ROUTES = ["oral", "iv", "im", "sc", "inhaled", "topical", "rectal", "sublingual", "ng", "other"] as const;
export const IpdDrugOrderSchema = z.strictObject({
  /** The formulary medicine (`formulary_medicines.id`). */
  itemId: IpdIdSchema,
  dose: DoseSchema,
  route: z.enum(IPD_DRUG_ROUTES),
  frequency: z.string().trim().min(1).max(30),
  startAt: IpdInstantSchema,
  /** Required by the intent for an antibiotic (§4.5A). */
  stopAt: IpdInstantSchema.optional(),
  /** The course length; a drug order carries this or a stop time. */
  durationDays: z.number().int().min(1).max(365).optional(),
  /** The prescriber's flag; the server ALSO treats every AWaRe-classified medicine as an antibiotic. */
  antibiotic: z.boolean(),
  prn: z.strictObject({ minIntervalMinutes: z.number().int().positive(), max24h: z.number().int().positive() }).optional(),
  weightBasedPerKg: z.boolean().optional(),
});
export type IpdDrugOrder = z.infer<typeof IpdDrugOrderSchema>;

export const placeIpOrder = ipdIntent({
  input: ipdInput({
    admissionId: IpdIdSchema,
    /** Through the ordering door (decision 0067); this contract carries the inpatient drug fields it needs. */
    kind: z.enum(["drug", "lab", "imaging", "procedure", "diet", "nursing"]),
    /** The ordering door's catalogue item for a non-drug order. */
    itemId: IpdIdSchema.optional(),
    drug: IpdDrugOrderSchema.optional(),
    /** Lab or imaging tests: tariff service ids, all of the kind's department (the test picker groups them). */
    tests: z.strictObject({
      serviceIds: z.array(z.string().min(1).max(64)).min(1).max(30),
      indication: IpdNoteSchema,
      priority: z.enum(["routine", "urgent", "stat"]).optional(),
    }).optional(),
    /** An emergency verbal order recorded by a nurse after read-back; the doctor signs within 24 hours. */
    verbal: z.strictObject({ fromDoctorId: IpdUserRefSchema, readBack: z.literal(true) }).optional(),
    note: IpdNoteSchema.optional(),
  }),
  output: z.strictObject({
    orderId: IpdIdSchema,
    status: z.enum(["pending_verify", "active"]),
    /** For a verbal order: by when the doctor must sign it. */
    signBy: IpdInstantSchema.nullable(),
  }),
  refusals: [
    "admission_not_found", "admission_wrong_state", "not_treating_team", "antibiotic_stop_date_required",
    "weight_required", "verbal_order_not_allowed", "verbal_order_only", "allergy_conflict", "duplicate_order",
    "duration_required", "medicine_not_found", "order_kind_not_here", "test_not_orderable", "time_in_future",
  ],
  actors: ["doctor", "resident", "nurse"],
  copilotProposable: false,
  agentTier: "none",
  undo: "entered_in_error",
  events: ["ipd.order.placed"],
  idempotent: true,
});

/**
 * E4.2 (#734) — stop an active DRUG order (a lab or imaging order is the department's to cancel: `order_kind_not_here`). Before issue nothing is owed back; after issue (`issuedAt` set by eMAR) the stop
 * records the intent and the return and credit are the pharmacy's (eMAR, E4.3): the answer says `returnOwed`.
 */
export const stopIpOrder = ipdIntent({
  input: ipdInput({ orderId: IpdIdSchema, reason: IpdNoteSchema }),
  output: z.strictObject({
    orderId: IpdIdSchema, status: z.literal("stopped"), stoppedAt: IpdInstantSchema, returnOwed: z.boolean(),
  }),
  refusals: ["order_not_found", "order_not_active", "not_treating_team", "order_kind_not_here"],
  actors: ["doctor", "resident"],
  copilotProposable: false,
  agentTier: "none",
  undo: "irreversible",
  events: ["ipd.order.stopped"],
  idempotent: true,
});

/** E4.2 (#734) — a wrong order (wrong patient, wrong drug) cancelled with its reason BEFORE issue; after issue, stop it. */
export const cancelIpOrder = ipdIntent({
  input: ipdInput({ orderId: IpdIdSchema, reason: IpdNoteSchema }),
  output: z.strictObject({ orderId: IpdIdSchema, status: z.literal("cancelled"), cancelledAt: IpdInstantSchema }),
  refusals: ["order_not_found", "order_not_active", "order_already_issued", "not_treating_team", "order_kind_not_here"],
  actors: ["doctor", "resident"],
  copilotProposable: false,
  agentTier: "none",
  undo: "irreversible",
  events: ["ipd.order.cancelled"],
  idempotent: true,
});

export const verifyOrder = ipdIntent({
  input: ipdInput({
    orderId: IpdIdSchema,
    decision: z.enum(["verified", "rejected", "query"]),
    checks: z.strictObject({ allergy: z.boolean(), interaction: z.boolean(), dose: z.boolean(), duplicate: z.boolean() }),
    /** Required by the intent when the decision is not `verified`. */
    note: IpdNoteSchema.optional(),
  }),
  output: z.strictObject({ orderId: IpdIdSchema, status: z.enum(["verified", "rejected", "query"]) }),
  refusals: ["order_not_found", "order_not_pending", "allergy_conflict", "state_changed"],
  actors: ["pharmacist"],
  copilotProposable: false,
  agentTier: "none",
  undo: "entered_in_error",
  events: ["ipd.order.verified"],
  idempotent: true,
});

/** Issue with a patient-specific label per unit or strip: Indian strips often carry no barcode (§4.6). */
export const issueMed = ipdIntent({
  input: ipdInput({
    orderId: IpdIdSchema,
    units: z.number().int().positive(),
    batchId: IpdIdSchema,
    labelPrinterId: IpdIdSchema,
    /** The patient's own medicine: verified, labelled, stored, never charged. */
    ownMedicine: z.boolean(),
  }),
  output: z.strictObject({ issueId: IpdIdSchema, units: z.number().int().positive(), labelIds: z.array(IpdIdSchema).min(1) }),
  refusals: ["order_not_found", "order_not_verified", "order_not_active", "stock_short", "printer_offline"],
  actors: ["pharmacist"],
  copilotProposable: false,
  agentTier: "none",
  undo: "reversal_line",
  events: ["ipd.med.issued"],
  idempotent: true,
});

/** A dose given. Never queued offline; a retried give records once (the idempotency key). */
export const administerDose = ipdIntent({
  input: ipdInput({
    ...DoseSlot,
    givenAt: IpdInstantSchema,
    patientCheck: z.union([
      z.strictObject({ kind: z.literal("scan"), wristbandCode: z.string().trim().min(1).max(128) }),
      z.strictObject({
        kind: z.literal("override"),
        overrideReason: z.enum(["band_unreadable", "band_refused", "no_band_burns", "scanner_down"]),
        note: IpdNoteSchema,
      }),
    ]),
    labelCode: z.string().trim().min(1).max(128),
    /** High-alert drugs: a second nurse's PIN, proven by a short-lived token from the PIN check. */
    secondNurse: z.strictObject({ userId: IpdUserRefSchema, pinProof: z.string().min(1).max(256) }).optional(),
    weightKg: z.number().positive().max(400).optional(),
  }),
  output: z.strictObject({
    administrationId: IpdIdSchema,
    givenAt: IpdInstantSchema,
    late: z.boolean(),
    overrideCounted: z.boolean(),
  }),
  refusals: [
    "order_not_found", "order_not_active", "wristband_scan_required", "wrong_patient_scanned", "wrong_drug_scanned",
    "outside_due_window", "second_nurse_required", "second_nurse_same_person", "prn_interval_not_met",
    "prn_daily_max_reached", "weight_required", "dose_already_recorded", "give_expired", "time_in_future",
  ],
  actors: ["nurse"],
  copilotProposable: false,
  agentTier: "none",
  undo: "entered_in_error",
  events: ["ipd.dose.given"],
  idempotent: true,
});

export const holdDose = ipdIntent({
  input: ipdInput({
    ...DoseSlot,
    reason: z.enum(["npo", "off_ward", "parameter_out_of_range", "clinical_hold", "doctor_instruction"]),
    note: IpdNoteSchema.optional(),
  }),
  /** NPO or off the ward: the dose re-offers when the patient returns (§4.6). */
  output: z.strictObject({ holdId: IpdIdSchema, reofferOnReturn: z.boolean() }),
  refusals: ["order_not_found", "order_not_active", "dose_already_recorded"],
  actors: ["nurse", "doctor"],
  copilotProposable: false,
  agentTier: "none",
  undo: "entered_in_error",
  events: ["ipd.dose.held"],
  idempotent: true,
});

export const refuseDose = ipdIntent({
  input: ipdInput({
    ...DoseSlot,
    reason: z.enum(["patient_refused", "vomited", "other"]),
    note: IpdNoteSchema.optional(),
  }),
  output: z.strictObject({ refusalId: IpdIdSchema, doctorNotified: z.boolean() }),
  refusals: ["order_not_found", "order_not_active", "dose_already_recorded"],
  actors: ["nurse"],
  copilotProposable: false,
  agentTier: "none",
  undo: "entered_in_error",
  events: ["ipd.dose.refused"],
  idempotent: true,
});

export const recordInfusionEvent = ipdIntent({
  input: ipdInput({
    orderId: IpdIdSchema,
    event: z.enum(["start", "rate_change", "pause", "resume", "stop"]),
    rateMlPerHour: z.number().nonnegative().max(2000).optional(),
    at: IpdInstantSchema,
    secondNurse: z.strictObject({ userId: IpdUserRefSchema, pinProof: z.string().min(1).max(256) }).optional(),
  }),
  output: z.strictObject({ infusionEventId: IpdIdSchema, infusionState: z.enum(["running", "paused", "stopped"]) }),
  refusals: ["order_not_found", "order_not_active", "infusion_out_of_order", "second_nurse_required", "time_in_future"],
  actors: ["nurse"],
  copilotProposable: false,
  agentTier: "none",
  undo: "entered_in_error",
  events: ["ipd.infusion.recorded"],
  idempotent: true,
});
