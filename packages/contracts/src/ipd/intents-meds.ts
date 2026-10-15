import { z } from "zod";
import { IpdIdSchema, IpdInstantSchema, IpdNoteSchema, IpdUserRefSchema, ipdInput, ipdIntent } from "./common";
import { DOSE_UNITS, RX_FREQUENCIES } from "../rx-line";

/**
 * E0.2 (#714) — inpatient orders and the eMAR (spec §4.5A ipd-rounds orders, §4.6 ipd-emar). Contracts only.
 *
 * §4.11: doses and orders have NO agent tier and are never on a copilot proposal card — not today, not later.
 * The acceptance suite pins that for every intent in this file.
 */

/** E4.3 review — the emergencies a verbal order may be taken in (DECIDED, standard ward practice). */
export const IPD_VERBAL_EMERGENCIES = [
  "cardiac_arrest", "acute_deterioration", "seizure", "severe_pain", "hypoglycaemia", "anaphylaxis", "other_emergency",
] as const;
/** E4.3 review — why a pharmacist verifies through an allergy (structured; the text says the rest). */
export const IPD_ALLERGY_OVERRIDE_REASONS = ["tolerated_before", "desensitised", "no_safe_alternative", "benefit_outweighs_risk"] as const;
/** E4.3 review — why a second issue of one order is made. */
export const IPD_REISSUE_REASONS = ["lost", "damaged", "extra_supply"] as const;

/** E4.2 review: an inpatient drug dose names a unit of the shared prescription vocabulary (`DOSE_UNITS`). */
const IpdDoseSchema = z.strictObject({ value: z.number().positive().max(1_000_000), unit: z.enum(DOSE_UNITS) });
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
  dose: IpdDoseSchema,
  route: z.enum(IPD_DRUG_ROUTES),
  /** The shared prescription vocabulary (`RX_FREQUENCIES`, rx-line.ts): `SOS` ⇔ a `prn` block (the intent cross-checks). */
  frequency: z.enum(RX_FREQUENCIES),
  startAt: IpdInstantSchema,
  /** Required by the intent for an antibiotic (§4.5A). */
  stopAt: IpdInstantSchema.optional(),
  /** The course length; a drug order carries this or a stop time. */
  durationDays: z.number().int().min(1).max(365).optional(),
  /** The prescriber's flag; the server ALSO treats every AWaRe-classified medicine as an antibiotic. */
  antibiotic: z.boolean(),
  prn: z.strictObject({ minIntervalMinutes: z.number().int().positive(), max24h: z.number().int().positive() }).optional(),
  weightBasedPerKg: z.boolean().optional(),
  /** Today's weight; else the latest recorded weight (30 days). Needed for a weight-based dose and for every child (< 16). */
  weightKg: z.number().positive().max(400).optional(),
  /** Ordering through a recorded allergy (CPOE override): the reason is kept and the pharmacist re-checks it (eMAR). */
  allergyOverrideReason: IpdNoteSchema.optional(),
  /** An antibiotic course longer than 14 days needs its reason. */
  longCourseReason: IpdNoteSchema.optional(),
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
    verbal: z.strictObject({
      fromDoctorId: IpdUserRefSchema,
      readBack: z.literal(true),
      /** E4.3 (#735) — why it could not wait for the doctor's own order (verbal orders are emergency-only, §4.6). */
      emergency: z.enum(IPD_VERBAL_EMERGENCIES),
      emergencyNote: IpdNoteSchema.optional(),
    }).optional(),
    note: IpdNoteSchema.optional(),
    /** The round this order was written on (E4.2 review: round orders are linked). */
    roundId: IpdIdSchema.optional(),
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
    "stop_date_past", "course_too_long", "prn_mismatch", "dose_out_of_range", "dose_unit_mismatch", "route_mismatch",
    "round_not_found", "verbal_doctor_invalid",
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

/**
 * E4.3 (#735) — the pharmacist's verification. The server runs the four checks itself (allergy — salt-aware, the OPD
 * prescription's matcher; interaction — the formulary's adopted pairs; dose — the order's ceiling and weight; duplicate
 * therapy — the same moiety or the same duplicate class on another active order) and answers the findings. `checks`
 * are the pharmacist's ticks: `verified` needs all four ticked, and any finding needs the pharmacist's `note`.
 * A prescriber's allergy override arrives flagged: verifying it needs `note` too.
 */
