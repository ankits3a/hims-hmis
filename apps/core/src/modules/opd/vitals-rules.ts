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
  const danger = new Set<VitalKey>();
  for (const k of RANGED) {
    if (notRoutine.has(k)) continue;
    const value = v[k];
    if (value === undefined || value === null) continue;
    const r = band.ranges[k];
    if (!r) continue;
    if (r.min !== undefined && value < r.min) { flags.push({ vital: k, value, bound: "min", limit: r.min, severity: "danger" }); danger.add(k); }
    if (r.max !== undefined && value > r.max) { flags.push({ vital: k, value, bound: "max", limit: r.max, severity: "danger" }); danger.add(k); }
  }
  /**
   * ═══ VD-1 CLOSE / F1 — THE NOTICE PASS: SEEN BY THE DOCTOR, IGNORED BY THE QUEUE ═══
   *
   * A vital that already produced a DANGER flag is skipped: a 40.2 °C toddler is one fact, not two,
   * and reporting it twice would double-count on every screen that renders `dangerFlags`.
   */
  for (const k of RANGED) {
    if (notRoutine.has(k) || danger.has(k)) continue;
    const value = v[k];
    if (value === undefined || value === null) continue;
    const n = band.noticeRanges[k];
    if (!n) continue;
    if (n.min !== undefined && value < n.min) flags.push({ vital: k, value, bound: "min", limit: n.min, severity: "notice" });
    if (n.max !== undefined && value > n.max) flags.push({ vital: k, value, bound: "max", limit: n.max, severity: "notice" });
  }
  // MUAC is banded rather than ranged: two thresholds, and the flag names the one actually
  // breached so a reader who knows nothing about malnutrition still renders it correctly.
  const muac = v.muacCm;
  if (cfg !== undefined && muac !== undefined && muac !== null && !notRoutine.has("muacCm")) {
    const limit = muac < cfg.muacBands.samUnderCm ? cfg.muacBands.samUnderCm
      : muac < cfg.muacBands.mamUnderCm ? cfg.muacBands.mamUnderCm
        : null;
    if (limit !== null) flags.push({ vital: "muacCm", value: muac, bound: "min", limit, severity: "danger" });
  }
  return flags;
}

/** MUAC's zone, for the screen's wording and the nutrition-counter flag. */
export function muacZone(muacCm: number, cfg: DangerRangesConfig): "sam" | "mam" | "green" {
  if (muacCm < cfg.muacBands.samUnderCm) return "sam";
  if (muacCm < cfg.muacBands.mamUnderCm) return "mam";
  return "green";
}

/**
 * ═══════════════ VD-1 T2 — THE FOUR SANITY GATES ═══════════════
 *
 * `validateVitalsRanges` below is the "is this a number at all" envelope, and it is very wide on
 * purpose — it admits a weight of 0.3 kg and an SpO₂ of 0, because a newborn and a dying person
 * are both real. What it cannot do is notice that **4.8 kg on a seventy-two-year-old is a slipped
 * digit** and that **45 % on a talking patient is a probe that slid off a cold finger.** Both of
 * those became chart facts, silently, on the ordinary path, until this section existed.
 *
 * ═══ A GATE IS A REFUSAL A NAMED HUMAN CAN PASS THROUGH ═══
 *
 * Never a lockout. Each gate names the key it fired on, what it thinks happened, and — where
 * arithmetic can offer one — the number it believes was meant. A caller who disagrees sends
 * `overrides[key]` and the value is recorded WITH the disagreement, flagged hard to the doctor.
 * The grammar is 16a T5's, inherited rather than re-derived: a hard warning cleared by an override
 * with a reason, so the record says a person decided rather than that a rule was absent.
 *
 * ═══ AND THE RR NUDGE IS DELIBERATELY NOT HERE ═══
 *
 * The owner's DECIDED line: *"a suspiciously instant RR gets a nudge and a 15-second counter,
 * never a block."* A respiratory rate typed two seconds after the field was focused is probably
 * guessed — but the honest instrument is the counter, not a refusal, and the server cannot see a
 * keystroke clock anyway. It is a screen behaviour with no server counterpart, and that absence is
 * written down here so a later reader finds a decision instead of a gap.
 */
export type GateKind = "slipped_digit" | "shrinking_adult" | "probe_error";
export type VitalsGate = {
  key: VitalKey;
  kind: GateKind;
  value: number;
  /** The number the gate believes was meant, when arithmetic can name one. */
  suggestion?: number;
  message: string;
};

/** The four reasons a carried value may be re-measured. A free-text box here would collect "changed". */
export const UNLOCK_REASONS = [
  "yearly_remeasure_due", "patient_disputes_old_value", "posture_or_device_changed", "surgical_or_limb_change",
] as const;
export type UnlockReason = (typeof UNLOCK_REASONS)[number];

export type GateOverrides = Partial<Record<VitalKey, string>>;
export type UnlockReasons = Partial<Record<VitalKey, UnlockReason>>;

/**
 * The gates that judge a VALUE, evaluated against the band and the last recorded reading. Pure, so
 * the screen runs exactly this to give immediate feedback and the server runs exactly this to
 * decide — one rule, one place (D9). A key carrying an override is skipped: it has been answered.
 */
