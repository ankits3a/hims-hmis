import { z } from "zod";
import { IpdBedClassSchema } from "../ipd-bed-classes";
import {
  IpdAdmissionStateSchema, IpdBedStatusSchema, IpdIdSchema, IpdInstantSchema, IpdNoteSchema, IpdPaiseSchema,
  IpdPositivePaiseSchema, IpdSignerSchema, IpdTenderSchema, IpdUserRefSchema, ipdInput, ipdIntent,
} from "./common";

/**
 * E0.2 (#714) — bed and admission intents (spec §4.1 ipd-beds, §4.2 ipd-admit). Contracts only: behaviour is
 * the ipd-beds / ipd-admit lanes'. Each `refusals` list is the set of codes the intent may answer with.
 */

const IsolationSchema = z.enum(["none", "contact", "droplet", "airborne"]);
const ConsentSchema = z.strictObject({
  signedBy: IpdSignerSchema,
  documentId: IpdIdSchema,
  /** Required by the intent (not the schema) when `signedBy` is `representative`: why the patient cannot. */
  representativeReason: IpdNoteSchema.optional(),
});
const BandSizeSchema = z.enum(["adult", "paediatric", "neonatal"]);
/** Burns or amputation → ankle band (§4.2). */
const BandSiteSchema = z.enum(["wrist", "ankle"]);
const BandOutput = z.strictObject({ bandId: IpdIdSchema, bandSerial: z.string().min(1), printedAt: IpdInstantSchema });

export const requestAdmission = ipdIntent({
  input: ipdInput({
    patientId: IpdIdSchema,
    source: z.enum(["opd_advice", "ot_daycare_conversion", "direct"]),
    /** The OPD advice, the converted day-care case, … — the record the request is built from (principle 1). */
    sourceRef: IpdIdSchema.optional(),
    consultantId: IpdUserRefSchema,
    requestedClass: IpdBedClassSchema,
    isolation: IsolationSchema,
    /** Absent = today. A future booking's advice expires at planned date + 24 h. */
    plannedFor: IpdInstantSchema.optional(),
    provisionalDiagnosis: IpdNoteSchema,
    mlc: z.boolean(),
  }),
  output: z.strictObject({
    admissionId: IpdIdSchema,
    state: z.literal("requested"),
    expiresAt: IpdInstantSchema,
    /** The roster's covering consultant when the chosen one is on leave; shown, never silent. */
    consultantId: IpdUserRefSchema,
    coveringFor: IpdUserRefSchema.nullable(),
    /** Readmission within 30 days: the consultant is asked about relatedness. */
    readmissionWithin30Days: z.boolean(),
  }),
  refusals: ["patient_not_found", "patient_deceased", "admission_already_open", "incumbent_stay_open", "planned_date_past"],
  actors: ["doctor", "resident", "desk"],
  copilotProposable: true,
  agentTier: "none",
  undo: "undo_window",
  events: ["ipd.admission.requested"],
  idempotent: true,
});

/**
 * Not in the §0B list, which names `cancelled` as a state but no act that reaches it. DECIDED (E0.2): the
 * desk or doctor cancels a request, and the 24-hour advice expiry calls this same intent as a system actor.
 */
export const cancelAdmission = ipdIntent({
  input: ipdInput({
    admissionId: IpdIdSchema,
    reason: z.enum(["patient_declined", "advice_expired", "admitted_elsewhere", "duplicate", "clinical_change", "other"]),
    note: IpdNoteSchema.optional(),
  }),
  output: z.strictObject({ admissionId: IpdIdSchema, state: z.literal("cancelled"), releasedBedId: IpdIdSchema.nullable() }),
  refusals: ["admission_not_found", "admission_wrong_state", "state_changed"],
  actors: ["desk", "doctor", "duty_manager"],
  copilotProposable: true,
  agentTier: "none",
  undo: "irreversible",
  events: ["ipd.admission.cancelled"],
  idempotent: true,
});

/**
 * E1.1 (DECIDED) — what the patient needs from a bed. Until ipd-admit lands there is no admission record to read
 * it from, so the bed intents carry it beside `admissionId`; ipd-admit derives it from the admission and refuses
 * (`state_changed`) when a caller's copy disagrees with the record.
 */