export const verifyOrder = ipdIntent({
  input: ipdInput({
    orderId: IpdIdSchema,
    decision: z.enum(["verified", "rejected", "query"]),
    checks: z.strictObject({ allergy: z.boolean(), interaction: z.boolean(), dose: z.boolean(), duplicate: z.boolean() }),
    /** Required by the intent when the decision is not `verified`, and when the checks found anything. */
    note: IpdNoteSchema.optional(),
    /** E4.3 review — verifying through an allergy finding needs a structured reason and its text. */
    allergyOverride: z.strictObject({ reason: z.enum(IPD_ALLERGY_OVERRIDE_REASONS), text: IpdNoteSchema }).optional(),
  }),
  output: z.strictObject({
    orderId: IpdIdSchema,
    status: z.enum(["verified", "rejected", "query"]),
    /** The doses scheduled from the order (0 for SOS / PRN, 1 for STAT). */
    dosesScheduled: z.number().int().nonnegative(),
  }),
  refusals: [
    "order_not_found", "order_not_pending", "order_not_active", "allergy_conflict", "checks_incomplete", "verify_note_required", "state_changed",
    "verify_own_order", "allergy_override_required",
  ],
  actors: ["pharmacist"],
  copilotProposable: false,
  agentTier: "none",
  undo: "entered_in_error",
  events: ["ipd.order.verified"],
  idempotent: true,
});

/**
 * Issue with a patient-specific label per unit or strip: Indian strips often carry no barcode (§4.6). E4.3 (#735): the
 * stock leaves the pharmacy store through the materials ledger (FEFO when no batch is named); `stripSize` units share one
 * label (1 = a label per unit). A PATIENT'S OWN MEDICINE (`ownMedicine`) moves no stock and is never charged: the
 * pharmacist has checked it (name, strength, expiry — `ownBatch`), labels it and it is stored on the ward.
 * `labelPrinterId` names a print computer that must be alive; without it the labels print from the browser.
 */
export const issueMed = ipdIntent({
  input: ipdInput({
    orderId: IpdIdSchema,
    units: z.number().int().positive().max(500),
    batchId: IpdIdSchema.optional(),
    labelPrinterId: IpdIdSchema.optional(),
    /** The patient's own medicine: verified, labelled, stored, never charged. */
    ownMedicine: z.boolean(),
    /** Units that share one label (a strip). 1 = one label per unit. */
    stripSize: z.number().int().positive().max(100).optional(),
    /** Own medicine only: what the pharmacist read off the pack. */
    ownBatch: z.strictObject({ batchNo: z.string().trim().min(1).max(64), expiry: z.iso.date() }).optional(),
    /** E4.3 review — a second issue of one order says why: lost and damaged supersede the live issue's labels. */
    reissue: z.strictObject({ reason: z.enum(IPD_REISSUE_REASONS), note: IpdNoteSchema }).optional(),
  }),
  output: z.strictObject({ issueId: IpdIdSchema, units: z.number().int().positive(), labelIds: z.array(IpdIdSchema).min(1) }),
  refusals: [
    "order_not_found", "order_not_verified", "order_not_active", "stock_short", "printer_offline", "medicine_not_stocked", "own_medicine_unchecked",
    "already_issued", "reissue_limit", "batch_mismatch",
  ],
  actors: ["pharmacist"],
  copilotProposable: false,
  agentTier: "none",
  undo: "reversal_line",
  events: ["ipd.med.issued"],
  idempotent: true,
});

/** The patient check of a give: the wristband's scan, or a reasoned override (counted per nurse and ward). */
const PatientCheckSchema = z.union([
  z.strictObject({ kind: z.literal("scan"), wristbandCode: z.string().trim().min(1).max(128) }),
  z.strictObject({
    kind: z.literal("override"),
    overrideReason: z.enum(["band_unreadable", "band_refused", "no_band_burns", "scanner_down"]),
    note: IpdNoteSchema,
  }),
]);

