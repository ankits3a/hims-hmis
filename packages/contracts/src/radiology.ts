import { z } from "zod";

/**
 * #1077 — **THE IMAGING ACT BODIES, AS THE SERVER CHECKS THEM.** The radiology controllers parse
 * these (a body they reject is a 400 before anything is read), the web types its calls with them
 * (`z.input`, type-only: the web never builds this package's `dist/`), and the copilot will propose
 * acts in exactly these shapes. They used to be private constants in each `radiology-*.controller.ts`
 * with a hand-transcribed copy per web client file.
 *
 * The vocabularies they name (contrast routes, collector kinds and ID types, the bedside place's
 * length) are the server's: `kernel/db/schema/radiology.ts` and `modules/radiology/kinds.ts` keep the
 * originals the CHECK constraints use, and `act-bodies.test.ts` in that module holds these copies
 * equal to them.
 *
 * Not imported by the phone app (it imports `packages/contracts/src/<file>` one file at a time and
 * cannot resolve `zod`); keep it that way.
 */

const id = z.string().min(1).max(64);

export const IMAGING_CRITICAL_TIERS = ["red", "orange", "yellow"] as const;
export const IMAGING_LATERALITIES_REPORTED = ["left", "right", "bilateral", "na"] as const;
export const IMAGING_IMAGE_SOURCES = ["pacs", "no_pacs_images", "outside"] as const;
export const IMAGING_CONTRAST_ROUTES = [
  "intravenous", "intraarterial", "oral", "rectal", "intraarticular", "intrathecal",
  "intravesical", "intracavitary",
] as const;
export const IMAGING_HANDOVER_COLLECTOR_KINDS = ["patient", "relative", "ward_staff", "courier"] as const;
export const IMAGING_HANDOVER_ID_TYPES = ["aadhaar", "voter_id", "driving_licence", "pan", "passport", "other"] as const;
export const IMAGING_BEDSIDE_LOCATION_MAX_LENGTH = 120;

/* ── the report ── */

/** Draft, prelim and the text of an amendment. */
export const imagingReportContentBody = z.object({
  templateKey: z.string().min(1).max(40).optional(),
  body: z.record(z.string(), z.unknown()),
  impression: z.string().max(8000).nullish(),
  laterality: z.enum(IMAGING_LATERALITIES_REPORTED).nullish(),
  /** F66 — the medical superintendent who approved a demographic-tier lockout hit, and why. */
  lockoutOverride: z.object({
    approvedBy: z.string().min(1).max(64),
    reason: z.string().min(1).max(400),
  }).nullish(),
});

/** 18-S RS8a — the warning codes (`checks.ts`) the signer has read and acknowledges. */
const acknowledgedWarnings = z.array(z.string().min(1).max(60)).max(20).optional();

/** The signature. The second factor is the SESSION's, never the body's (§11.19-D-27). */
export const imagingSignBody = z.object({
  reportId: id,
  criticalCategory: z.enum(IMAGING_CRITICAL_TIERS).nullish(),
  acknowledgedWarnings,
});

/** A2 — v(n+1) signed, v(n) superseded: the new text, the reason, and the signature's own fields. */
export const imagingAmendBody = imagingReportContentBody.extend({
  reason: z.string().min(1).max(400),
  criticalCategory: z.enum(IMAGING_CRITICAL_TIERS).nullish(),
  acknowledgedWarnings,
});

/* ── the console ── */

