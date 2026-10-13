/**
 * E4.1 (#733) — THE EARLY-WARNING SCORES, as pure tables both sides share (spec SPEC-ipd-core §4.5; plan M4 E4.1).
 *
 * The server is the authority (it scores every saved set); the phone runs the same functions so the score shows the
 * moment the numbers are typed (§4.9 D "score computed at once"). No zod, no I/O: total, synchronous functions.
 *
 * ═══ WHICH SCORE (DECIDED, standard Indian corporate-hospital practice) ═══
 *   · under 16 years (age from date of birth) → PEWS — the RCP says NEWS2 is not for under-16s;
 *   · pregnant, or within 42 days after delivery (the nursing assessment's obstetric answer), or admitted under
 *     obstetrics (department `OBG`) or onto a labour-delivery bed (class `ldr`) → MEOWS;
 *   · everyone else, and anyone whose age is unknown → NEWS2.
 *
 * ═══ BANDS ═══ `low` · `low_medium` · `medium` · `high` (the contract's words). The duty doctor is told at
 * `low_medium` and above (`ewsNotifies`); `high` is the emergency band.
 *
 * A set with a parameter missing is scored on what was measured and marked `complete: false` — a partial set can only
 * UNDER-score, so a breach it shows is real; the chart says "incomplete set" beside it.
 */

export const IPD_EWS_KINDS = ["news2", "meows", "pews"] as const;
export type IpdEwsKind = (typeof IPD_EWS_KINDS)[number];
export const IPD_EWS_BANDS = ["low", "low_medium", "medium", "high"] as const;
export type IpdEwsBand = (typeof IPD_EWS_BANDS)[number];
export const IPD_CONSCIOUSNESS = ["alert", "confused", "voice", "pain", "unresponsive"] as const;
export type IpdConsciousness = (typeof IPD_CONSCIOUSNESS)[number];

/** The observation set a score reads. Units are the OPD vitals desk's: °C, beats/min, breaths/min, mmHg, %. */
export type IpdEwsValues = {
  temperatureC?: number | undefined;
  pulse?: number | undefined;
  respRate?: number | undefined;
  systolic?: number | undefined;
  diastolic?: number | undefined;
  spo2?: number | undefined;
  onOxygen?: boolean | undefined;
  consciousness?: IpdConsciousness | undefined;
  /** Capillary refill in seconds — PEWS's cardiovascular row only. */
  capRefillSec?: number | undefined;
};

export type IpdEwsScore = {
  kind: IpdEwsKind;
  value: number;
  band: IpdEwsBand;
  /** Every parameter the chart scores was measured. */
  complete: boolean;
  /** One parameter alone is in its worst row (NEWS2 "red score" 3; MEOWS a red; PEWS a 3 in one row). */
  singleRed: boolean;
  /** Per-parameter points, for the chart's row colours (with words — never colour alone). */
  parts: Record<string, number>;
};

const BAND_RANK: Record<IpdEwsBand, number> = { low: 0, low_medium: 1, medium: 2, high: 3 };
export const ewsBandRank = (b: IpdEwsBand): number => BAND_RANK[b];
/** The duty doctor is told at this band and above (NEWS2: 5+ or any single 3). */
export const ewsNotifies = (b: IpdEwsBand): boolean => BAND_RANK[b] >= BAND_RANK.low_medium;
export const ewsEmergency = (b: IpdEwsBand): boolean => b === "high";

/** A row of a published chart: the points a value earns when it lies in [min, max] (inclusive). */
type Row = readonly [min: number, max: number, points: number];
function pointsOf(rows: readonly Row[], v: number): number {
  for (const [min, max, p] of rows) if (v >= min && v <= max) return p;
  return 0;
}
const INF = Number.POSITIVE_INFINITY;

// ═══════════════════════════════════════════ NEWS2 ═══════════════════════════════════════════
/*
 * Royal College of Physicians. National Early Warning Score (NEWS) 2: Standardising the assessment of acute-illness
 * severity in the NHS. Updated report of a working party. London: RCP, 2017. Chart 1 (the NEWS2 scoring system).
 * SpO2 is scale 1 (scale 2, for hypercapnic respiratory failure, needs a doctor's order — owed to ipd-orders).
 * Temperatures are given to one decimal on the chart; a value between rows (35.05) belongs to the row it rounds into.
 */
