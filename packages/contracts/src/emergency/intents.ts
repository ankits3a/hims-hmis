import { z } from "zod";
import {
  ErAgeBandSchema, ErArrivalModeSchema, ErBroughtBySchema, ErIdSchema, ErInstantSchema, ErNoteSchema, ErPhoneSchema,
  ErPreAlertModeSchema, ErSexSchema, ErUserRefSchema, ErWordsSchema, erInput, erIntent,
} from "./common";

/**
 * ER lane 1 (#808) — the arrival and identity intents (spec §2 "Arrival", "Identity"; §4.1). Each `refusals` list is
 * the set of codes the intent may answer with.
 *
 * Arrival is recorded before anything else, in at most three taps: the only required answers are sex (or "unknown"), an
 * approximate age band and the arrival mode. Nothing here reads money, and nothing asks a Good Samaritan anything.
 */

/** What the thermal band carries (IPD's band, for an ER episode): identity, the ER number and every alert IN WORDS. */
export const ErBandPayloadSchema = z.strictObject({
  /** The patient's name, or the alias of an unidentified patient ("Unknown-0412"). */
  name: z.string(),
  /** The Hindi alias of an unidentified patient ("अज्ञात-0412"); null for a named patient. */
  nameHi: z.string().nullable(),
  uhid: z.string(),
  /** "~30 y M" from the age band, or "42 y F" from a recorded date of birth. */
  ageSex: z.string(),
  episodeNo: z.string(),
  arrivedOn: z.string(),
  /** "Allergy: Penicillin (severe)"; "Allergy: unknown" for an unidentified patient; "Allergy: none recorded" otherwise. */
  allergyWords: z.array(z.string()),
  /** "Unidentified", "Returned within 24 h". */
  alertWords: z.array(z.string()),
  size: z.enum(["adult", "paediatric", "neonatal"]),
  site: z.enum(["wrist", "ankle"]),
  barcode: z.string(),
  qr: z.string(),
});
export type ErBandPayload = z.infer<typeof ErBandPayloadSchema>;
const BandOutput = z.strictObject({
  bandId: ErIdSchema, bandSerial: z.string().min(1), printedAt: ErInstantSchema, band: ErBandPayloadSchema,
});
const BandSiteSchema = z.enum(["wrist", "ankle"]);
const BandSizeSchema = z.enum(["adult", "paediatric", "neonatal"]);

/** The arrival facts every registration path shares. `arrivedAt` is the GATE instant (seam E1); absent = now. */
const arrivalShape = {
  arrivalMode: ErArrivalModeSchema,
  arrivedAt: ErInstantSchema.optional(),
  /** The ambulance or police call this arrival answers (its card leaves "Expected"). */
  preAlertId: ErIdSchema.optional(),
  broughtBy: ErBroughtBySchema.optional(),
  /** The complaint in the bringer's or patient's words, as heard. Optional: arrival never waits for it. */
  complaint: ErNoteSchema.optional(),
  /** Downtime: the reserved serial of the paper ER sheet this entry back-fills (IPD `backfillDowntime` pattern). */
  paperSerial: z.string().trim().min(1).max(24).optional(),
  /** A band printer at the desk; absent = the desk's browser prints it (decision 0045's fallback). */
  printerId: ErIdSchema.optional(),
  /** Burns or a cast on the wrist → ankle band. */
  bandSite: BandSiteSchema.optional(),
};

const ArrivalOutput = z.strictObject({
  episodeId: ErIdSchema,
  episodeNo: z.string(),
  patientId: ErIdSchema,
  uhid: z.string(),
  state: z.literal("arrived"),
  arrivedAt: ErInstantSchema,
  registeredAt: ErInstantSchema,
  returnedWithin24h: z.boolean(),
  band: BandOutput,
});