export const IpdBedNeedSchema = z.strictObject({
  requestedClass: IpdBedClassSchema,
  isolation: IsolationSchema,
  /** The patient needs an ICU-flagged bed. An ICU bed refuses a patient who does not. */
  icu: z.boolean(),
  /**
   * §4.1 edge: a patient whose recorded gender is other or unknown is placed by their stated preference. Recorded
   * on the act, never displayed on the board.
   */
  placeAs: z.enum(["male", "female"]).optional(),
});
export type IpdBedNeed = z.infer<typeof IpdBedNeedSchema>;

/** A ward-class bed above (upgrade) or below (downgrade) the class asked for, flagged by the person who chose it. */
export const IpdClassChangeSchema = z.enum(["upgrade", "downgrade"]);

/**
 * E1.1 (DECIDED) — `admissionId` is the admission request's id. ipd-admit mints it at request_admission; until
 * then the caller's request reference stands in for it, and every bed event carries it so the goal queries (G2)
 * correlate the request with its first bed act.
 */
const bedActShape = {
  admissionId: IpdIdSchema,
  bedId: IpdIdSchema,
  patientId: IpdIdSchema,
  need: IpdBedNeedSchema,
  classChange: IpdClassChangeSchema.optional(),
};

const BED_RULE_REFUSALS = [
  "patient_not_found", "bed_not_found", "bed_not_available", "bed_gender_mismatch", "bed_isolation_mismatch", "bed_age_mismatch",
  "bed_class_mismatch", "room_gender_unknown", "bed_retired", "overflow_needs_duty_manager",
] as const;

export const reserveBed = ipdIntent({
  input: ipdInput(bedActShape),
  output: z.strictObject({
    reservationId: IpdIdSchema,
    bedId: IpdIdSchema,
    state: z.literal("reserved"),
    /** Two hours after the reservation; it lapses back to available on its own. */
    expiresAt: IpdInstantSchema,
  }),
  refusals: ["admission_not_found", "admission_wrong_state", ...BED_RULE_REFUSALS, "advice_expired", "repair_ticket_open"],
  actors: ["desk", "supervisor", "duty_manager", "agent"],
  copilotProposable: true,
  agentTier: "T2",
  undo: "undo_window",
  events: ["ipd.bed.reserved", "ipd.admission.reserved"],
  idempotent: true,
});

/** A person releases a reservation; the 2-hour lapse calls this same intent as a system actor. */
export const releaseReservation = ipdIntent({
  input: ipdInput({
    reservationId: IpdIdSchema,
    reason: z.enum(["plan_changed", "lapsed", "bed_unsuitable", "other"]),
    note: IpdNoteSchema.optional(),
  }),
  output: z.strictObject({ bedId: IpdIdSchema, bedStatus: IpdBedStatusSchema, admissionState: IpdAdmissionStateSchema }),
  refusals: ["reservation_not_found", "reservation_ended"],
  actors: ["desk", "supervisor", "duty_manager"],
  copilotProposable: true,
  agentTier: "none",
  undo: "undo_window",
  events: ["ipd.bed.reservation_released"],
  idempotent: true,
});

export const admit = ipdIntent({
  input: ipdInput({
    admissionId: IpdIdSchema,
    bedId: IpdIdSchema,
    consent: ConsentSchema,
    /** Exactly one of a receipt or a recorded exemption; the intent refuses `deposit_required` otherwise. */
    deposit: z.union([
      z.strictObject({ receiptId: IpdIdSchema }),
      z.strictObject({ exempt: z.enum(["emergency_not_stabilised", "scheme", "cashless_no_non_payables", "approved_waiver"]), approvalId: IpdIdSchema.optional() })
        // A waiver is an approver's act: it names the approval. Scheme and emergency exemptions are rules, not favours.
        .refine((d) => d.exempt !== "approved_waiver" || d.approvalId !== undefined, { message: "an approved waiver needs approvalId", path: ["approvalId"] }),
    ]),
    /** The intensivist's approval record, required for an ICU-class bed. */
    intensivistApprovalId: IpdIdSchema.optional(),
  }),
  output: z.strictObject({
    admissionId: IpdIdSchema,
    /** The admission is an encounter of kind `ip`. */
    encounterId: IpdIdSchema,
    state: z.literal("admitted"),
    bedId: IpdIdSchema,
    admittedAt: IpdInstantSchema,
  }),
  refusals: [
    "admission_not_found", "admission_wrong_state", "admission_already_open", "incumbent_stay_open", "advice_expired",
    "icu_needs_intensivist", "bed_not_available", "bed_gender_mismatch", "bed_isolation_mismatch", "bed_age_mismatch",
    "consent_missing", "representative_reason_missing", "deposit_required",
  ],
  actors: ["desk", "duty_manager"],
  copilotProposable: true,
  agentTier: "none",
  undo: "entered_in_error",
  events: ["ipd.admission.admitted", "ipd.bed.occupied"],
  idempotent: true,
});