/** A dose given. Never queued offline; a retried give records once (the idempotency key). */
export const administerDose = ipdIntent({
  input: ipdInput({
    ...DoseSlot,
    givenAt: IpdInstantSchema,
    patientCheck: PatientCheckSchema,
    labelCode: z.string().trim().min(1).max(128),
    /** High-alert drugs: a second nurse's PIN, proven by a short-lived token from the PIN check. */
    secondNurse: z.strictObject({ userId: IpdUserRefSchema, pinProof: z.string().min(1).max(256) }).optional(),
    weightKg: z.number().positive().max(400).optional(),
    /** E4.3 (#735) — a look-alike / sound-alike drug: the nurse confirmed the tall-man name on the screen. */
    lasaConfirmed: z.literal(true).optional(),
    /** E4.3 (#735) — a missed dose given late (inside the catch-up window) says why. */
    lateReason: IpdNoteSchema.optional(),
    /**
     * E4.3 review — an oral or enteral dose while NPO: the nurse confirms the doctor allows medicines with sips (recorded,
     * counted); on an OT case's NPO that is not enough before the case ends — a doctor's read-back OK is needed.
     */
    npoMeds: z.union([
      z.strictObject({ kind: z.literal("sips_allowed"), reason: IpdNoteSchema }),
      z.strictObject({ kind: z.literal("doctor_ok"), doctorId: IpdUserRefSchema, readBack: z.literal(true), reason: IpdNoteSchema }),
    ]).optional(),
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
    "lasa_confirm_required", "allergy_conflict", "dose_not_found", "late_reason_required", "order_not_verified",
    "label_exhausted", "label_void", "patient_npo", "npo_doctor_ok_required", "weight_changed_reverify", "verbal_doctor_invalid",
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
  refusals: ["order_not_found", "order_not_active", "dose_already_recorded", "dose_not_found", "outside_due_window"],
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
  refusals: ["order_not_found", "order_not_active", "dose_already_recorded", "dose_not_found", "outside_due_window"],
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
    /** E4.3 review — a start or a rate change is a give: the wristband (or a reasoned override) and the bag's label. */
    patientCheck: PatientCheckSchema.optional(),
    labelCode: z.string().trim().min(1).max(128).optional(),
  }),
  output: z.strictObject({ infusionEventId: IpdIdSchema, infusionState: z.enum(["running", "paused", "stopped"]) }),
  refusals: [
    "order_not_found", "order_not_active", "infusion_out_of_order", "second_nurse_required", "second_nurse_same_person", "time_in_future", "order_not_verified",
    "wristband_scan_required", "wrong_patient_scanned", "wrong_drug_scanned", "label_void", "give_expired",
  ],
  actors: ["nurse"],
  copilotProposable: false,
  agentTier: "none",
  undo: "entered_in_error",
  events: ["ipd.infusion.recorded"],
  idempotent: true,
});

// ═══════════════════════════════════════ E4.3 (#735) — the eMAR's own acts (DECIDED, §4.6) ═══════════════════════════════════════

/** A scheduled dose nobody gave by the end of its window is MISSED by the minute sweep; a nurse may record it first, with why. */
export const missDose = ipdIntent({
  input: ipdInput({
    ...DoseSlot,
    reason: z.enum(["no_stock", "patient_away", "omitted", "other"]),
    note: IpdNoteSchema.optional(),
  }),
  output: z.strictObject({ missId: IpdIdSchema }),
  refusals: ["order_not_found", "dose_not_found", "dose_already_recorded", "outside_due_window"],
  actors: ["nurse"],
  copilotProposable: false,
  agentTier: "none",
  undo: "entered_in_error",
  events: ["ipd.dose.missed"],
  idempotent: true,
});

/** NPO lifted or the patient back on the ward: every dose held "re-offer on return" is offered again (§4.6). */
export const reofferHeldDoses = ipdIntent({
  input: ipdInput({ admissionId: IpdIdSchema, reason: z.enum(["back_on_ward", "npo_lifted"]) }),
  output: z.strictObject({ reoffered: z.number().int().nonnegative() }),
  refusals: ["admission_not_found", "admission_wrong_state"],
  actors: ["nurse"],
  copilotProposable: false,
  agentTier: "none",
  undo: "irreversible",
  events: ["ipd.dose.reoffered"],
  idempotent: true,
});

