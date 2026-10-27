import { z } from "zod";
import { IpdIdSchema, IpdInstantSchema, IpdNoteSchema, ipdInput } from "./common";

/**
 * WM-1 (#982, decision 0089) — THE WARD'S NURSES: per-shift assignment of every occupied bed to one registered nurse,
 * acuity points, the nurse-to-patient ratio, float moves and the in-charge cockpit. Module acts with their own
 * contracts (like intake/output and the shift handover), not §0B intents. Clinical; no money.
 *
 * Shifts are the nursing shifts 08–14 (morning), 14–20 (evening) and 20–08 (night) IST; a shift's date is the IST date
 * it starts on. A map is published at least 30 minutes before its shift (07:30, 13:30, 19:30); later is allowed and
 * marked late.
 */

export const IPD_NURSE_SHIFTS = ["morning", "evening", "night"] as const;
export type IpdNurseShift = (typeof IPD_NURSE_SHIFTS)[number];
export const IpdShiftDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "a date YYYY-MM-DD");

// ═══════════════════════════════════════════ acuity and ratio (pure) ═══════════════════════════════════════════

/** Acuity per patient per shift: self-care 1, partial care 1.5, full care 2 points (spec #982). */
export const IPD_ACUITY_POINTS = { self_care: 1, partial_care: 1.5, full_care: 2 } as const;
export type IpdAcuityLevel = keyof typeof IPD_ACUITY_POINTS;
export const IPD_ACUITY_LEVELS = Object.keys(IPD_ACUITY_POINTS) as [IpdAcuityLevel, ...IpdAcuityLevel[]];
/** A patient with no acuity recorded this shift counts as self-care. */
export const IPD_ACUITY_DEFAULT_POINTS = 1;

/** The ratio units of the configurable table (decision 0089). A ventilated bed is always 1:1, whatever the unit. */
export const IPD_RATIO_UNITS = ["general", "private", "hdu_icu", "labour_nicu"] as const;
export type IpdRatioUnit = (typeof IPD_RATIO_UNITS)[number];
/** Patients per registered nurse, day (morning and evening shifts) and night. */
export const IPD_RATIO_DEFAULTS: Record<IpdRatioUnit, { day: number; night: number }> = {
  general: { day: 6, night: 8 },
  private: { day: 4, night: 6 },
  hdu_icu: { day: 2, night: 2 },
  labour_nicu: { day: 2, night: 2 },
};
/** A nurse whose points exceed this many times the ward's patients-per-nurse is flagged overloaded. */
export const IPD_OVERLOAD_FACTOR = 1.5;

const ICU_UNITS = new Set(["MICU", "SICU", "CCU", "CTVS_ICU", "NEURO_ICU", "ONCO_ICU", "PICU", "BURNS", "HDU"]);
const LABOUR_NICU_UNITS = new Set(["NICU", "SNCU", "LDR"]);

/**
 * The ward's ratio unit: its own `ratioUnit` attribute when set; else from its `unitType` (ICU and HDU kinds → hdu_icu;
 * NICU, SNCU and labour → labour_nicu); else private when most of its beds are private, otherwise general.
 */
export function ratioUnitOf(ward: { ratioUnit?: unknown; unitType?: unknown }, bedClasses: readonly string[]): IpdRatioUnit {
  if (typeof ward.ratioUnit === "string" && (IPD_RATIO_UNITS as readonly string[]).includes(ward.ratioUnit)) return ward.ratioUnit as IpdRatioUnit;
  const unit = typeof ward.unitType === "string" ? ward.unitType : "";
  if (ICU_UNITS.has(unit)) return "hdu_icu";
  if (LABOUR_NICU_UNITS.has(unit)) return "labour_nicu";
  const priv = bedClasses.filter((c) => c === "private" || c === "suite" || c === "deluxe").length;
  return priv * 2 > bedClasses.length ? "private" : "general";
}

/** Patients per nurse for the ward now: its `nurseRatio` override when set, else the table's default. */
export function patientsPerRnOf(unit: IpdRatioUnit, night: boolean, override?: unknown): number {
  const o = override as { day?: unknown; night?: unknown } | undefined;
  const v = night ? o?.night : o?.day;
  if (typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 20) return v;
  return IPD_RATIO_DEFAULTS[unit][night ? "night" : "day"];
}

/** Registered nurses the ward needs: one for each ventilated patient, then the rest at the ward's ratio. */
export function rnsNeededFor(f: { patients: number; ventilated: number; patientsPerRn: number }): number {
  const rest = Math.max(0, f.patients - f.ventilated);
  return f.ventilated + Math.ceil(rest / f.patientsPerRn);
}

/** Load of one nurse: the sum of her beds' acuity points. */
export function loadOf(points: readonly number[]): number {
  return points.reduce((s, p) => s + p, 0);
}

