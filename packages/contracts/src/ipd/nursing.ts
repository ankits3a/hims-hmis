import { z } from "zod";
import { IpdIdSchema, IpdInstantSchema, IpdNoteSchema, IpdProvenanceSchema, ipdInput } from "./common";
import { IpdCopilotBySchema, IpdCopilotRecordSchema, IpdCopilotSourceSchema, IpdDraftProvenanceSchema, IpdDraftStampSchema } from "./copilot";
import { IPD_CONSCIOUSNESS, IPD_EWS_BANDS, IPD_EWS_KINDS } from "./ews";
import { IpdNurseRefSchema } from "./nurse-ward";

export * from "./ews";
export { IPD_LINE_DEVICE_KINDS } from "./intents-ward";

/**
 * E4.1 (#733) — IPD NURSING: the ward nurse station (board C), my shift on the phone (board D1), the patient's nursing
 * chart, and the nursing acts that are not in spec §0B's catalogue (DECIDED: intake/output, nursing notes, the shift
 * handover and the early-warning acknowledgement are module acts with their own contracts here; `record_vitals` and
 * `record_nursing_assessment` stay §0B intents in `intents-ward.ts`).
 *
 * No money anywhere (decision 0058). Patient names travel to staff screens only through the identity rule (alias when
 * restricted, "Sealed patient" and no bed text when sealed). Every observation carries its provenance.
 */

export const IpdEwsScoreViewSchema = z.object({
  kind: z.enum(IPD_EWS_KINDS),
  value: z.number().int(),
  band: z.enum(IPD_EWS_BANDS),
  complete: z.boolean(),
  /** Against the set before: up, down or flat; null for the first set. */
  trend: z.enum(["up", "down", "flat"]).nullable(),
  at: IpdInstantSchema,
});
export type IpdEwsScoreView = z.infer<typeof IpdEwsScoreViewSchema>;

/** The one identity header (spec §0A principle 4), as the reader may see it. */
export const IpdNursingIdentitySchema = z.object({
  admissionId: IpdIdSchema,
  admissionNo: z.string().nullable(),
  name: z.string(),
  uhid: z.string(),
  ageSex: z.string(),
  sealed: z.boolean(),
});
export type IpdNursingIdentity = z.infer<typeof IpdNursingIdentitySchema>;

export const IPD_NURSING_CHIPS = ["allergy", "fall_risk", "pressure_risk", "isolation", "name_alert", "obstetric"] as const;
export type IpdNursingChip = (typeof IPD_NURSING_CHIPS)[number];

/** What is due next for a patient: vitals or the admission assessment. `overdue` once `dueAt` has passed. */
export const IpdNursingDueSchema = z.object({
  kind: z.enum(["vitals", "assessment"]),
  dueAt: IpdInstantSchema,
  overdue: z.boolean(),
});

export const IpdEwsAlertViewSchema = z.object({
  alertId: IpdIdSchema,
  band: z.enum(IPD_EWS_BANDS),
  raisedAt: IpdInstantSchema,
  /** A DOCTOR's acknowledgement (stops the 10-minute escalation). */
  acknowledgedAt: IpdInstantSchema.nullable(),
  /** A nurse's or supervisor's acknowledgement: seen, the escalation runs on. */
  seenAt: IpdInstantSchema.nullable(),
  /** False while no notice reached anybody (the sweep retries); the station says "No doctor reached — call". */
  doctorReached: z.boolean(),
});

/** One bed card on the nurse station (board C). Empty beds carry no patient. */
export const IpdStationBedSchema = z.object({
  bedId: IpdIdSchema,
  /** Null for a SEALED patient's bed (no bed text anywhere on a sealed row, review #767). */
  code: z.string().nullable(),
  status: z.enum(["occupied", "available", "reserved", "cleaning", "blocked", "incumbent"]),
  /** When the bed entered its status (an empty bed's "Free · cleaned 10:12"). */
  since: IpdInstantSchema.nullable(),
  patient: IpdNursingIdentitySchema.nullable(),
  consultant: z.string().nullable(),
  dayOfStay: z.number().int().positive().nullable(),
  chips: z.array(z.enum(IPD_NURSING_CHIPS)),
  score: IpdEwsScoreViewSchema.nullable(),
  /** The score kind this patient is charted on, even before a first set. */
  scoreKind: z.enum(IPD_EWS_KINDS).nullable(),
  next: IpdNursingDueSchema.nullable(),
  alert: IpdEwsAlertViewSchema.nullable(),
  discharge: z.enum(["fit_declared", "discharging"]).nullable(),
  transferring: z.boolean(),
  /** Sort key for "Needs me" order: higher first (score rising, alert, overdue). */
  needs: z.number().int().nonnegative(),
  /** WM-1 (#982): the bed's nurse on the live shift map; null when none (red on an occupied bed). */
  nurse: IpdNurseRefSchema.nullable().optional(),
});
export type IpdStationBed = z.infer<typeof IpdStationBedSchema>;