export const preAlert = erIntent({
  input: erInput({
    mode: ErPreAlertModeSchema,
    /** Minutes until the vehicle reaches the gate, as the caller said. */
    etaMinutes: z.number().int().min(0).max(240),
    /** How many patients the vehicle brings (a road accident may bring several); each arrival claims one. */
    count: z.number().int().min(1).max(20),
    sex: ErSexSchema.optional(),
    ageBand: ErAgeBandSchema.optional(),
    complaint: ErNoteSchema.optional(),
    caller: ErWordsSchema.optional(),
    callerPhone: ErPhoneSchema.optional(),
    vehicleNo: z.string().trim().min(1).max(20).optional(),
    /** Lane 2 (seam E9): the OPD red flag names the patient it sends, and the rule that fired (`opdTriage.redFlag.<key>`). */
    patientId: ErIdSchema.optional(),
    redFlagKey: z.string().trim().min(1).max(80).optional(),
  }).refine((i) => (i.mode === "opd_red_flag") === (i.patientId !== undefined), {
    message: "an OPD red flag names its patient, and only it does", path: ["patientId"],
  }),
  output: z.strictObject({
    preAlertId: ErIdSchema, state: z.literal("expected"), expectedAt: ErInstantSchema, expiresAt: ErInstantSchema,
  }),
  refusals: ["patient_not_found", "patient_deceased"],
  actors: ["desk", "er_nurse", "doctor", "duty_manager"],
  copilotProposable: true,
  agentTier: "none",
  undo: "irreversible",
  events: ["er.pre_alerted"],
  idempotent: true,
});

/** The desk cancels a call that will not come; the 2-hour lapse calls the same intent as the system actor. */
export const cancelPreAlert = erIntent({
  input: erInput({
    preAlertId: ErIdSchema,
    reason: z.enum(["not_coming", "went_elsewhere", "duplicate", "entered_in_error", "lapsed"]),
  }),
  output: z.strictObject({ preAlertId: ErIdSchema, state: z.literal("cancelled") }),
  refusals: ["pre_alert_not_found", "pre_alert_closed"],
  actors: ["desk", "er_nurse", "duty_manager"],
  copilotProposable: true,
  agentTier: "none",
  undo: "irreversible",
  events: ["er.pre_alert_cancelled"],
  idempotent: true,
});

/**
 * A KNOWN patient (found by the UHID card, Aadhaar QR, ABHA or phone — `patientId`) or a NAMED patient new to the
 * hospital (`newPatient`: name, sex and age band; the rest of the master is completed later). Exactly one.
 */
export const registerArrival = erIntent({
  input: erInput({
    patientId: ErIdSchema.optional(),
    newPatient: z.strictObject({
      name: z.string().trim().min(1).max(120), sex: ErSexSchema, ageBand: ErAgeBandSchema, phone: ErPhoneSchema.optional(),
    }).optional(),
    /** A known patient's age band, when the record has no date of birth (printed "~30 y"). */
    ageBand: ErAgeBandSchema.optional(),
    ...arrivalShape,
  }).refine((i) => (i.patientId === undefined) !== (i.newPatient === undefined), {
    message: "a known patient (patientId) or a new one (newPatient), exactly one", path: ["patientId"],
  }),
  output: ArrivalOutput,
  refusals: [
    "patient_not_found", "patient_deceased", "patient_admitted", "episode_already_open", "pre_alert_not_found",
    "pre_alert_closed", "time_in_future", "arrival_too_old", "paper_serial_used", "registration_not_ready",
    "printer_offline", "state_changed",
  ],
  actors: ["desk", "er_nurse", "duty_manager"],
  copilotProposable: false,
  agentTier: "none",
  undo: "entered_in_error",
  events: ["er.arrived", "er.band_printed"],
  idempotent: true,
});

/**
 * One tap: "Unknown male, ~35 y". A REAL UHID flagged `identity_status = unidentified`, with a sequence alias
 * ("Unknown-0412", Hindi "अज्ञात-0412") — never a temporary or fake UHID (spec §3.4).
 */
export const registerUnidentified = erIntent({
  input: erInput({
    sex: ErSexSchema,
    ageBand: ErAgeBandSchema,
    /** Distinguishing marks in words (tattoo on the left forearm, red shirt) — what tells two unknowns apart. */
    marks: ErNoteSchema.optional(),
    ...arrivalShape,
  }),
  output: ArrivalOutput.extend({ alias: z.string(), aliasHi: z.string() }),
  refusals: [
    "pre_alert_not_found", "pre_alert_closed", "time_in_future", "arrival_too_old", "paper_serial_used",
    "registration_not_ready", "printer_offline", "state_changed",
  ],
  actors: ["desk", "er_nurse", "doctor", "duty_manager"],
  copilotProposable: false,
  agentTier: "none",
  undo: "entered_in_error",
  events: ["er.arrived", "er.band_printed"],
  idempotent: true,
});

