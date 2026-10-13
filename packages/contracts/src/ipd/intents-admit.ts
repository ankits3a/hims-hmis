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
/**
 * E1.2 (ipd-admit, DECIDED): how a consent was taken. A tablet signature or an OTP to the attendant files a document
 * (`documentId`); the fallback is the paper form, ticked "paper consent signed" with the witness's name. OTP and
 * e-sign integration are later work: until then `otp` and `tablet_signature` carry the captured document.
 */
export const IPD_CONSENT_METHODS = ["tablet_signature", "otp", "paper"] as const;
const ConsentSchema = z.strictObject({
  signedBy: IpdSignerSchema,
  /** The filed consent document. Required unless the method is `paper` (then the witness stands for it). */
  documentId: IpdIdSchema.optional(),
  /** Required by the intent (not the schema) when `signedBy` is `representative`: why the patient cannot. */
  representativeReason: IpdNoteSchema.optional(),
  method: z.enum(IPD_CONSENT_METHODS).optional(),
  /** Who signed, when not the patient (guardian, representative), and their relation to the patient. */
  signerName: z.string().trim().min(1).max(120).optional(),
  relation: z.string().trim().min(1).max(40).optional(),
  witnessName: z.string().trim().min(1).max(120).optional(),
  language: z.enum(["hi", "en"]).optional(),
})
  .refine((c) => c.method === "paper" || c.documentId !== undefined, { message: "a consent names its document unless signed on paper", path: ["documentId"] })
  .refine((c) => c.method !== "paper" || c.witnessName !== undefined, { message: "a paper consent names its witness", path: ["witnessName"] })
  .refine((c) => c.signedBy === "patient" || (c.signerName !== undefined && c.relation !== undefined), { message: "a guardian or representative is named with their relation", path: ["signerName"] });
export type IpdConsent = z.infer<typeof ConsentSchema>;
export { ConsentSchema as IpdConsentSchema };
const BandSizeSchema = z.enum(["adult", "paediatric", "neonatal"]);
/** Burns or amputation → ankle band (§4.2). */
const BandSiteSchema = z.enum(["wrist", "ankle"]);
/**
 * E1.2 — what the thermal band carries (§2 answer 4): identity, admission, bed, and every alert IN WORDS, because
 * colour alone is not an identifier. `barcode` (Code 128) and `qr` encode the band serial; a scanner resolves the
 * serial against the band register, so a voided band fails.
 */
export const IpdBandPayloadSchema = z.strictObject({
  name: z.string(),
  uhid: z.string(),
  ageSex: z.string(),
  dob: z.string().nullable(),
  admissionNo: z.string(),
  admittedOn: z.string(),
  bedCode: z.string().nullable(),
  consultant: z.string(),
  /** "Allergy: Penicillin (severe)"; "Allergy: none recorded" when the record holds none. */
  allergyWords: z.array(z.string()),
  /** Other alerts in words: "MLC", "Isolation: airborne". */
  alertWords: z.array(z.string()),
  /** Newborn: the mother's name rides on the band (§4.2). */
  motherName: z.string().nullable(),
  size: z.enum(["adult", "paediatric", "neonatal"]),
  site: z.enum(["wrist", "ankle"]),
  barcode: z.string(),
  qr: z.string(),
});
export type IpdBandPayload = z.infer<typeof IpdBandPayloadSchema>;
const BandOutput = z.strictObject({
  bandId: IpdIdSchema, bandSerial: z.string().min(1), printedAt: IpdInstantSchema, band: IpdBandPayloadSchema,
});

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
    /** E1.2: the department the patient is admitted under (OPD department code). */
    department: z.string().trim().min(1).max(16).optional(),
    /** §4.1 edge: placement preference when the recorded gender is other or unknown. Never displayed. */
    placeAs: z.enum(["male", "female"]).optional(),
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
  refusals: ["admission_not_found", "admission_wrong_state", "state_changed", "deposit_not_refunded"],
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
  refusals: ["admission_not_found", "admission_wrong_state", ...BED_RULE_REFUSALS, "advice_expired"],
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
    "consent_missing", "representative_reason_missing", "deposit_required", "plan_missing",
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
  refusals: ["admission_not_found", "admission_wrong_state", ...BED_RULE_REFUSALS, "icu_needs_intensivist"],
  actors: ["desk", "nurse", "supervisor", "duty_manager", "agent"],
  copilotProposable: true,
  agentTier: "T2",
  undo: "entered_in_error",
  events: ["ipd.bed.assigned", "ipd.bed.occupied"],
  idempotent: true,
});

