import { z } from "zod";

/**
 * ICU IC-1 (#984, spec docs/specs/984-icu-core.md, decision 0090) — the wire shapes of the ICU core: the ICU request,
 * device links, the gateway feed (option A: numbers from the maker's central station), the hourly chart, the alarm
 * ladder, bundles, and the family's daily update. Numbers are never events: they live in `icu_numerics` only.
 */

const id = z.string().min(1).max(64);
const instant = z.iso.datetime({ offset: true });
const note = z.string().trim().min(1).max(1000);

/* ═══ vocabulary ═══ */

export const ICU_REQUEST_SOURCES = ["er", "ward", "ot"] as const;
export type IcuRequestSource = (typeof ICU_REQUEST_SOURCES)[number];
export const ICU_REQUEST_STATES = ["pending", "on_hold", "approved", "refused", "cancelled"] as const;
export type IcuRequestState = (typeof ICU_REQUEST_STATES)[number];
export const ICU_DECISIONS = ["approve", "refuse", "hold"] as const;
export type IcuDecision = (typeof ICU_DECISIONS)[number];
/** DECIDED (standard practice): a hold with monitoring is reviewed again within this many minutes unless the intensivist names a time. */
export const ICU_HOLD_REVIEW_MINUTES = 60;

export const ICU_DEVICE_TYPES = ["monitor", "ventilator", "pump"] as const;
export type IcuDeviceType = (typeof ICU_DEVICE_TYPES)[number];
export const ICU_LINK_END_REASONS = ["unlinked", "transfer", "discharge", "death", "bed_change"] as const;
export type IcuLinkEndReason = (typeof ICU_LINK_END_REASONS)[number];

/** The numbers HMIS keeps. `ventilator` params come from the ventilator link; every other from the monitor link. */
export const ICU_PARAMS = [
  "hr", "spo2", "rr", "nibp_sys", "nibp_dia", "nibp_map", "abp_sys", "abp_dia", "abp_map", "temp", "etco2", "cvp",
  "vt", "peep", "fio2", "ppeak",
] as const;
export type IcuParam = (typeof ICU_PARAMS)[number];
export const ICU_VENT_PARAMS: readonly IcuParam[] = ["vt", "peep", "fio2", "ppeak"];
export const ICU_PARAM_UNITS: Record<IcuParam, string> = {
  hr: "/min", spo2: "%", rr: "/min", nibp_sys: "mmHg", nibp_dia: "mmHg", nibp_map: "mmHg", abp_sys: "mmHg", abp_dia: "mmHg",
  abp_map: "mmHg", temp: "°C", etco2: "mmHg", cvp: "mmHg", vt: "mL", peep: "cmH2O", fio2: "%", ppeak: "cmH2O",
};
export const icuDeviceTypeOfParam = (p: IcuParam): IcuDeviceType => (ICU_VENT_PARAMS.includes(p) ? "ventilator" : "monitor");

/** The sampling the gateway sends (decision 0090 / plan): one sample per 5 s, batched each 30 s; at most 120 per batch. */
export const ICU_SAMPLE_SECONDS = 5;
export const ICU_BATCH_MAX_SAMPLES = 120;
/** |received − sent| above this flags the batch `icu.clock_drift_flagged` and stamps the received time instead. */
export const ICU_CLOCK_SKEW_LIMIT_MS = 120_000;
/** D7: a hall's feed silent for more than this greys the station and switches charting to manual. */
export const ICU_FEED_STALE_MS = 300_000;
/** Raw 5-second rows are kept this long in daily partitions, then the partition is dropped. */
export const ICU_RAW_RETENTION_MS = 72 * 3_600_000;
/** D6: a doctor-set limit lasts this long. */
export const ICU_LIMIT_TTL_MS = 24 * 3_600_000;
/** Advisory alarms: a breach of the doctor's limits sustained this long. */
export const ICU_ADVISORY_SUSTAIN_MS = 20_000;
/** The hourly pre-fill reads the median of linked, non-technical values in the last 60 s before the hour mark. */
export const ICU_PREFILL_WINDOW_MS = 60_000;

