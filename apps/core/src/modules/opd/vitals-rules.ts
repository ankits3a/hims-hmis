import { z } from "zod";
import { OpdError } from "./errors";
import type { BandConfig, DangerRangesConfig, VitalKey } from "./config";
import type { DangerFlag } from "./events";

/**
 * The pure rules the vitals desk is judged by. Every function here is total, synchronous and
 * database-free — which is what lets the screen mirror them for immediate feedback while the
 * SERVER stays the authority (the shipped `opd-vitals.tsx` header states that contract and VD-2
 * inherits it unchanged).
 */

export type VitalsInput = {
  heightCm?: number | null; weightKg?: number | null; sbp?: number | null; dbp?: number | null;
  pulse?: number | null; rr?: number | null; spo2?: number | null; tempC?: number | null;
  /** VD-1 T1 / D5 — required under six, meaningless over it, banded SAM / MAM / green. */
  muacCm?: number | null;
  notes?: string | null;
};

/**
 * ═══ VD-1 T1 / D1 — THE READING ═══
 *
 * What the bay actually produces per vital. `takes` holds every take in order — a rest-and-recheck
 * pair is two entries here and ONE `opd_vitals` row, which is how *"never averaged, never
 * overwritten"* becomes a property of storage rather than of anybody's discipline. `held` holds
 * values a sanity gate refused to chart (T2's 45 % SpO₂), so the number is not lost and is also
 * not a chart fact. A BP take is `[systolic, diastolic]`; everything else is a scalar.
 */
export const READING_SOURCES = ["typed", "device", "counted"] as const;
export type ReadingSource = (typeof READING_SOURCES)[number];

/** Every vital measured on its own, keyed as it is stored. BP is not here — it is `bp` below. */
export type ScalarReadingKey = Exclude<VitalKey, "sbp" | "dbp">;
export const SCALAR_READING_KEYS: readonly ScalarReadingKey[] =
  ["heightCm", "weightKg", "pulse", "rr", "spo2", "tempC", "muacCm"];

export type Reading = { takes: number[]; source: ReadingSource; held?: number[]; note?: string };
/** ONE measurement with TWO numbers. A take is `[systolic, diastolic]`; a pair of takes is a rest-and-recheck. */
export type BpReading = { takes: [number, number][]; source: ReadingSource; held?: number[]; note?: string };
export type Readings = Partial<Record<ScalarReadingKey, Reading>> & { bp?: BpReading };

const readingBase = { source: z.enum(READING_SOURCES), held: z.array(z.number()).optional(), note: z.string().max(300).optional() };
export const readingsSchema: z.ZodType<Readings> = z.object({
  ...Object.fromEntries(SCALAR_READING_KEYS.map((k) => [k, z.object({ takes: z.array(z.number()).min(1), ...readingBase }).optional()])),
  bp: z.object({ takes: z.array(z.tuple([z.number(), z.number()])).min(1), ...readingBase }).optional(),
}) as z.ZodType<Readings>;

/** A question asked at the bench and its answer, riding the encounter to the doctor. */
export type ContextChip = { key: string; question: string; answer: string };
export const contextChipSchema = z.object({
  key: z.string().min(1).max(40), question: z.string().min(1).max(200), answer: z.string().min(1).max(200),
});

/**
 * ═══ THE SCALARS ARE DERIVED FROM THE READINGS, NEVER SUPPLIED BESIDE THEM ═══
 *
 * `opd_vitals` keeps both shapes — the scalar columns four shipped readers select, and the
 * `readings` blob the bay writes. Two shapes that a caller could set INDEPENDENTLY is two sources
 * of truth for the same number, and the one the doctor reads would be whichever the caller
 * happened to get right. So there is exactly one input path: a caller sends readings, the server
 * derives the scalars, and **the operative take is the LAST one** — after a rest-and-recheck that
 * is the second reading, which is the number the doctor should act on, with the first preserved in
 * `takes` rather than lost.
 */
export function readingsToInput(readings: Readings): VitalsInput {
  const out: VitalsInput = {};
  for (const k of SCALAR_READING_KEYS) {
    const r = readings[k];
    if (r === undefined || r.takes.length === 0) continue;
    out[k] = r.takes[r.takes.length - 1]!;
  }
  const bp = readings.bp;
  if (bp !== undefined && bp.takes.length > 0) {
    const last = bp.takes[bp.takes.length - 1]!;
    out.sbp = last[0];
    out.dbp = last[1];
  }
  return out;
}

/**
 * The reverse, for the flat body the shipped screen still posts: one typed take per supplied
 * vital, so **every** row carries a `readings` value and no reader ever has to ask which shape it
 * is looking at. `sbp`/`dbp` fold back into the single `bp` measurement they always were.
 */
export function inputToReadings(v: VitalsInput, source: ReadingSource = "typed"): Readings {
  const out: Readings = {};
  for (const k of SCALAR_READING_KEYS) {
    const x = v[k];
    if (x === undefined || x === null) continue;
    out[k] = { takes: [x], source };
  }
  if (v.sbp !== undefined && v.sbp !== null && v.dbp !== undefined && v.dbp !== null) {
    out.bp = { takes: [[v.sbp, v.dbp]], source };
  }
  return out;
}

/**
 * The vitals compared against a band's numeric RANGES. Typed off `BandConfig["ranges"]` rather
 * than off `DangerFlag["vital"]`, which is wider since T1: MUAC is a flagged vital and is NOT a
 * ranged one — it has zones, below, and a key that cannot index `ranges` should not compile as
 * though it can.
 */
const RANGED: readonly (keyof BandConfig["ranges"])[] = ["sbp", "dbp", "pulse", "rr", "spo2", "tempC"];