export const IpdNurseStationSchema = z.object({
  asOf: IpdInstantSchema,
  wards: z.array(z.object({ id: IpdIdSchema, code: z.string(), name: z.string() })),
  ward: z.object({ id: IpdIdSchema, code: z.string(), name: z.string() }).nullable(),
  shift: z.object({ key: z.enum(["morning", "evening", "night"]), startsAt: IpdInstantSchema, endsAt: IpdInstantSchema }),
  /** Night mode 22:00–06:00 IST (spec §0A principle 10), decided by the server's clock. */
  night: z.boolean(),
  top: z.object({
    census: z.number().int().nonnegative(),
    beds: z.number().int().nonnegative(),
    free: z.number().int().nonnegative(),
    expected: z.number().int().nonnegative(),
    dischargesToday: z.number().int().nonnegative(),
    overdue: z.number().int().nonnegative(),
    alerts: z.number().int().nonnegative(),
    handoversWaiting: z.number().int().nonnegative(),
  }),
  beds: z.array(IpdStationBedSchema),
});
export type IpdNurseStation = z.infer<typeof IpdNurseStationSchema>;

/** One line of "my shift" (board D1), in time order. */
export const IpdShiftItemSchema = z.object({
  /** WM-2 (#983): `care_check` (a fall / pressure care plan's timed check; refId = the plan) and `restraint_check` (refId = the restraint). */
  kind: z.enum(["ews", "vitals", "assessment", "handover", "care_check", "restraint_check"]),
  admissionId: IpdIdSchema,
  bedCode: z.string().nullable(),
  name: z.string(),
  dueAt: IpdInstantSchema,
  overdue: z.boolean(),
  /** ews: the alert; handover: the handover id; care_check: the care plan; restraint_check: the restraint. */
  refId: IpdIdSchema.nullable(),
  band: z.enum(IPD_EWS_BANDS).nullable(),
});
export type IpdShiftItem = z.infer<typeof IpdShiftItemSchema>;

export const IpdMyShiftSchema = z.object({
  asOf: IpdInstantSchema,
  night: z.boolean(),
  ward: z.object({ id: IpdIdSchema, code: z.string(), name: z.string() }).nullable(),
  wards: z.array(z.object({ id: IpdIdSchema, code: z.string(), name: z.string() })),
  shift: z.object({ key: z.enum(["morning", "evening", "night"]), startsAt: IpdInstantSchema, endsAt: IpdInstantSchema }),
  patients: z.array(z.object({ identity: IpdNursingIdentitySchema, bedCode: z.string().nullable(), scoreKind: z.enum(IPD_EWS_KINDS) })),
  now: z.array(IpdShiftItemSchema),
  /**
   * WM-1 (#982): `ward` = no live shift map yet, so the list is the whole ward ("no assignment yet"); `mine` = the beds
   * the live map gives this nurse (or her student); `none` = a live map gives her no bed.
   */
  assignment: z.enum(["ward", "mine", "none"]).optional(),
});
export type IpdMyShift = z.infer<typeof IpdMyShiftSchema>;

export const IpdVitalsRowSchema = z.object({
  id: IpdIdSchema,
  observedAt: IpdInstantSchema,
  recordedAt: IpdInstantSchema,
  lateEntry: z.boolean(),
  source: IpdProvenanceSchema,
  recordedBy: z.string(),
  refused: z.boolean(),
  values: z.object({
    temperatureC: z.number().nullable(), pulse: z.number().nullable(), respRate: z.number().nullable(),
    systolic: z.number().nullable(), diastolic: z.number().nullable(), spo2: z.number().nullable(),
    onOxygen: z.boolean().nullable(), consciousness: z.enum(IPD_CONSCIOUSNESS).nullable(), painScore: z.number().nullable(),
    capRefillSec: z.number().nullable(),
  }),
  score: z.object({ kind: z.enum(IPD_EWS_KINDS), value: z.number().int(), band: z.enum(IPD_EWS_BANDS), complete: z.boolean() }).nullable(),
});
export type IpdVitalsRow = z.infer<typeof IpdVitalsRowSchema>;