/**
 * The brought-dead MARKER (lane 1): a body arrives, a doctor examines it, and the episode is terminal at once — no
 * treatment episode, no band, no charge. The MLC, the mortuary hand-over and the police clearance are lane 4's.
 */
export const recordBroughtDead = erIntent({
  input: erInput({
    patientId: ErIdSchema.optional(),
    unidentified: z.strictObject({ sex: ErSexSchema, ageBand: ErAgeBandSchema, marks: ErNoteSchema.optional() }).optional(),
    arrivalMode: ErArrivalModeSchema,
    arrivedAt: ErInstantSchema.optional(),
    preAlertId: ErIdSchema.optional(),
    broughtBy: ErBroughtBySchema.optional(),
    /** The doctor who examined the body and the time of the examination (ECG strip recorded). */
    examinedBy: ErUserRefSchema,
    examinedAt: ErInstantSchema,
    ecgStripRecorded: z.boolean(),
  }).refine((i) => (i.patientId === undefined) !== (i.unidentified === undefined), {
    message: "a known patient (patientId) or an unidentified body (unidentified), exactly one", path: ["patientId"],
  }),
  output: z.strictObject({
    episodeId: ErIdSchema, episodeNo: z.string(), patientId: ErIdSchema, uhid: z.string(), alias: z.string().nullable(),
    state: z.literal("brought_dead"),
  }),
  refusals: [
    "patient_not_found", "patient_deceased", "patient_admitted", "episode_already_open", "pre_alert_not_found",
    "pre_alert_closed", "time_in_future", "examined_before_arrival", "registration_not_ready", "state_changed",
  ],
  actors: ["desk", "er_nurse", "doctor", "duty_manager"],
  copilotProposable: false,
  agentTier: "none",
  undo: "entered_in_error",
  events: ["er.brought_dead"],
  idempotent: true,
});

/** A band for an episode that has none (a downtime back-fill, a voided band never replaced). */
export const printErBand = erIntent({
  input: erInput({
    episodeId: ErIdSchema, size: BandSizeSchema.optional(), site: BandSiteSchema, printerId: ErIdSchema.optional(),
  }),
  output: BandOutput,
  refusals: ["episode_not_found", "episode_wrong_state", "band_already_printed", "printer_offline"],
  actors: ["desk", "er_nurse", "duty_manager", "device"],
  copilotProposable: true,
  agentTier: "none",
  undo: "reversal_line",
  events: ["er.band_printed"],
  idempotent: true,
});

/** Damaged, unreadable, details changed or the identity confirmed (the true name prints): the old band is voided. */
export const reprintErBand = erIntent({
  input: erInput({
    episodeId: ErIdSchema,
    reason: z.enum(["damaged", "unreadable", "details_changed", "identity_linked", "allergy_added"]),
    size: BandSizeSchema.optional(),
    site: BandSiteSchema.optional(),
    printerId: ErIdSchema.optional(),
  }),
  output: BandOutput.extend({ voidedBandId: ErIdSchema }),
  refusals: ["episode_not_found", "episode_wrong_state", "no_band_to_reprint", "printer_offline"],
  actors: ["desk", "er_nurse", "duty_manager", "device"],
  copilotProposable: true,
  agentTier: "none",
  undo: "reversal_line",
  events: ["er.band_voided", "er.band_printed"],
  idempotent: true,
});

/**
 * An unidentified patient is identified (family, an ID document, police, ABHA): `link_identity` FILES a `patient_merge`
 * request (unknown → true record). The merge itself stays in `patients`, behind the Medical Superintendent's approval
 * (urgent, 240 min); when it runs, everything filed under the unknown record follows the merge chain.
 */
export const linkIdentity = erIntent({
  input: erInput({
    episodeId: ErIdSchema,
    truePatientId: ErIdSchema,
    how: z.enum(["family", "id_document", "police", "abha", "other"]),
    note: ErNoteSchema,
  }),
  output: z.strictObject({
    episodeId: ErIdSchema, mergeRequestId: ErIdSchema, approvalId: ErIdSchema, state: z.literal("merge_requested"),
  }),
  refusals: [
    "episode_not_found", "not_unidentified", "same_patient", "patient_not_found", "true_record_unidentified",
    "merge_already_requested", "patient_deceased", "episode_already_open",
  ],
  actors: ["desk", "supervisor", "duty_manager"],
  copilotProposable: true,
  agentTier: "none",
  undo: "irreversible",
  events: ["er.identity_linked"],
  idempotent: true,
});