/**
 * The order every screen renders and `missingRequired` reports in. `muacCm` is appended for the
 * reason `VITAL_KEYS` appends it — the two lists must agree, and a test asserts they do.
 */
const ORDER: readonly VitalKey[] = ["heightCm", "weightKg", "sbp", "dbp", "tempC", "spo2", "pulse", "rr", "muacCm"];

const PLAUSIBLE: Record<VitalKey, [number, number]> = {
  heightCm: [20, 250], weightKg: [0.3, 400], sbp: [30, 300], dbp: [10, 200], pulse: [10, 300], rr: [2, 100], spo2: [0, 100], tempC: [25, 45],
  // Wide on purpose: this is the "is it a number at all" envelope, not the clinical band. A MUAC
  // of 4.5 is refused here; a MUAC of 11.0 is accepted here and flagged SAM by evaluateVitals.
  muacCm: [4, 60],
};

/** The band whose EXCLUSIVE upper bound the age is below; unknown age → the adult tail. */
export function bandFor(ageYears: number | null, cfg: DangerRangesConfig): BandConfig {
  const tail = cfg.bands[cfg.bands.length - 1]!;
  if (ageYears === null) return tail;
  return cfg.bands.find((b) => b.upToAgeYears !== null && ageYears < b.upToAgeYears) ?? tail;
}

function present(v: VitalsInput, k: VitalKey): boolean {
  const x = v[k];
  return x !== undefined && x !== null;
}

/**
 * ═══ VD-1 T1 / D11 — THE EMERGENCY SET, AND IT IS DECLARED RATHER THAN INFERRED ═══
 *
 * The owner's DECIDED line: *"an emergency save requires only BP + pulse + SpO₂ — a crashing
 * patient is not a form."* It is a DECLARATION on the request, never something read out of the
 * numbers: a system that inferred an emergency would sometimes infer one for a frightened person
 * with a fast pulse and accept a half-filled chart for them.
 */
export const EMERGENCY_REQUIRED: readonly VitalKey[] = ["sbp", "dbp", "pulse", "spo2"];

/**
 * Completeness: the band's required list, plus weight under `cfg.weightRequiredUnderYears` (§11.8),
 * minus anything the caller CARRIED FORWARD from the last reading (D7 — a carried height is
 * present on the chart, it was simply not measured today).
 */
export function missingRequired(
  v: VitalsInput,
  ageYears: number | null,
  cfg: DangerRangesConfig,
  opts: { emergency?: boolean; carriedForward?: readonly VitalKey[] } = {},
): VitalKey[] {
  const need = new Set<VitalKey>();
  if (opts.emergency === true) {
    for (const k of EMERGENCY_REQUIRED) need.add(k);
  } else {
    const band = bandFor(ageYears, cfg);
    for (const k of band.required) need.add(k);
    if (ageYears !== null && ageYears < cfg.weightRequiredUnderYears) need.add("weightKg");
  }
  for (const k of opts.carriedForward ?? []) need.delete(k);
  return ORDER.filter((k) => need.has(k) && !present(v, k));
}

/**
 * Every PRESENT ranged vital compared against the band's inclusive bounds, plus MUAC's zones.
 *
 * ═══ `notRoutine` IS SKIPPED, AND THAT IS D5 ═══
 *
 * A vital the band declares not-routine is recorded and NOT flagged. Under five, BP is taken only
 * because a doctor asked for it, and comparing it to limits nobody chose it to be read under
 * produces a flag whose only effect is to teach the reader that flags are noise.
 */
export function evaluateVitals(v: VitalsInput, band: BandConfig, cfg?: DangerRangesConfig): DangerFlag[] {
  const flags: DangerFlag[] = [];
  const notRoutine = new Set<VitalKey>(band.notRoutine);
  for (const k of RANGED) {
    if (notRoutine.has(k)) continue;
    const value = v[k];
    if (value === undefined || value === null) continue;
    const r = band.ranges[k];
    if (!r) continue;
    if (r.min !== undefined && value < r.min) flags.push({ vital: k, value, bound: "min", limit: r.min });
    if (r.max !== undefined && value > r.max) flags.push({ vital: k, value, bound: "max", limit: r.max });
  }
  // MUAC is banded rather than ranged: two thresholds, and the flag names the one actually
  // breached so a reader who knows nothing about malnutrition still renders it correctly.
  const muac = v.muacCm;
  if (cfg !== undefined && muac !== undefined && muac !== null && !notRoutine.has("muacCm")) {
    const limit = muac < cfg.muacBands.samUnderCm ? cfg.muacBands.samUnderCm
      : muac < cfg.muacBands.mamUnderCm ? cfg.muacBands.mamUnderCm
        : null;
    if (limit !== null) flags.push({ vital: "muacCm", value: muac, bound: "min", limit });
  }
  return flags;
}

/** MUAC's zone, for the screen's wording and the nutrition-counter flag. */
export function muacZone(muacCm: number, cfg: DangerRangesConfig): "sam" | "mam" | "green" {
  if (muacCm < cfg.muacBands.samUnderCm) return "sam";
  if (muacCm < cfg.muacBands.mamUnderCm) return "mam";
  return "green";
}

export function validateVitalsRanges(v: VitalsInput): void {
  for (const k of Object.keys(PLAUSIBLE) as VitalKey[]) {
    const x = v[k];
    if (x === undefined || x === null) continue;
    const [lo, hi] = PLAUSIBLE[k];
    if (typeof x !== "number" || !Number.isFinite(x) || x < lo || x > hi) throw new OpdError("invalid_vitals", `${k} out of plausible range ${lo}–${hi}`, { vital: k, value: x });
  }
}