// ═══════════════════════════════════════════ acts ═══════════════════════════════════════════

export const IpdSetAcuityInputSchema = ipdInput({
  admissionId: IpdIdSchema,
  level: z.enum(IPD_ACUITY_LEVELS),
  ventilated: z.boolean().optional(),
});
export type IpdSetAcuityInput = z.infer<typeof IpdSetAcuityInputSchema>;

export const IPD_SHIFT_STAFF_KINDS = ["rn", "student", "incharge", "float"] as const;
export type IpdShiftStaffKind = (typeof IPD_SHIFT_STAFF_KINDS)[number];

export const IpdSaveShiftMapInputSchema = ipdInput({
  wardId: IpdIdSchema,
  shiftDate: IpdShiftDateSchema,
  shift: z.enum(IPD_NURSE_SHIFTS),
  staff: z.array(z.strictObject({
    userId: IpdIdSchema,
    kind: z.enum(IPD_SHIFT_STAFF_KINDS),
    /** A student's registered nurse. */
    pairedWithId: IpdIdSchema.optional(),
  })).max(80),
  beds: z.array(z.strictObject({ bedId: IpdIdSchema, nurseId: IpdIdSchema, studentId: IpdIdSchema.optional() })).max(200),
});
export type IpdSaveShiftMapInput = z.infer<typeof IpdSaveShiftMapInputSchema>;

export const IpdCopyShiftMapInputSchema = ipdInput({ wardId: IpdIdSchema, shiftDate: IpdShiftDateSchema, shift: z.enum(IPD_NURSE_SHIFTS) });
export const IpdPublishShiftMapInputSchema = ipdInput({ mapId: IpdIdSchema });

/** Give a bed to a nurse on the live map. A bed that already has a nurse needs a reason (a reassignment). */
export const IpdAssignNurseInputSchema = ipdInput({
  bedId: IpdIdSchema,
  nurseId: IpdIdSchema,
  studentId: IpdIdSchema.optional(),
  reason: IpdNoteSchema.optional(),
});
export type IpdAssignNurseInput = z.infer<typeof IpdAssignNurseInputSchema>;

export const IpdEndMyDutyInputSchema = ipdInput({ wardId: IpdIdSchema, reason: IpdNoteSchema.optional() });

export const IpdMoveFloatNurseInputSchema = ipdInput({
  userId: IpdIdSchema,
  toWardId: IpdIdSchema,
  shiftDate: IpdShiftDateSchema,
  shift: z.enum(IPD_NURSE_SHIFTS),
  reason: IpdNoteSchema,
});
export type IpdMoveFloatNurseInput = z.infer<typeof IpdMoveFloatNurseInputSchema>;

// ═══════════════════════════════════════════ reads ═══════════════════════════════════════════

/** A nurse as a tile shows her: initials always; the name for staff screens. */
export const IpdNurseRefSchema = z.object({ userId: IpdIdSchema, initials: z.string(), name: z.string() });
export type IpdNurseRef = z.infer<typeof IpdNurseRefSchema>;

export const IPD_SHIFT_MAP_STATUSES = ["draft", "published", "carried_over"] as const;

const WardRef = z.object({ id: IpdIdSchema, code: z.string(), name: z.string() });

export const IpdCockpitBedSchema = z.object({
  bedId: IpdIdSchema,
  /** Null for a sealed patient's bed. */
  code: z.string().nullable(),
  admissionId: IpdIdSchema.nullable(),
  /** "Sealed patient" or the alias for a restricted reader; null for an empty bed. */
  name: z.string().nullable(),
  nurse: IpdNurseRefSchema.nullable(),
  student: IpdNurseRefSchema.nullable(),
  /** Occupied and no nurse on the live map: red until assigned. */
  unassigned: z.boolean(),
  /** The lowest-load registered nurse on duty, for an unassigned bed. */
  suggestedNurseId: IpdIdSchema.nullable(),
  acuity: z.object({ level: z.enum(IPD_ACUITY_LEVELS).nullable(), points: z.number(), ventilated: z.boolean() }).nullable(),
  score: z.object({ value: z.number().int(), band: z.string() }).nullable(),
  chips: z.array(z.string()),
  next: z.object({ kind: z.enum(["vitals", "assessment"]), dueAt: IpdInstantSchema, overdue: z.boolean() }).nullable(),
});
export type IpdCockpitBed = z.infer<typeof IpdCockpitBedSchema>;

export const IpdCockpitStaffSchema = IpdNurseRefSchema.extend({
  kind: z.enum(IPD_SHIFT_STAFF_KINDS),
  pairedWithId: IpdIdSchema.nullable(),
  /** A floated nurse's own ward. */
  homeWardId: IpdIdSchema.nullable(),
  endedAt: IpdInstantSchema.nullable(),
});