export const IPD_IO_KINDS = {
  in: ["oral", "iv", "ng_feed", "blood"],
  out: ["urine", "drain", "vomit", "stool", "ng_aspirate"],
} as const;
export const IPD_IO_ALL_KINDS = [...IPD_IO_KINDS.in, ...IPD_IO_KINDS.out] as const;

export const IPD_NOTE_CATEGORIES = ["general", "fall", "pain", "wound", "behaviour", "escalation", "refused_care"] as const;

export const IpdNursingChartSchema = z.object({
  asOf: IpdInstantSchema,
  identity: IpdNursingIdentitySchema,
  bedCode: z.string().nullable(),
  scoreKind: z.enum(IPD_EWS_KINDS),
  vitals: z.array(IpdVitalsRowSchema),
  assessment: z.object({
    id: IpdIdSchema, happenedAt: IpdInstantSchema, recordedAt: IpdInstantSchema, lateEntry: z.boolean(), recordedBy: z.string(),
    morse: z.number().int(), morseRisk: z.enum(["low", "moderate", "high"]),
    braden: z.number().int(), bradenRisk: z.enum(["none", "mild", "moderate", "high", "very_high"]),
    painScore: z.number().int(), nutrition: z.string(), allergies: z.array(z.string()),
    linesDevices: z.array(z.object({ kind: z.string(), site: z.string().nullable() })),
    obstetric: z.enum(["none", "pregnant", "postpartum"]).nullable(),
  }).nullable(),
  assessmentDueAt: IpdInstantSchema.nullable(),
  io: z.object({
    /** The 24-hour I/O day starts at 08:00 IST. */
    since: IpdInstantSchema,
    inMl: z.number().int().nonnegative(),
    outMl: z.number().int().nonnegative(),
    entries: z.array(z.object({
      id: IpdIdSchema, observedAt: IpdInstantSchema, direction: z.enum(["in", "out"]), kind: z.enum(IPD_IO_ALL_KINDS),
      volumeMl: z.number().int(), recordedBy: z.string(), source: IpdProvenanceSchema,
    })),
  }),
  notes: z.array(z.object({
    id: IpdIdSchema, observedAt: IpdInstantSchema, recordedAt: IpdInstantSchema, category: z.enum(IPD_NOTE_CATEGORIES),
    text: z.string(), source: IpdProvenanceSchema, recordedBy: z.string(), lateEntry: z.boolean(),
  })),
  alert: IpdEwsAlertViewSchema.nullable(),
  next: IpdNursingDueSchema.nullable(),
});
export type IpdNursingChart = z.infer<typeof IpdNursingChartSchema>;

// ═══════════════════════════════════════════ the acts ═══════════════════════════════════════════

export const IpdIntakeOutputInputSchema = ipdInput({
  admissionId: IpdIdSchema,
  observedAt: IpdInstantSchema,
  source: IpdProvenanceSchema,
  direction: z.enum(["in", "out"]),
  kind: z.enum(IPD_IO_ALL_KINDS),
  volumeMl: z.number().int().min(1).max(5000),
  note: IpdNoteSchema.optional(),
}).superRefine((v, ctx) => {
  if (!(IPD_IO_KINDS[v.direction] as readonly string[]).includes(v.kind)) {
    ctx.addIssue({ code: "custom", path: ["kind"], message: `${v.kind} is not an ${v.direction === "in" ? "intake" : "output"} kind` });
  }
});
export type IpdIntakeOutputInput = z.infer<typeof IpdIntakeOutputInputSchema>;

export const IpdNursingNoteInputSchema = ipdInput({
  admissionId: IpdIdSchema,
  observedAt: IpdInstantSchema,
  /** A copilot draft is saved only when a named nurse signs it: the source says where the words came from. */
  source: z.enum(["person", "copilot_draft"]),
  category: z.enum(IPD_NOTE_CATEGORIES),
  text: z.string().trim().min(1).max(2000),
});
export type IpdNursingNoteInput = z.infer<typeof IpdNursingNoteInputSchema>;

const SbarIn = z.strictObject({
  situation: IpdNoteSchema, background: IpdNoteSchema, assessment: IpdNoteSchema, recommendation: IpdNoteSchema,
});
/** `draftId` (E5.4): the copilot draft the nurse edited and is signing; the handover keeps that draft's provenance. */
export const IpdGiveShiftHandoverInputSchema = ipdInput({ admissionId: IpdIdSchema, sbar: SbarIn, draftId: IpdIdSchema.optional() });
export const IpdAcceptShiftHandoverInputSchema = ipdInput({ handoverId: IpdIdSchema });
export const IpdAcknowledgeEwsInputSchema = ipdInput({ alertId: IpdIdSchema, note: IpdNoteSchema.optional() });