export const ICU_ALARM_SEVERITIES = ["life_threatening", "high", "medium", "low", "advisory"] as const;
export type IcuAlarmSeverity = (typeof ICU_ALARM_SEVERITIES)[number];
export const ICU_ALARM_RUNGS = ["bed_nurse", "station", "duty_doctor", "intensivist"] as const;
export type IcuAlarmRung = (typeof ICU_ALARM_RUNGS)[number];
/** Plan "Ladder clocks": bed nurse 60 s, then station 60 s, then duty doctor 120 s, then the intensivist (the last rung). */
export const ICU_RUNG_CLOCK_MS: Record<Exclude<IcuAlarmRung, "intensivist">, number> = { bed_nurse: 60_000, station: 60_000, duty_doctor: 120_000 };
/** Alarm storm: this many alarms on one bed inside the window flags the in-charge (and caps advisory alarms). */
export const ICU_STORM_COUNT = 10;
export const ICU_STORM_WINDOW_MS = 10 * 60_000;

export const ICU_LINE_KINDS = ["central_line", "arterial_line", "urinary_catheter", "endotracheal_tube"] as const;
export type IcuLineKind = (typeof ICU_LINE_KINDS)[number];

export const ICU_BUNDLE_KINDS = ["ventilator", "central_line", "catheter", "sepsis_hour1", "dvt", "pressure"] as const;
export type IcuBundleKind = (typeof ICU_BUNDLE_KINDS)[number];
/** DECIDED (standard ICU practice): how often each bundle falls due while its trigger stands; sepsis hour-1 is once. */
export const ICU_BUNDLE_INTERVAL_MS: Record<IcuBundleKind, number> = {
  ventilator: 8 * 3_600_000, central_line: 24 * 3_600_000, catheter: 24 * 3_600_000, sepsis_hour1: 60 * 60_000,
  dvt: 24 * 3_600_000, pressure: 2 * 3_600_000,
};

/* ═══ inputs ═══ */

export const IcuTriageSchema = z.strictObject({
  news2: z.number().int().min(0).max(20).optional(),
  qsofa: z.number().int().min(0).max(3).optional(),
  sofa: z.number().int().min(0).max(24).optional(),
  gcs: z.number().int().min(3).max(15).optional(),
  apache2: z.number().int().min(0).max(71).optional(),
  lactate: z.number().min(0).max(30).optional(),
});
export type IcuTriage = z.infer<typeof IcuTriageSchema>;

export const icuRequestInput = z.strictObject({
  patientId: id,
  /** The open admission when the patient is already on a ward (a step-up); none from the ER or OT before admission. */
  admissionId: id.optional(),
  source: z.enum(ICU_REQUEST_SOURCES),
  priorityClass: z.number().int().min(1).max(4),
  reason: note,
  triage: IcuTriageSchema.default({}),
});
export type IcuRequestInput = z.input<typeof icuRequestInput>;

export const icuDecisionInput = z.strictObject({
  requestId: id,
  decision: z.enum(ICU_DECISIONS),
  /** Mandatory for every decision (a refusal or a hold is logged with a reason and a name). */
  reason: note,
  /** A hold: when to look again (default now + ICU_HOLD_REVIEW_MINUTES). */
  reviewAt: instant.optional(),
  /** A hold: the monitoring asked for while the patient waits. */
  monitoring: z.string().trim().min(1).max(500).optional(),
});

export const icuLinkInput = z.strictObject({
  /** What the scanner read off the device's asset label. */
  deviceScan: z.string().trim().min(1).max(200),
  /** What the scanner read off the patient's wristband (Code 128 serial or the QR). */
  bandScan: z.string().trim().min(1).max(200),
});
export const icuUnlinkInput = z.strictObject({ deviceScan: z.string().trim().min(1).max(200), reason: z.string().trim().max(300).optional() });

export const icuGatewayInput = z.strictObject({
  hallId: id, name: z.string().trim().min(1).max(120), agentId: id,
});
export const icuSlotInput = z.strictObject({ gatewayId: id, slot: z.string().trim().min(1).max(40), bedId: id });
export const icuCodeInput = z.strictObject({
  gatewayId: id, code: z.string().trim().min(1).max(120), param: z.enum(ICU_PARAMS), unit: z.string().trim().max(20).optional(),
});