export function sanityGates(
  v: VitalsInput,
  ageYears: number | null,
  cfg: DangerRangesConfig,
  last: { heightCm?: number | null } | null,
  overrides: GateOverrides = {},
): VitalsGate[] {
  const gates: VitalsGate[] = [];
  const g = cfg.gates;
  const isChild = ageYears !== null && ageYears < 13;

  // ── 1 · the slipped digit. 4.8 typed for 48. Only above the paediatric bands, where a small
  //      weight is simply a small person and the gate would fire on every infant in the hospital.
  const wt = v.weightKg;
  if (overrides.weightKg === undefined && wt !== undefined && wt !== null && !isChild && wt < g.adultWeightFloorKg) {
    const shifted = Math.round(wt * 100) / 10;
    gates.push({
      key: "weightKg", kind: "slipped_digit", value: wt,
      ...(shifted >= 30 && shifted <= 150 ? { suggestion: shifted } : {}),
      message: `${wt} kg on ${ageYears === null ? "an adult" : `a ${ageYears}-year-old`} — a slipped digit becomes a chart fact in one keystroke`,
    });
  }

  // ── 2 · the shrinking adult. A spine does bend at 72, which is why this is a gate and not a
  //      refusal: re-measure once, and if it stands, the doctor sees BOTH numbers.
  const ht = v.heightCm;
  const lastHt = last?.heightCm ?? null;
  if (overrides.heightCm === undefined && ht !== undefined && ht !== null && lastHt !== null && Math.abs(ht - lastHt) >= g.heightDeltaCm) {
    gates.push({
      key: "heightCm", kind: "shrinking_adult", value: ht, suggestion: lastHt,
      message: `height ${ht} against ${lastHt} — ${Math.round(Math.abs(ht - lastHt) * 10) / 10} cm apart; re-measure once before it becomes true`,
    });
  }
  return gates;
}

/**
 * ═══ THE PROBE GATE IS NOT A REFUSAL, AND THAT IS WHY IT IS ITS OWN FUNCTION ═══
 *
 * The owner's DECIDED line: *"a sub-75 SpO₂ lives in the log, not the chart, until it survives a
 * re-clip."* So this gate does not stop a save — it MOVES the number. Every take below the floor
 * leaves `takes` and lands in `held`, where it is preserved, auditable, and not a clinical fact.
 * A re-clip that reads 94 charts 94 with the 45 beside it in the log, which is exactly what
 * happened at the bay.
 *
 * If EVERY take was below the floor there is no SpO₂ to chart, and the ordinary completeness rule
 * then says so — `vitals_incomplete: spo2` — which is the honest outcome: you cannot chart a probe
 * error, and you cannot save a required vital you have not got. A caller who is certain the number
 * is real sends `overrides.spo2` and nothing is held.
 */
export function holdProbeErrors(readings: Readings, cfg: DangerRangesConfig, overrides: GateOverrides = {}): Readings {
  const r = readings.spo2;
  if (r === undefined || overrides.spo2 !== undefined) return readings;
  const floor = cfg.gates.spo2ProbeFloorPct;
  const keep = r.takes.filter((t) => t >= floor);
  const held = r.takes.filter((t) => t < floor);
  if (held.length === 0) return readings;
  const next: Reading = { ...r, takes: keep, held: [...(r.held ?? []), ...held] };
  const out: Readings = { ...readings, spo2: next };
  if (keep.length === 0) delete out.spo2; // nothing chartable — completeness will say so
  return out;
}

/**
 * ═══ D7 — THE LOCK ON A CARRIED VALUE, AND WHY IT LIVES ON THE SERVER ═══
 *
 * A height carried from March is greyed on the screen. A lock that lives only there is a lock a
 * `curl` walks through, and the value it protects is one a doctor doses paediatric drugs from.
 *
 * The rule: a key the caller declares CARRIED must arrive with the carried NUMBER. A different
 * number means it was re-measured, which is fine and is exactly what the four preset reasons are
 * for — but it is no longer a carry-forward, and saying so is the whole point. The old value is
 * kept beside the new one rather than replaced.
 */
export function checkCarriedLock(
  v: VitalsInput,
  carriedForward: readonly VitalKey[],
  last: Partial<Record<VitalKey, number | null>> | null,
  unlockReasons: UnlockReasons = {},
): { key: VitalKey; carried: number | null; supplied: number }[] {
  const bad: { key: VitalKey; carried: number | null; supplied: number }[] = [];
  for (const key of carriedForward) {
    if (unlockReasons[key] !== undefined) continue;
    const supplied = v[key];
    if (supplied === undefined || supplied === null) continue;
    const carried = last?.[key] ?? null;
    if (carried === null || carried !== supplied) bad.push({ key, carried, supplied });
  }
  return bad;
}

export function validateVitalsRanges(v: VitalsInput): void {
  for (const k of Object.keys(PLAUSIBLE) as VitalKey[]) {
    const x = v[k];
    if (x === undefined || x === null) continue;
    const [lo, hi] = PLAUSIBLE[k];
    if (typeof x !== "number" || !Number.isFinite(x) || x < lo || x > hi) throw new OpdError("invalid_vitals", `${k} out of plausible range ${lo}–${hi}`, { vital: k, value: x });
  }
}