/**
 * A recorded outcome that was wrong: never deleted, never edited. `entered_in_error` marks a record that never happened
 * (wrong patient's chart); `medication_incident` keeps the dose as GIVEN and opens the pharmacy's medication-incident
 * register entry (NCC MERP stage `administration`).
 */
export const markDoseInError = ipdIntent({
  input: ipdInput({
    actId: IpdIdSchema,
    kind: z.enum(["entered_in_error", "medication_incident"]),
    reason: IpdNoteSchema,
    incident: z.strictObject({
      type: z.enum(["wrong_drug", "wrong_strength", "wrong_dose", "wrong_patient", "wrong_route", "lasa_mixup", "omission", "other"]),
      category: z.enum(["C", "D", "E", "F", "G", "H", "I"]),
    }).optional(),
  }),
  output: z.strictObject({ correctionId: IpdIdSchema, incidentNo: z.string().nullable() }),
  refusals: ["dose_act_not_found", "dose_act_already_corrected", "incident_details_required"],
  actors: ["nurse", "supervisor"],
  copilotProposable: false,
  agentTier: "none",
  undo: "irreversible",
  events: ["ipd.dose.corrected"],
  idempotent: true,
});

/**
 * The second nurse proves presence at the first nurse's phone with THEIR username and PIN: the answer is a short-lived,
 * single-use proof (`pinProof`) bound to the first nurse. Never the same person; the checker must hold a nursing role.
 */
export const secondCheck = ipdIntent({
  input: ipdInput({
    purpose: z.enum(["high_alert_dose", "infusion", "narcotic_wastage"]),
    /** E4.3 review — the proof is bound to this order (and, for a scheduled dose, this slot) and spent only there. */
    orderId: IpdIdSchema,
    doseDueAt: IpdInstantSchema.optional(),
    username: z.string().trim().min(1).max(64),
    pin: z.string().min(4).max(12),
  }),
  output: z.strictObject({ pinProof: z.string().min(1), userId: IpdUserRefSchema, name: z.string(), expiresAt: IpdInstantSchema }),
  refusals: ["second_nurse_same_person", "second_nurse_not_confirmed", "second_nurse_not_nurse", "order_not_found", "dose_not_found"],
  actors: ["nurse"],
  copilotProposable: false,
  agentTier: "none",
  undo: "irreversible",
  events: ["ipd.second_check.passed"],
  idempotent: true,
});

/** The doctor named on a verbal order (or a treating consultant) signs it within 24 hours. */
export const signVerbalOrder = ipdIntent({
  input: ipdInput({ orderId: IpdIdSchema }),
  output: z.strictObject({ orderId: IpdIdSchema, signedAt: IpdInstantSchema }),
  refusals: ["order_not_found", "verbal_order_not_found", "verbal_order_signed", "not_treating_team"],
  actors: ["doctor", "resident"],
  copilotProposable: false,
  agentTier: "none",
  undo: "irreversible",
  events: ["ipd.verbal_order.signed"],
  idempotent: true,
});

/** A narcotic dose part-used or dropped: the wastage goes on the ward register with a second nurse as witness. */
export const recordNarcoticWastage = ipdIntent({
  input: ipdInput({
    orderId: IpdIdSchema,
    /** E4.3 review — in the issue's BASE unit (the register keeps one unit on every row), e.g. 0.5 of an ampoule. */
    qty: z.number().positive().max(10_000),
    reason: IpdNoteSchema,
    witness: z.strictObject({ userId: IpdUserRefSchema, pinProof: z.string().min(1).max(256) }),
  }),
  output: z.strictObject({ entryId: IpdIdSchema }),
  refusals: ["order_not_found", "not_a_narcotic", "second_nurse_required", "second_nurse_same_person"],
  actors: ["nurse"],
  copilotProposable: false,
  agentTier: "none",
  undo: "entered_in_error",
  events: ["ipd.narcotic.wasted"],
  idempotent: true,
});

/**
 * 2026-10-14 — THE SHIFT-CHANGE NARCOTIC COUNT (NDPS / NABH). Two nurses count the ward cabinet together: the counting
 * nurse sends every controlled drug's counted quantity (in the register's base unit), and the second nurse confirms at the
 * same phone with THEIR username and PIN. Every drug the register expects on the ward must be counted. A count that
 * differs from the register is an exception: the nursing supervisor and the pharmacy are told.
 */