export const IcuFeedSampleSchema = z.strictObject({
  slot: z.string().min(1).max(40),
  /** The raw OBX code (identifier^text^system as the station sent it). */
  code: z.string().min(1).max(120),
  value: z.number().finite().nullable(),
  /** The raw unit as the station sent it (an MDC dimension name can run long). */
  unit: z.string().max(60).optional(),
  /** The device's own clock (stored, not trusted). */
  at: instant,
  /** A technical reading (probe off, artefact, lead off): kept, marked, never charted as real. */
  technical: z.enum(["probe_off", "lead_off", "artefact", "calibrating"]).optional(),
  deviceSerial: z.string().max(80).optional(),
});
export type IcuFeedSample = z.infer<typeof IcuFeedSampleSchema>;
export const IcuFeedAlarmSchema = z.strictObject({
  slot: z.string().min(1).max(40),
  code: z.string().min(1).max(120).optional(),
  severity: z.enum(["life_threatening", "high", "medium", "low"]),
  message: z.string().min(1).max(200),
  at: instant,
  deviceSerial: z.string().max(80).optional(),
});
export type IcuFeedAlarm = z.infer<typeof IcuFeedAlarmSchema>;
export const icuFeedBatchInput = z.strictObject({
  batchRef: z.string().min(1).max(80),
  sentAt: instant,
  samples: z.array(IcuFeedSampleSchema).max(ICU_BATCH_MAX_SAMPLES),
  alarms: z.array(IcuFeedAlarmSchema).max(50).default([]),
});
export type IcuFeedBatch = z.input<typeof icuFeedBatchInput>;
export type IcuFeedResult = { accepted: number; duplicate: boolean; quarantined: number; serverTime: string; driftFlagged: boolean };

export const IcuChartValuesSchema = z.partialRecord(z.enum(ICU_PARAMS), z.number().finite());
export const icuPrefillInput = z.strictObject({ admissionId: id, hourStart: instant });
export const icuSignInput = z.strictObject({ hourId: id });
/** `reason` may arrive empty so the refusal can say `reason_required` (a correction without a reason is refused, D4). */
export const icuCorrectInput = z.strictObject({ hourId: id, param: z.enum(ICU_PARAMS), value: z.number().finite(), reason: z.string().trim().max(1000).default("") });
export const icuManualHourInput = z.strictObject({
  admissionId: id, hourStart: instant, values: IcuChartValuesSchema,
  /** When the observation was made (a back-fill from paper names it); default the hour mark. */
  happenedAt: instant.optional(),
});

export const icuLimitInput = z.strictObject({
  admissionId: id, param: z.enum(ICU_PARAMS),
  low: z.number().finite().optional(), high: z.number().finite().optional(),
  reason: z.string().trim().max(300).optional(),
}).refine((v) => v.low !== undefined || v.high !== undefined, { message: "name a low or a high limit" })
  .refine((v) => v.low === undefined || v.high === undefined || v.low < v.high, { message: "low must be below high" });
export const icuAckInput = z.strictObject({ alarmId: id, note: z.string().trim().max(300).optional() });

export const icuLineInput = z.strictObject({
  admissionId: id, kind: z.enum(ICU_LINE_KINDS), site: z.string().trim().min(1).max(80), insertedAt: instant.optional(),
});
export const icuLineRemoveInput = z.strictObject({ lineId: id, removedAt: instant.optional() });
export const icuSepsisInput = z.strictObject({ admissionId: id, suspectedAt: instant.optional() });
export const icuBundleDoneInput = z.strictObject({
  bundleId: id, checks: z.array(z.string().trim().min(1).max(80)).min(1).max(12), note: z.string().trim().max(300).optional(),
});

export const icuVisitInput = z.strictObject({
  admissionId: id, startsAt: instant, endsAt: instant, visitorName: z.string().trim().min(1).max(120),
  relation: z.string().trim().min(1).max(40),
}).refine((v) => Date.parse(v.startsAt) < Date.parse(v.endsAt), { message: "the visit must end after it starts" });
export const icuFamilyUpdateInput = z.strictObject({
  admissionId: id, summary: z.string().trim().min(2).max(600), givenTo: z.string().trim().min(1).max(120),
  relation: z.string().trim().min(1).max(40), mode: z.enum(["in_person", "phone", "video"]),
});

/* ═══ read models ═══ */

export type IcuRequestView = {
  id: string; patientId: string; patientName: string; uhid: string; admissionId: string | null; source: IcuRequestSource;
  priorityClass: number; triage: IcuTriage; reason: string; state: IcuRequestState; requestedBy: string; requestedAt: string;
  approvalId: string | null; decidedBy: string | null; decidedAt: string | null; decisionReason: string | null;
  reviewAt: string | null; monitoring: string | null;
};