export const IpdWardRatioSchema = z.object({
  unit: z.enum(IPD_RATIO_UNITS),
  night: z.boolean(),
  patientsPerRn: z.number().int().positive(),
  patients: z.number().int().nonnegative(),
  ventilated: z.number().int().nonnegative(),
  rnsOnDuty: z.number().int().nonnegative(),
  rnsNeeded: z.number().int().nonnegative(),
  breach: z.boolean(),
});
export type IpdWardRatio = z.infer<typeof IpdWardRatioSchema>;

export const IpdNurseLoadSchema = IpdNurseRefSchema.extend({
  beds: z.number().int().nonnegative(),
  points: z.number(),
  overloaded: z.boolean(),
});

export const IpdWardCockpitSchema = z.object({
  asOf: IpdInstantSchema,
  wards: z.array(WardRef),
  ward: WardRef.nullable(),
  shift: z.object({ key: z.enum(IPD_NURSE_SHIFTS), date: IpdShiftDateSchema, startsAt: IpdInstantSchema, endsAt: IpdInstantSchema }),
  map: z.object({
    mapId: IpdIdSchema,
    status: z.enum(IPD_SHIFT_MAP_STATUSES),
    publishedAt: IpdInstantSchema.nullable(),
    late: z.boolean(),
  }).nullable(),
  /** The next shift's map, if one is drafted or published. */
  nextMap: z.object({ mapId: IpdIdSchema, status: z.enum(IPD_SHIFT_MAP_STATUSES) }).nullable(),
  census: z.object({ beds: z.number().int().nonnegative(), occupied: z.number().int().nonnegative() }),
  ratio: IpdWardRatioSchema,
  staff: z.array(IpdCockpitStaffSchema),
  loads: z.array(IpdNurseLoadSchema),
  beds: z.array(IpdCockpitBedSchema),
  /** What needs the in-charge now, most urgent first. */
  needsYou: z.array(z.object({
    kind: z.enum(["unassigned_bed", "ews", "overdue", "ratio_breach", "overloaded", "not_published"]),
    bedId: IpdIdSchema.nullable(),
    userId: IpdIdSchema.nullable(),
    text: z.string(),
  })),
  /** No roster answer for the ward: candidates are every active ward nurse. */
  rosterFallback: z.boolean(),
  /** The nurses the in-charge may put on the map (roster first). */
  candidates: z.array(IpdNurseRefSchema.extend({ kind: z.enum(["rn", "student", "incharge"]) })),
});
export type IpdWardCockpit = z.infer<typeof IpdWardCockpitSchema>;

export const IpdFloatPoolSchema = z.object({
  asOf: IpdInstantSchema,
  shift: z.object({ key: z.enum(IPD_NURSE_SHIFTS), date: IpdShiftDateSchema }),
  /** Registered nurses on a live map, least loaded first. */
  nurses: z.array(IpdNurseRefSchema.extend({
    wardId: IpdIdSchema, wardName: z.string(), floorId: IpdIdSchema.nullable(), beds: z.number().int().nonnegative(), points: z.number(),
  })),
});
export type IpdFloatPool = z.infer<typeof IpdFloatPoolSchema>;

/** The draft or live map of one ward and shift, for the assignment screen. */
export const IpdShiftMapViewSchema = z.object({
  mapId: IpdIdSchema.nullable(),
  wardId: IpdIdSchema,
  shiftDate: IpdShiftDateSchema,
  shift: z.enum(IPD_NURSE_SHIFTS),
  status: z.enum(IPD_SHIFT_MAP_STATUSES).nullable(),
  staff: z.array(z.object({ userId: IpdIdSchema, kind: z.enum(IPD_SHIFT_STAFF_KINDS), pairedWithId: IpdIdSchema.nullable() })),
  beds: z.array(z.object({ bedId: IpdIdSchema, nurseId: IpdIdSchema, studentId: IpdIdSchema.nullable() })),
});
export type IpdShiftMapView = z.infer<typeof IpdShiftMapViewSchema>;

export const IPD_WARD_ROUTES = {
  cockpit: "/ipd/nursing/ward/cockpit",
  map: "/ipd/nursing/ward/map",
  saveMap: "/ipd/nursing/ward/map/save",
  copyMap: "/ipd/nursing/ward/map/copy",
  publishMap: "/ipd/nursing/ward/map/publish",
  assignNurse: "/ipd/nursing/ward/assign-nurse",
  endDuty: "/ipd/nursing/ward/end-duty",
  floatPool: "/ipd/nursing/ward/float-pool",
  moveFloat: "/ipd/nursing/ward/float",
  acuity: "/ipd/nursing/acuity",
} as const;