export const NEWS2_RESP_RATE: readonly Row[] = [[-INF, 8, 3], [9, 11, 1], [12, 20, 0], [21, 24, 2], [25, INF, 3]];
export const NEWS2_SPO2_SCALE1: readonly Row[] = [[-INF, 91, 3], [92, 93, 2], [94, 95, 1], [96, INF, 0]];
export const NEWS2_SYSTOLIC: readonly Row[] = [[-INF, 90, 3], [91, 100, 2], [101, 110, 1], [111, 219, 0], [220, INF, 3]];
export const NEWS2_PULSE: readonly Row[] = [[-INF, 40, 3], [41, 50, 1], [51, 90, 0], [91, 110, 1], [111, 130, 2], [131, INF, 3]];
export const NEWS2_TEMPERATURE: readonly Row[] = [[-INF, 35.0, 3], [35.1, 36.0, 1], [36.1, 38.0, 0], [38.1, 39.0, 1], [39.1, INF, 2]];
/** Supplemental oxygen scores 2; air 0. */
export const NEWS2_OXYGEN_POINTS = 2;
/** Alert 0; new confusion, voice, pain or unresponsive (ACVPU) 3. */
export const NEWS2_CVPU_POINTS = 3;

const round1 = (v: number): number => Math.round(v * 10) / 10;

export function news2(v: IpdEwsValues): IpdEwsScore {
  const parts: Record<string, number> = {};
  if (v.respRate !== undefined) parts.respRate = pointsOf(NEWS2_RESP_RATE, Math.round(v.respRate));
  if (v.spo2 !== undefined) parts.spo2 = pointsOf(NEWS2_SPO2_SCALE1, Math.round(v.spo2));
  if (v.onOxygen !== undefined) parts.onOxygen = v.onOxygen ? NEWS2_OXYGEN_POINTS : 0;
  if (v.systolic !== undefined) parts.systolic = pointsOf(NEWS2_SYSTOLIC, Math.round(v.systolic));
  if (v.pulse !== undefined) parts.pulse = pointsOf(NEWS2_PULSE, Math.round(v.pulse));
  if (v.consciousness !== undefined) parts.consciousness = v.consciousness === "alert" ? 0 : NEWS2_CVPU_POINTS;
  if (v.temperatureC !== undefined) parts.temperatureC = pointsOf(NEWS2_TEMPERATURE, round1(v.temperatureC));
  const value = Object.values(parts).reduce((s, p) => s + p, 0);
  const singleRed = Object.values(parts).some((p) => p >= 3);
  // RCP 2017 Chart 2 (thresholds and triggers): 0–4 low; a 3 in any single parameter low–medium; 5–6 medium; 7+ high.
  const band: IpdEwsBand = value >= 7 ? "high" : value >= 5 ? "medium" : singleRed ? "low_medium" : "low";
  const complete = ["respRate", "spo2", "onOxygen", "systolic", "pulse", "consciousness", "temperatureC"].every((k) => k in parts);
  return { kind: "news2", value, band, complete, singleRed, parts };
}

// ═══════════════════════════════════════════ MEOWS ═══════════════════════════════════════════
/*
 * Modified Early Obstetric Warning System — the CEMACH 2007 chart as validated by Singh S, McGlennan A, England A,
 * Simons R. "A validation study of the CEMACH recommended modified early obstetric warning system (MEOWS)."
 * Anaesthesia 2012;67:12–18, Table 1 (the CEMACH chart's trigger rows; printed on p. 13 — VERIFY THE PAGE AND EVERY ROW
 * AGAINST THE PRINTED TABLE BEFORE GO-LIVE, owed in MAP.md). Each parameter is normal, a YELLOW alert or a RED alert; the trigger for an urgent
 * medical review is ONE red or TWO yellows.
 *
 * Encoded (DECIDED), exactly as `meows()` computes it: value = 3 × reds + 1 × yellows (a number for the chart only);
 * band = low when there is no trigger (no red, at most one yellow); medium when the trigger is met (one red, or two or
 * more yellows); high when two or more parameters are red (emergency). MEOWS never yields `low_medium`.
 */
export const MEOWS_RED = 3;
export const MEOWS_YELLOW = 1;
export const MEOWS_TEMPERATURE: readonly Row[] = [[-INF, 34.9, MEOWS_RED], [35.0, 36.0, MEOWS_YELLOW], [36.1, 38.0, 0], [38.1, INF, MEOWS_RED]];
export const MEOWS_SYSTOLIC: readonly Row[] = [[-INF, 89, MEOWS_RED], [90, 100, MEOWS_YELLOW], [101, 149, 0], [150, 160, MEOWS_YELLOW], [161, INF, MEOWS_RED]];
export const MEOWS_DIASTOLIC: readonly Row[] = [[-INF, 89, 0], [90, 100, MEOWS_YELLOW], [101, INF, MEOWS_RED]];
export const MEOWS_PULSE: readonly Row[] = [[-INF, 39, MEOWS_RED], [40, 50, MEOWS_YELLOW], [51, 99, 0], [100, 120, MEOWS_YELLOW], [121, INF, MEOWS_RED]];
export const MEOWS_RESP_RATE: readonly Row[] = [[-INF, 9, MEOWS_RED], [10, 20, 0], [21, 30, MEOWS_YELLOW], [31, INF, MEOWS_RED]];
export const MEOWS_SPO2: readonly Row[] = [[-INF, 94, MEOWS_RED], [95, INF, 0]];
/** Alert normal; voice yellow; pain or unresponsive red. New confusion is read as voice (DECIDED: AVPU has no "C"). */
export const MEOWS_CONSCIOUSNESS: Record<IpdConsciousness, number> = { alert: 0, confused: MEOWS_YELLOW, voice: MEOWS_YELLOW, pain: MEOWS_RED, unresponsive: MEOWS_RED };