export const imagingAcquiredBody = z.object({
  imageSource: z.enum(IMAGING_IMAGE_SOURCES),
  /** 18b T2 — optional for `pacs` (the minted one is used), refused for the other two sources. */
  studyInstanceUid: z.string().min(1).max(64).nullish(),
  doseCtdivol: z.number().nonnegative().max(9_999_999).nullish(),
  doseDlp: z.number().nonnegative().max(9_999_999).nullish(),
  doseDap: z.number().nonnegative().max(9_999_999).nullish(),
  fluoroSeconds: z.number().int().nonnegative().max(86_400).nullish(),
  /** 18-S RS12 — mammography's Average Glandular Dose, mGy. */
  doseAgd: z.number().nonnegative().max(9_999_999).nullish(),
  /** 18-S RS12b — reference-point air kerma Ka,r, mGy. */
  doseKar: z.number().nonnegative().max(9_999_999).nullish(),
  doseManual: z.boolean().optional(),
  contrastGiven: z.boolean().optional(),
  contrastAgent: z.string().min(1).max(120).nullish(),
  contrastVolumeMl: z.number().positive().max(999_999).nullish(),
  repeatOfStudyId: id.nullish(),
  repeatReason: z.string().min(1).max(400).nullish(),
  /** 18-S RS6 — why the dose came in above the DRL; kept only beside an over-DRL verdict. */
  drlReason: z.string().min(1).max(400).nullish(),
  /** 18-S RS6 — why a with-contrast examination was scanned plain; rides the bill decision. */
  contrastNotGivenReason: z.string().min(1).max(400).nullish(),
  /** E11 — the PAPER instant for a downtime backfill. `lateEntry` is derived, never sent. */
  acquiredAt: z.string().datetime().optional(),
});

/**
 * 18a-iii T1 — the injection. `volumeMl` is `.positive()`: a one-millilitre TEST DOSE is a real
 * administration and a zero-millilitre one is not an event. `vialExpiry` is a DATE on a label, never
 * an instant, and the service refuses an expired one.
 */
export const imagingContrastBody = z.object({
  agent: z.string().min(1).max(120),
  volumeMl: z.number().positive().max(9_999),
  route: z.enum(IMAGING_CONTRAST_ROUTES),
  site: z.string().min(1).max(120).nullish(),
  vialBatchNo: z.string().min(1).max(60).nullish(),
  vialExpiry: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  givenBy: id,
  givenAt: z.string().datetime(),
});

/* ── the desk ── */

/** 18-S RS9 T4 — who took the report away from the imaging window. Strict: an unknown key is a 400. */
export const imagingHandoverBody = z.object({
  collectorKind: z.enum(IMAGING_HANDOVER_COLLECTOR_KINDS),
  collectorName: z.string().max(120).nullable().optional(),
  collectorRelation: z.string().max(60).nullable().optional(),
  collectorIdType: z.enum(IMAGING_HANDOVER_ID_TYPES).nullable().optional(),
  collectorIdLast4: z.string().max(4).nullable().optional(),
  mediaRequestIds: z.array(id).max(20).optional(),
  note: z.string().max(300).nullable().optional(),
}).strict();

const scheduleFields = {
  deviceResourceId: id,
  /** An ISO instant. The caller resolves the clock; a route that took a date and a time would be a second place that knows about IST. */
  scheduledAt: z.string().datetime(),
  /**
   * 18a-iii T3 / D4 — the ward and bed, when the machine goes to the patient. Absent leaves the
   * row's value alone; explicit `null` clears it. Only a portable device accepts one.
   */
  bedsideLocation: z.string().min(1).max(IMAGING_BEDSIDE_LOCATION_MAX_LENGTH).nullish(),
};
export const imagingScheduleBody = z.object(scheduleFields);
/** 18-S RS3 — a move carries the desk's reason; `nullish` at the wire so the refusal is the domain's `reason_required`. */
export const imagingRescheduleBody = z.object({ ...scheduleFields, reason: z.string().max(400).nullish() });

export type ImagingReportContentBody = z.input<typeof imagingReportContentBody>;
export type ImagingSignBody = z.input<typeof imagingSignBody>;
export type ImagingAmendBody = z.input<typeof imagingAmendBody>;
export type ImagingAcquiredBody = z.input<typeof imagingAcquiredBody>;
export type ImagingContrastBody = z.input<typeof imagingContrastBody>;
export type ImagingHandoverBody = z.input<typeof imagingHandoverBody>;
export type ImagingScheduleBody = z.input<typeof imagingScheduleBody>;
export type ImagingRescheduleBody = z.input<typeof imagingRescheduleBody>;