export const recordNarcoticCount = ipdIntent({
  input: ipdInput({
    wardId: IpdIdSchema,
    lines: z.array(z.strictObject({
      medicineId: IpdIdSchema,
      unit: z.string().trim().min(1).max(32),
      counted: z.number().min(0).max(100_000),
    })).min(1).max(200),
    secondNurse: z.strictObject({ username: z.string().trim().min(1).max(64), pin: z.string().min(4).max(12) }),
  }),
  output: z.strictObject({
    roundId: IpdIdSchema,
    mismatches: z.number().int().min(0),
    lines: z.array(z.strictObject({ countId: IpdIdSchema, medicineId: IpdIdSchema, unit: z.string(), expected: z.number(), counted: z.number(), variance: z.number() })),
  }),
  refusals: ["ward_not_found", "narcotic_count_incomplete", "second_nurse_same_person", "second_nurse_not_confirmed", "second_nurse_not_nurse"],
  actors: ["nurse", "supervisor"],
  copilotProposable: false,
  agentTier: "none",
  undo: "irreversible",
  events: ["ipd.narcotic.counted", "ipd.narcotic.count_mismatch"],
  idempotent: true,
});

/**
 * 2026-10-14 — a count exception closed by the nursing supervisor (or the pharmacist) with what was found. The counted
 * quantity becomes the register's agreed balance from that count on.
 */
export const resolveNarcoticException = ipdIntent({
  input: ipdInput({ countId: IpdIdSchema, note: IpdNoteSchema }),
  output: z.strictObject({ countId: IpdIdSchema, resolvedAt: IpdInstantSchema }),
  refusals: ["narcotic_count_not_found", "narcotic_count_matched", "narcotic_count_resolved", "not_narcotic_resolver"],
  actors: ["supervisor", "pharmacist"],
  copilotProposable: false,
  agentTier: "none",
  undo: "irreversible",
  events: ["ipd.narcotic.count_resolved"],
  idempotent: true,
});

/** Unused issued units back to the pharmacy (order stopped after issue, discharge): stock in, the units credited. */
export const returnMed = ipdIntent({
  input: ipdInput({ issueId: IpdIdSchema, units: z.number().int().positive().max(500), reason: IpdNoteSchema }),
  output: z.strictObject({ returnId: IpdIdSchema, units: z.number().int().positive(), creditedUnits: z.number().int().nonnegative() }),
  refusals: ["issue_not_found", "return_exceeds_issue"],
  actors: ["pharmacist"],
  copilotProposable: false,
  agentTier: "none",
  undo: "irreversible",
  events: ["ipd.med.returned"],
  idempotent: true,
});

/** An allergy added after the order: the pharmacist closes the open flag once the doctor has decided (or the order stops). */
export const resolveAllergyFlag = ipdIntent({
  input: ipdInput({ flagId: IpdIdSchema, note: IpdNoteSchema }),
  output: z.strictObject({ flagId: IpdIdSchema, resolvedAt: IpdInstantSchema }),
  refusals: ["allergy_flag_not_found", "allergy_flag_resolved", "allergy_flag_undecided"],
  actors: ["pharmacist"],
  copilotProposable: false,
  agentTier: "none",
  undo: "irreversible",
  events: ["ipd.allergy_flag.resolved"],
  idempotent: true,
});

/**
 * E4.3 review — the doctor's decision on an allergy flag: STOP the order (future doses cancelled, the return owed) or
 * CONTINUE with a reason. Only then may the pharmacist close the flag.
 */
export const decideAllergyFlag = ipdIntent({
  input: ipdInput({ flagId: IpdIdSchema, decision: z.enum(["stop", "continue"]), reason: IpdNoteSchema }),
  output: z.strictObject({ flagId: IpdIdSchema, decision: z.enum(["stop", "continue"]) }),
  refusals: ["allergy_flag_not_found", "allergy_flag_resolved", "not_treating_team"],
  actors: ["doctor", "resident"],
  copilotProposable: false,
  agentTier: "none",
  undo: "irreversible",
  events: ["ipd.allergy_flag.decided"],
  idempotent: true,
});