export function meows(v: IpdEwsValues): IpdEwsScore {
  const parts: Record<string, number> = {};
  if (v.temperatureC !== undefined) parts.temperatureC = pointsOf(MEOWS_TEMPERATURE, round1(v.temperatureC));
  if (v.systolic !== undefined) parts.systolic = pointsOf(MEOWS_SYSTOLIC, Math.round(v.systolic));
  if (v.diastolic !== undefined) parts.diastolic = pointsOf(MEOWS_DIASTOLIC, Math.round(v.diastolic));
  if (v.pulse !== undefined) parts.pulse = pointsOf(MEOWS_PULSE, Math.round(v.pulse));
  if (v.respRate !== undefined) parts.respRate = pointsOf(MEOWS_RESP_RATE, Math.round(v.respRate));
  if (v.spo2 !== undefined) parts.spo2 = pointsOf(MEOWS_SPO2, Math.round(v.spo2));
  if (v.consciousness !== undefined) parts.consciousness = MEOWS_CONSCIOUSNESS[v.consciousness];
  const reds = Object.values(parts).filter((p) => p === MEOWS_RED).length;
  const yellows = Object.values(parts).filter((p) => p === MEOWS_YELLOW).length;
  const value = reds * MEOWS_RED + yellows * MEOWS_YELLOW;
  const band: IpdEwsBand = reds >= 2 ? "high" : reds >= 1 || yellows >= 2 ? "medium" : "low";
  const complete = ["temperatureC", "systolic", "diastolic", "pulse", "respRate", "spo2", "consciousness"].every((k) => k in parts);
  return { kind: "meows", value, band, complete, singleRed: reds > 0, parts };
}

// ═══════════════════════════════════════════ PEWS ═══════════════════════════════════════════
/*
 * Brighton Paediatric Early Warning Score: Monaghan A. "Detecting and managing deterioration in children."
 * Paediatric Nursing 2005;17(1):32–35, the scoring chart (printed on p. 33 — VERIFY THE PAGE AND EVERY ROW AGAINST
 * THE PRINTED CHART BEFORE GO-LIVE, owed in MAP.md). Three rows, each 0–3: behaviour, cardiovascular, respiratory; +2 for quarter-
 * hourly nebulisers or persistent post-operative vomiting (not captured here — owed with eMAR).
 *
 * The chart reads heart and breathing rates as "above / below normal for age"; the normal ranges are the Advanced
 * Paediatric Life Support ones (APLS, 6th ed., Advanced Life Support Group 2016, Table 1.1 "normal physiological values" — VERIFY the
 * table number, page and the five age bands before go-live, owed in MAP.md).
 *   behaviour      alert 0 · responds to voice (sleeping) 1 · confused / lethargic, or to pain only, or unresponsive 3
 *   cardiovascular capillary refill ≤2 s 0 · 3 s 1 · 4 s, or pulse ≥20 above normal 2 ·
 *                  ≥5 s, or pulse ≥30 above normal, or bradycardia (below normal) 3
 *   respiratory    within normal 0 · >10 above normal, or any supplemental oxygen 1 · >20 above normal 2 ·
 *                  ≥5 below normal 3
 * SpO2 is not a Brighton parameter: it is charted, not scored.
 * Bands (DECIDED, the safer reading of Brighton's escalation steps), exactly as `pews()` computes them: total 0–2
 * low; 3–4 medium — which INCLUDES any single row scoring 3 (a lone 3 is already a total of 3); 5+ high. The
 * `low_medium` branch in the code is unreachable for PEWS and kept only so the three charts share one band shape.
 */