export const printBand = ipdIntent({
  /** `printerId` = an enrolled print computer; absent = printed from the desk's browser (decision 0045). */
  input: ipdInput({ admissionId: IpdIdSchema, printerId: IpdIdSchema.optional(), size: BandSizeSchema, site: BandSiteSchema }),
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
    printerId: IpdIdSchema.optional(),
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
  refusals: ["admission_not_found", "admission_wrong_state", "payer_change_needs_counselling", "auth_out_of_order", "rate_missing"],
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
    /** The UPI/card settlement reference the ledger needs for any tender but cash. */
    tenderRef: z.string().trim().min(1).max(64).optional(),
    /** Cash at the PAN threshold (Rule 114B): the payer's PAN, or Form 60. */
    panNumber: z.string().trim().regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/).optional(),
  }),
  output: z.strictObject({
    receiptId: IpdIdSchema,
    receiptNo: z.string().min(1),
    amountPaise: IpdPositivePaiseSchema,
    depositTotalPaise: IpdPaiseSchema,
  }),
  refusals: [
    "admission_not_found", "admission_wrong_state", "scheme_patient_no_deposit", "cash_limit_reached",
    "deposit_before_stabilisation", "plan_missing",
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
  refusals: ["bed_not_found", "bed_not_blocked"],
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

// ═══════════════════════════════════ E1.2 (ipd-admit) — acts the §0B list does not name ═══════════════════════════════════

/** Who pays (§2 answer 5). The six kinds the payer record and the deposit rules read. */
export const IPD_PAYER_KINDS = ["cash", "insurance_cashless", "insurance_reimbursement", "pmjay", "state_scheme", "corporate"] as const;
export const IpdPayerKindSchema = z.enum(IPD_PAYER_KINDS);
export type IpdPayerKind = z.infer<typeof IpdPayerKindSchema>;

/** How the deposit was decided (decision 0072 answer 3). Every basis but the zero ones reads the active tariff. */
export const IPD_DEPOSIT_BASES = [
  "medical_class_days", "icu_class_days", "surgery_estimate_share", "scheme_zero", "cashless_non_payables", "emergency_exempt",
  /** Review #7 (DECIDED): a downtime admission's deposit was settled on paper; the bill desk checks it. */
  "downtime_backfill",
] as const;

/**
 * DECIDED (E1.2) — the desk's payer-and-estimate step (§4.9 B "payer and estimate"): the payer kind, the coverage it
 * rests on, the class and the plan. It computes the deposit from the active tariff (never a typed number) and
 * records it on the admission; `take_deposit` and `admit` read it. Before admission only: a payer change after
 * admission is `record_payer_auth`'s `payer_change` entry with counselling.
 */
export const planAdmission = ipdIntent({
  input: ipdInput({
    admissionId: IpdIdSchema,
    payerKind: IpdPayerKindSchema,
    /** The patient's coverage row (insurer, scheme or corporate) this admission rests on; absent for cash. */
    coverageId: IpdIdSchema.optional(),
    requestedClass: IpdBedClassSchema,
    /** Medical (3 class days) or a planned surgery (50 % of the procedure estimate or package). */
    plan: z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("medical") }),
      z.strictObject({ kind: z.literal("surgical"), procedureEstimatePaise: IpdPositivePaiseSchema }),
    ]),
  }),
  output: z.strictObject({
    admissionId: IpdIdSchema,
    requestedClass: IpdBedClassSchema,
    /**
     * Three days of the class's daily charges from the active tariff (the estimate shown beside the deposit); null
     * when the class carries no daily rates (an emergency bay) and the deposit does not need them.
     */
    estimatePaise: IpdPaiseSchema.nullable(),
    depositRequiredPaise: IpdPaiseSchema,
    depositBasis: z.enum(IPD_DEPOSIT_BASES),
  }),
  refusals: ["admission_not_found", "admission_wrong_state", "rate_missing", "advice_expired"],
  actors: ["desk", "billing"],
  copilotProposable: true,
  agentTier: "none",
  undo: "undo_window",
  events: ["ipd.admission.planned"],
  idempotent: true,
});

/** The "still to do" items an emergency admission carries until someone fills them (§4.9 B emergency lane). */
export const IPD_ADMISSION_INCOMPLETE = ["consent", "payer", "band", "stabilised", "diagnosis"] as const;
export type IpdAdmissionIncomplete = (typeof IPD_ADMISSION_INCOMPLETE)[number];

/**
 * §4.9 B — the emergency lane: one tap admits onto a bed with the least identity the patient has; no deposit before
 * stabilisation (decision 0072); consent, payer, band and diagnosis catch up and the admission reads "incomplete"
 * until they do. ICU still needs the intensivist's approval: a clerk alone cannot put a patient in ICU.
 */