export type IcuTile = {
  admissionId: string; patientName: string; uhid: string; bedId: string; bedName: string; dayOfStay: number;
  /** The latest charted-eligible value of each parameter (linked, non-technical), with its instant. */
  latest: Partial<Record<IcuParam, { value: number; at: string }>>;
  /** Seconds since the newest linked sample, or null when nothing is linked. */
  freshnessSeconds: number | null;
  devices: { type: IcuDeviceType; code: string; linkedAt: string }[];
  openAlarms: { id: string; severity: IcuAlarmSeverity; message: string; rung: IcuAlarmRung; raisedAt: string; param: IcuParam | null }[];
  storm: boolean;
  limits: { param: IcuParam; low: number | null; high: number | null; expiresAt: string }[];
  /** Six hours of one-per-minute values for the sparklines (hr, spo2, map). */
  spark: Partial<Record<IcuParam, number[]>>;
  bundlesDue: number; bundlesMissed: number;
  hourDue: boolean;
};

export type IcuStationView = {
  hallId: string; hallName: string; asOf: string;
  /** D7: the feed is silent past ICU_FEED_STALE_MS — every tile grey, charting manual. */
  grey: boolean; mode: "live" | "manual"; feedLastSeenAt: string | null; gapSince: string | null;
  tiles: IcuTile[];
};

export type IcuChartValueView = {
  id: string; param: IcuParam; value: number | null; source: "device" | "manual" | "correction"; technical: string | null;
  happenedAt: string; enteredAt: string; enteredBy: string | null; reason: string | null; supersedes: string | null; current: boolean;
};
export type IcuChartHourView = {
  id: string; hourStart: string; state: "draft" | "signed"; mode: "device" | "manual"; signedBy: string | null; signedAt: string | null;
  values: IcuChartValueView[];
};
export type IcuChartView = { admissionId: string; mode: "live" | "manual"; hours: IcuChartHourView[] };

export type IcuTrendView = { admissionId: string; from: string; to: string; series: Partial<Record<IcuParam, { at: string; value: number }[]>> };

export type IcuBundleView = { id: string; kind: IcuBundleKind; dueAt: string; doneAt: string | null; doneBy: string | null; missed: boolean };
export type IcuDeviceDays = {
  ventilatorDays: number; monitorDays: number; pumpDays: number; centralLineDays: number; arterialLineDays: number;
  catheterDays: number; endotrachealTubeDays: number;
};

export type IcuBedView = {
  tile: IcuTile; admissionNo: string | null; consultantId: string;
  links: { id: string; type: IcuDeviceType; deviceCode: string; deviceName: string; linkedAt: string; linkedBy: string }[];
  lines: { id: string; kind: IcuLineKind; site: string; insertedAt: string; removedAt: string | null }[];
  bundles: IcuBundleView[]; days: IcuDeviceDays;
  visits: { id: string; startsAt: string; endsAt: string; visitorName: string; relation: string }[];
  familyUpdates: { id: string; summary: string; givenTo: string; relation: string; mode: string; at: string; by: string }[];
};

export type IcuInchargeView = {
  asOf: string;
  missedBundles: { bundleId: string; admissionId: string; bedName: string; patientName: string; kind: IcuBundleKind; dueAt: string }[];
  storms: { admissionId: string; bedName: string; count: number }[];
  monitorTasks: { limitId: string; admissionId: string; bedName: string; param: IcuParam; low: number | null; high: number | null; orderedAt: string }[];
  greyHalls: { hallId: string; hallName: string; since: string | null }[];
};

export type IcuMyBedsView = { asOf: string; tiles: IcuTile[]; grey: boolean };
export type IcuNightView = { asOf: string; halls: { hallId: string; hallName: string; grey: boolean; tiles: IcuTile[] }[]; requests: IcuRequestView[] };
export type IcuHallSummary = { hallId: string; hallName: string; beds: number; occupied: number; grey: boolean; openAlarms: number };

/** D9: what the family link shows for today — words only, never a live number. */
export type IcuFamilyToday = { summary: string; at: string; mode: string };

/* ═══ refusals ═══ */