/** Places an admitted patient on a bed without a reservation, or on a higher class while the booked one is full. */
export const assignBed = ipdIntent({
  input: ipdInput({
    ...bedActShape,
    /** Booked class full → temporary higher class billed at this booked class for 48 hours (§4.2). */
    protectBookedClass: IpdBedClassSchema.optional(),
  }),
  output: z.strictObject({
    admissionId: IpdIdSchema,
    bedId: IpdIdSchema,
    billedClass: IpdBedClassSchema,
    protectedUntil: IpdInstantSchema.nullable(),
  }),
  refusals: ["admission_not_found", "admission_wrong_state", ...BED_RULE_REFUSALS, "icu_needs_intensivist", "repair_ticket_open"],
  actors: ["desk", "nurse", "supervisor", "duty_manager", "agent"],
  copilotProposable: true,
  agentTier: "T2",
  undo: "entered_in_error",
  events: ["ipd.bed.assigned", "ipd.bed.occupied"],
  idempotent: true,
});

export const printBand = ipdIntent({
  input: ipdInput({ admissionId: IpdIdSchema, printerId: IpdIdSchema, size: BandSizeSchema, site: BandSiteSchema }),
  output: BandOutput,
  refusals: ["admission_not_found", "admission_wrong_state", "printer_offline", "band_already_printed"],
  actors: ["desk", "nurse"],
  copilotProposable: true,
  agentTier: "none",
  undo: "irreversible",
  events: ["ipd.band.printed"],
  idempotent: true,
});

export const reprintBand = ipdIntent({
  input: ipdInput({
    admissionId: IpdIdSchema,
    printerId: IpdIdSchema,
    size: BandSizeSchema,
    site: BandSiteSchema,
    reason: z.enum(["damaged", "unreadable", "allergy_added", "details_changed", "uhid_merged"]),
  }),
  output: BandOutput.extend({ voidedBandId: IpdIdSchema }),
  refusals: ["admission_not_found", "admission_wrong_state", "printer_offline", "no_band_to_reprint"],
  actors: ["nurse", "desk"],
  copilotProposable: true,
  agentTier: "none",
  undo: "irreversible",
  events: ["ipd.band.reprinted", "ipd.band.voided"],
  idempotent: true,
});

/** §2 answer 5: the manual authorisation record — pre-auth, each enhancement, the final approval or a denial. */
export const recordPayerAuth = ipdIntent({
  input: ipdInput({
    admissionId: IpdIdSchema,
    payerKind: z.enum(["cash", "insurance_cashless", "insurance_reimbursement", "pmjay", "state_scheme", "corporate"]),
    /** The insurer, TPA, scheme or corporate on the partners register; absent for cash. */
    payerRef: IpdIdSchema.optional(),
    entry: z.enum(["initial", "enhancement", "final", "denial", "payer_change"]),
    preAuthNumber: z.string().trim().min(1).max(64).optional(),
    status: z.enum(["requested", "approved", "partially_approved", "denied", "final_approved"]),
    approvedAmountPaise: IpdPaiseSchema.optional(),
    /** The patient signed at admission that cashless is provisional (§4.2). */
    provisionalCashlessSigned: z.boolean(),
    counsellingDocumentId: IpdIdSchema.optional(),
  }),
  output: z.strictObject({
    authId: IpdIdSchema,
    status: z.enum(["requested", "approved", "partially_approved", "denied", "final_approved"]),
    approvedTotalPaise: IpdPaiseSchema,
    /** Pre-auth approved after admission covers from the admission date (insurer practice). */
    coversFrom: IpdInstantSchema.nullable(),
  }),
  refusals: ["admission_not_found", "admission_wrong_state", "payer_change_needs_counselling", "auth_out_of_order"],
  actors: ["desk", "billing"],
  copilotProposable: false,
  agentTier: "none",
  undo: "entered_in_error",
  events: ["ipd.payer_auth.recorded"],
  idempotent: true,
});