/** One SBAR line drawn from the record, with its source chip (spec §0A principle 6). */
export const IpdSbarLineSchema = z.object({
  text: z.string(), source: IpdCopilotSourceSchema,
  /** E5.4 — `model` = a model's sentence over the shift's notes, verified against them; every other line is the record's. */
  by: IpdCopilotBySchema.default("template"),
  records: z.array(IpdCopilotRecordSchema).default([]),
});
export const IpdHandoverDraftSchema = z.object({
  admissionId: IpdIdSchema,
  /** E5.4 — set once the draft is built and kept (`POST`); the give names it. Null on the plain read. */
  draftId: IpdIdSchema.nullable().default(null),
  stamp: IpdDraftStampSchema.nullable().default(null),
  /** A kept draft exists for this shift but the records changed since it was built: build again. */
  changedSinceDraft: z.boolean().default(false),
  truncated: z.array(z.string()).default([]),
  situation: z.array(IpdSbarLineSchema),
  background: z.array(IpdSbarLineSchema),
  assessment: z.array(IpdSbarLineSchema),
  recommendation: z.array(IpdSbarLineSchema),
});
export type IpdHandoverDraft = z.infer<typeof IpdHandoverDraftSchema>;

export const IpdShiftHandoverCardSchema = z.object({
  handoverId: IpdIdSchema,
  identity: IpdNursingIdentitySchema,
  bedCode: z.string().nullable(),
  wardId: IpdIdSchema.nullable(),
  wardName: z.string().nullable(),
  shift: z.enum(["morning", "evening", "night"]),
  sbar: z.object({ situation: z.string(), background: z.string(), assessment: z.string(), recommendation: z.string() }),
  givenAt: IpdInstantSchema,
  givenBy: z.object({ id: z.string(), name: z.string() }),
  givenByViewer: z.boolean(),
  /** E5.4 — the copilot draft the giver signed from (model id, prompt version, built at); null when typed. */
  draft: IpdDraftProvenanceSchema.nullable(),
});
export type IpdShiftHandoverCard = z.infer<typeof IpdShiftHandoverCardSchema>;
export const IpdShiftHandoverListSchema = z.object({ asOf: IpdInstantSchema, handovers: z.array(IpdShiftHandoverCardSchema) });
export type IpdShiftHandoverList = z.infer<typeof IpdShiftHandoverListSchema>;

/** The live topic every nursing surface refetches on (one topic; the payloads carry ids only). */
export const IPD_NURSING_TOPIC = "ipd_nursing:board";

/** Physiological limits (the typo guard, §4.5): outside them a value needs "confirm". */
export const IPD_VITALS_LIMITS = {
  temperatureC: [34, 42], pulse: [30, 200], respRate: [6, 60], systolic: [60, 250], diastolic: [30, 150], spo2: [70, 100],
} as const;

/** A set typed this long after it was taken is a late entry: dual-stamped and flagged (§4.5). */
export const IPD_LATE_ENTRY_MINUTES = 15;
/** The phone keeps a vitals set queued offline for at most this long (§0B "Offline"). */
export const IPD_OFFLINE_QUEUE_MINUTES = 30;
/** The nursing admission assessment is due within this many minutes of admission (§4.5). */
export const IPD_ASSESSMENT_DUE_MINUTES = 60;
/** An unacknowledged early-warning alert goes to the nursing supervisor after this long (§4.10 edge 12). */
export const IPD_EWS_UNACKED_MINUTES = 10;

/** HTTP routes (under the api prefix). */
export const IPD_NURSING_ROUTES = {
  station: "/ipd/nursing/station",
  myShift: "/ipd/nursing/my-shift",
  chart: "/ipd/nursing/admissions/:id/chart",
  handoverDraft: "/ipd/nursing/admissions/:id/handover-draft",
  assessment: "/ipd/nursing/assessment",
  vitals: "/ipd/nursing/vitals",
  intakeOutput: "/ipd/nursing/intake-output",
  note: "/ipd/nursing/note",
  shiftHandovers: "/ipd/nursing/shift-handovers",
  giveHandover: "/ipd/nursing/shift-handovers/give",
  acceptHandover: "/ipd/nursing/shift-handovers/accept",
  acknowledgeEws: "/ipd/nursing/ews/acknowledge",
} as const;