export const emergencyAdmit = ipdIntent({
  input: ipdInput({
    patientId: IpdIdSchema,
    bedId: IpdIdSchema,
    consultantId: IpdUserRefSchema,
    isolation: IsolationSchema,
    provisionalDiagnosis: IpdNoteSchema.optional(),
    mlc: z.boolean(),
    placeAs: z.enum(["male", "female"]).optional(),
    /**
     * Review #10: an ICU bed's approval is scoped to the ADMISSION. The desk asks first (the server mints the admission
     * id the approval names) and sends that id here with the approval; the admission is created under it.
     */
    admissionId: IpdIdSchema.optional(),
    intensivistApprovalId: IpdIdSchema.optional(),
  }).refine((b) => b.intensivistApprovalId === undefined || b.admissionId !== undefined, {
    message: "an ICU approval names the admission it was asked for", path: ["admissionId"],
  }),
  output: z.strictObject({
    admissionId: IpdIdSchema,
    admissionNo: z.string().min(1),
    encounterId: IpdIdSchema,
    state: z.literal("admitted"),
    bedId: IpdIdSchema,
    admittedAt: IpdInstantSchema,
    incomplete: z.array(z.enum(IPD_ADMISSION_INCOMPLETE)),
  }),
  refusals: [
    "patient_not_found", "patient_deceased", "admission_already_open", "icu_needs_intensivist", ...BED_RULE_REFUSALS,
  ],
  actors: ["desk", "duty_manager"],
  copilotProposable: false,
  agentTier: "none",
  undo: "entered_in_error",
  events: ["ipd.admission.requested", "ipd.admission.admitted", "ipd.bed.occupied"],
  idempotent: true,
});

/**
 * §4.2 edge — an admission made on paper during downtime, entered afterwards with the paper's own times and its
 * reserved serial. The serial is unique: a second entry of one paper form is refused, showing the first.
 */
export const backfillDowntime = ipdIntent({
  input: ipdInput({
    paperSerial: z.string().trim().min(1).max(32),
    patientId: IpdIdSchema,
    bedId: IpdIdSchema,
    consultantId: IpdUserRefSchema,
    requestedClass: IpdBedClassSchema,
    isolation: IsolationSchema,
    provisionalDiagnosis: IpdNoteSchema,
    mlc: z.boolean(),
    payerKind: IpdPayerKindSchema,
    /** The paper form's times; never later than now. */
    requestedAt: IpdInstantSchema,
    admittedAt: IpdInstantSchema,
    consent: ConsentSchema,
    /** The paper deposit receipt's number, when one was written. */
    paperReceiptNo: z.string().trim().min(1).max(32).optional(),
    placeAs: z.enum(["male", "female"]).optional(),
    classChange: IpdClassChangeSchema.optional(),
    intensivistApprovalId: IpdIdSchema.optional(),
  }).refine((b) => new Date(b.requestedAt).getTime() <= new Date(b.admittedAt).getTime(), {
    message: "the request cannot be later than the admission", path: ["requestedAt"],
  }),
  output: z.strictObject({
    admissionId: IpdIdSchema,
    admissionNo: z.string().min(1),
    encounterId: IpdIdSchema,
    state: z.literal("admitted"),
    bedId: IpdIdSchema,
    admittedAt: IpdInstantSchema,
  }),
  refusals: [
    "patient_not_found", "patient_deceased", "admission_already_open", "downtime_serial_used", "time_in_future",
    "icu_needs_intensivist", "representative_reason_missing", ...BED_RULE_REFUSALS,
  ],
  actors: ["desk", "duty_manager"],
  copilotProposable: false,
  agentTier: "none",
  undo: "entered_in_error",
  events: ["ipd.admission.backfilled", "ipd.admission.admitted", "ipd.bed.occupied"],
  idempotent: true,
});

/** Consent that caught up after an emergency admission (or was retaken). */
export const recordConsent = ipdIntent({
  input: ipdInput({ admissionId: IpdIdSchema, consent: ConsentSchema }),
  output: z.strictObject({ admissionId: IpdIdSchema, consentAt: IpdInstantSchema }),
  refusals: ["admission_not_found", "admission_wrong_state", "representative_reason_missing"],
  actors: ["desk", "nurse"],
  copilotProposable: false,
  agentTier: "none",
  undo: "entered_in_error",
  events: ["ipd.admission.consented"],
  idempotent: true,
});

/** The treating team marks an emergency patient stabilised; only then may the desk ask for a deposit. */
export const recordStabilised = ipdIntent({
  input: ipdInput({ admissionId: IpdIdSchema, stabilisedAt: IpdInstantSchema }),
  output: z.strictObject({ admissionId: IpdIdSchema, stabilisedAt: IpdInstantSchema }),
  refusals: ["admission_not_found", "admission_wrong_state", "time_in_future"],
  actors: ["doctor", "resident", "nurse"],
  copilotProposable: true,
  agentTier: "none",
  undo: "entered_in_error",
  events: ["ipd.admission.stabilised"],
  idempotent: true,
});