/** Billing's act; its contract lives here so the admission desk and the copilot see one shape. */
export const takeDeposit = ipdIntent({
  input: ipdInput({
    admissionId: IpdIdSchema,
    amountPaise: IpdPositivePaiseSchema,
    tender: IpdTenderSchema,
    /** A relative may pay; the receipt names them and a refund goes back to them (§4.2). */
    payer: z.strictObject({
      name: z.string().trim().min(1).max(120),
      relation: z.enum(["self", "relative", "employer", "other"]),
      phone: z.string().regex(/^[6-9]\d{9}$/).optional(),
    }),
    /** PM-JAY/scheme: the approver's mark that a line is non-covered (§6). */
    nonCoveredApprovalId: IpdIdSchema.optional(),
  }),
  output: z.strictObject({
    receiptId: IpdIdSchema,
    receiptNo: z.string().min(1),
    amountPaise: IpdPositivePaiseSchema,
    depositTotalPaise: IpdPaiseSchema,
  }),
  refusals: [
    "admission_not_found", "admission_wrong_state", "scheme_patient_no_deposit", "cash_limit_reached",
    "deposit_before_stabilisation",
  ],
  actors: ["desk", "billing"],
  copilotProposable: false,
  agentTier: "none",
  undo: "reversal_line",
  events: ["ipd.deposit.taken"],
  idempotent: true,
});

/** Block only an available or cleaning bed; on an occupied bed this records a request that applies on release. */
export const blockBed = ipdIntent({
  input: ipdInput({
    bedId: IpdIdSchema,
    reason: z.enum(["maintenance", "infection_control", "deep_clean", "staff_shortage", "other"]),
    note: IpdNoteSchema,
    expectedReturnAt: IpdInstantSchema,
  }),
  output: z.strictObject({ blockId: IpdIdSchema, bedId: IpdIdSchema, status: z.enum(["blocked", "block_on_release"]) }),
  refusals: ["bed_not_found", "bed_reserved", "bed_retired", "state_changed"],
  actors: ["supervisor", "duty_manager"],
  copilotProposable: true,
  agentTier: "none",
  undo: "undo_window",
  events: ["ipd.bed.blocked"],
  idempotent: true,
});

export const unblockBed = ipdIntent({
  input: ipdInput({ bedId: IpdIdSchema, note: IpdNoteSchema.optional() }),
  output: z.strictObject({ bedId: IpdIdSchema, bedStatus: IpdBedStatusSchema }),
  refusals: ["bed_not_found", "bed_not_blocked", "repair_ticket_open"],
  actors: ["supervisor", "duty_manager"],
  copilotProposable: true,
  agentTier: "none",
  undo: "undo_window",
  events: ["ipd.bed.unblocked"],
  idempotent: true,
});

/**
 * E1.1 (DECIDED) — not in the §0B list, which names "incumbent-occupied beds … released by a tap when the incumbent
 * discharges" (§4.1) but no act. The bed goes to cleaning (or to its block, when one waits for the release).
 */
export const releaseIncumbentBed = ipdIntent({
  input: ipdInput({ bedId: IpdIdSchema, note: IpdNoteSchema.optional() }),
  output: z.strictObject({ bedId: IpdIdSchema, bedStatus: IpdBedStatusSchema }),
  refusals: ["bed_not_found", "bed_not_incumbent"],
  actors: ["desk", "supervisor", "duty_manager"],
  copilotProposable: true,
  agentTier: "none",
  undo: "irreversible",
  events: ["ipd.bed.incumbent_released"],
  idempotent: true,
});

export const markBedClean = ipdIntent({
  input: ipdInput({ bedId: IpdIdSchema, cleanedAt: IpdInstantSchema, checklistDone: z.literal(true) }),
  output: z.strictObject({ bedId: IpdIdSchema, bedStatus: IpdBedStatusSchema }),
  refusals: ["bed_not_found", "bed_not_cleaning", "time_in_future", "device_not_registered"],
  actors: ["nurse", "supervisor", "device"],
  copilotProposable: true,
  agentTier: "none",
  undo: "entered_in_error",
  events: ["ipd.bed.cleaned"],
  idempotent: true,
});