export type ApplsBand = { maxAgeYears: number; pulse: readonly [number, number]; respRate: readonly [number, number] };
export const APLS_NORMALS: readonly ApplsBand[] = [
  { maxAgeYears: 1, pulse: [110, 160], respRate: [30, 40] },
  { maxAgeYears: 2, pulse: [100, 150], respRate: [25, 35] },
  { maxAgeYears: 5, pulse: [95, 140], respRate: [25, 30] },
  { maxAgeYears: 12, pulse: [80, 120], respRate: [20, 25] },
  { maxAgeYears: 16, pulse: [60, 100], respRate: [15, 20] },
];
export function applsNormalFor(ageYears: number): ApplsBand {
  return APLS_NORMALS.find((b) => ageYears < b.maxAgeYears) ?? APLS_NORMALS[APLS_NORMALS.length - 1]!;
}
export const PEWS_BEHAVIOUR: Record<IpdConsciousness, number> = { alert: 0, voice: 1, confused: 3, pain: 3, unresponsive: 3 };

export function pews(v: IpdEwsValues, ageYears: number): IpdEwsScore {
  const normal = applsNormalFor(ageYears);
  const parts: Record<string, number> = {};
  if (v.consciousness !== undefined) parts.behaviour = PEWS_BEHAVIOUR[v.consciousness];
  if (v.pulse !== undefined || v.capRefillSec !== undefined) {
    let cv = 0;
    if (v.capRefillSec !== undefined) {
      const crt = Math.round(v.capRefillSec);
      cv = Math.max(cv, crt >= 5 ? 3 : crt === 4 ? 2 : crt === 3 ? 1 : 0);
    }
    if (v.pulse !== undefined) {
      const [lo, hi] = normal.pulse;
      const p = Math.round(v.pulse);
      cv = Math.max(cv, p < lo ? 3 : p >= hi + 30 ? 3 : p >= hi + 20 ? 2 : 0);
    }
    parts.cardiovascular = cv;
  }
  if (v.respRate !== undefined || v.onOxygen !== undefined) {
    let rs = 0;
    if (v.onOxygen === true) rs = 1;
    if (v.respRate !== undefined) {
      const [lo, hi] = normal.respRate;
      const r = Math.round(v.respRate);
      rs = Math.max(rs, r <= lo - 5 ? 3 : r > hi + 20 ? 2 : r > hi + 10 ? 1 : 0);
    }
    parts.respiratory = rs;
  }
  const value = Object.values(parts).reduce((s, p) => s + p, 0);
  const singleRed = Object.values(parts).some((p) => p >= 3);
  const band: IpdEwsBand = value >= 5 ? "high" : value >= 3 ? "medium" : singleRed ? "low_medium" : "low";
  const complete = v.consciousness !== undefined && v.pulse !== undefined && v.respRate !== undefined;
  return { kind: "pews", value, band, complete, singleRed, parts };
}

// ═══════════════════════════════════════════ choosing ═══════════════════════════════════════════

export type IpdEwsPatient = {
  /** Whole years from the date of birth at the time of the set; null when the date of birth is unknown. */
  ageYears: number | null;
  sex: string | null;
  /** The nursing assessment's answer: pregnant, or up to 42 days after delivery. */
  obstetric: "none" | "pregnant" | "postpartum" | null;
  department: string | null;
  bedClass: string | null;
};
/** Under this age a child is scored by PEWS (RCP 2017: NEWS2 is not validated under 16). */
export const IPD_PEWS_UNDER_YEARS = 16;
export const IPD_OBSTETRIC_DEPARTMENTS: readonly string[] = ["OBG"];

export function ewsKindFor(p: IpdEwsPatient): IpdEwsKind {
  if (p.ageYears !== null && p.ageYears < IPD_PEWS_UNDER_YEARS) return "pews";
  if (p.obstetric === "pregnant" || p.obstetric === "postpartum") return "meows";
  const female = p.sex === "female" || p.sex === "F" || p.sex === "f";
  if (female && p.obstetric !== "none" && (p.bedClass === "ldr" || (p.department !== null && IPD_OBSTETRIC_DEPARTMENTS.includes(p.department.toUpperCase())))) {
    return "meows";
  }
  return "news2";
}

export function scoreEws(kind: IpdEwsKind, v: IpdEwsValues, ageYears: number | null): IpdEwsScore {
  if (kind === "meows") return meows(v);
  if (kind === "pews") return pews(v, ageYears ?? 15);
  return news2(v);
}

/**
 * How often a set is due after one in this band (DECIDED from RCP 2017 Chart 3, clinical response): 0 → 12-hourly;
 * 1–4 → 4-hourly; a single 3 or 5–6 → hourly; 7+ → every 15 minutes (continuous monitoring is the chart's word; a
 * ward without monitors charts quarter-hourly). The first set is due one hour after admission, with the assessment.
 */
export function ewsNextDueMinutes(score: Pick<IpdEwsScore, "value" | "band"> | null): number {
  if (score === null) return 60;
  if (score.band === "high") return 15;
  if (score.band === "medium" || score.band === "low_medium") return 60;
  return score.value === 0 ? 12 * 60 : 4 * 60;
}