export const ICU_REFUSALS = {
  bad_input: { sentence: "The request is not complete.", fix: "Check the fields and send again." },
  icu_forbidden: { sentence: "You do not have the right for this ICU act.", fix: "Ask the ICU in-charge." },
  unknown_patient: { sentence: "This patient is not in the register.", fix: "Search the patient again." },
  unknown_request: { sentence: "No ICU request has this id.", fix: "Open the request from the list." },
  request_closed: { sentence: "This ICU request is already decided.", fix: "Raise a new request if the patient needs one." },
  request_open: { sentence: "This patient already has an open ICU request.", fix: "Open that request instead." },
  intensivist_only: { sentence: "Only an intensivist can decide an ICU request.", fix: "Call the intensivist on duty." },
  own_request: { sentence: "You cannot decide your own request.", fix: "Another intensivist decides it." },
  unknown_device: { sentence: "No ICU device has this label.", fix: "Scan the asset label on the device." },
  not_icu_device: { sentence: "This device is not an ICU monitor, ventilator or pump.", fix: "Ask biomedical to register it for the ICU." },
  unknown_band: { sentence: "This wristband is not recognised.", fix: "Scan the patient's band again." },
  band_not_live: { sentence: "This wristband has been replaced.", fix: "Scan the patient's current band." },
  band_mismatch: { sentence: "The band's QR does not match its patient.", fix: "Reprint the band at the desk." },
  not_on_icu_bed: { sentence: "This patient is not on an ICU bed.", fix: "Move the patient to an ICU bed first." },
  device_busy: { sentence: "This device is linked to another patient.", fix: "Unlink it there first." },
  bed_has_type: { sentence: "This bed already has a device of this kind.", fix: "Unlink the old device first." },
  device_not_linked: { sentence: "This device is not linked to anyone.", fix: "Scan the device that is linked." },
  unknown_hall: { sentence: "This is not an ICU hall.", fix: "Pick the hall from the list." },
  unknown_gateway: { sentence: "No gateway has this id.", fix: "Register the hall's gateway." },
  gateway_agent_only: { sentence: "Only the hall's gateway can send numbers.", fix: "Send with the gateway's agent key." },
  gateway_agent_mismatch: { sentence: "This agent is not the hall's gateway.", fix: "Use the agent key bound to this gateway." },
  unknown_bed: { sentence: "This bed is not in the hall.", fix: "Pick a bed of this hall." },
  unknown_admission: { sentence: "No ICU admission has this id.", fix: "Open the patient from the station." },
  hour_not_mark: { sentence: "A chart hour starts on the hour.", fix: "Pick the hour from the chart." },
  hour_in_future: { sentence: "This hour has not come yet.", fix: "Chart the hour once it is due." },
  hour_signed: { sentence: "This hour is already signed.", fix: "Correct a value with a reason instead." },
  hour_empty: { sentence: "There is nothing to sign in this hour.", fix: "Enter the values by hand." },
  unknown_hour: { sentence: "No chart hour has this id.", fix: "Open the hour from the chart." },
  feed_live: { sentence: "The feed is live; this hour is pre-filled from the devices.", fix: "Check and sign the pre-filled hour." },
  reason_required: { sentence: "A correction needs a reason.", fix: "Say why the value is wrong." },
  unknown_alarm: { sentence: "No alarm has this id.", fix: "Open the alarm from the station." },
  alarm_closed: { sentence: "This alarm is already acknowledged.", fix: "Nothing more to do." },
  unknown_line: { sentence: "No line has this id.", fix: "Open the line from the bed." },
  line_removed: { sentence: "This line is already out.", fix: "Nothing more to do." },
  unknown_bundle: { sentence: "No bundle has this id.", fix: "Open the bundle from the bed." },
  bundle_done: { sentence: "This bundle is already done.", fix: "Nothing more to do." },
  sepsis_open: { sentence: "A sepsis hour-1 bundle is already running.", fix: "Finish that bundle first." },
} as const;
export type IcuRefusalCode = keyof typeof ICU_REFUSALS;

/* ═══ routes (the core controller is `@Controller("icu")`) ═══ */
export const ICU_ROUTES = {
  requests: "/icu/requests",
  decide: "/icu/requests/:requestId/decision",
  link: "/icu/devices/link",
  unlink: "/icu/devices/unlink",
  halls: "/icu/halls",
  station: "/icu/station/:hallId",
  bed: "/icu/beds/:admissionId",
  chart: "/icu/chart/:admissionId",
  prefill: "/icu/chart/prefill",
  sign: "/icu/chart/sign",
  correct: "/icu/chart/correct",
  manual: "/icu/chart/manual",
  trends: "/icu/trends/:admissionId",
  limits: "/icu/limits",
  limitOnMonitor: "/icu/limits/:limitId/on-monitor",
  ack: "/icu/alarms/ack",
  lines: "/icu/lines",
  lineRemove: "/icu/lines/remove",
  sepsis: "/icu/bundles/sepsis",
  bundleDone: "/icu/bundles/done",
  visits: "/icu/visits",
  familyUpdates: "/icu/family-updates",
  myBeds: "/icu/my-beds",
  night: "/icu/night",
  incharge: "/icu/incharge",
  gateways: "/icu/gateways",
  slots: "/icu/gateways/slots",
  codes: "/icu/gateways/codes",
  feed: "/icu/feed/:gatewayId/batches",
} as const;
