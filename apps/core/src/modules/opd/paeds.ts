import { z } from "zod";
import { IAP_2023_DOSES, VACCINE_SITES } from "./paeds-data/iap-2023-schedule";
import { lmsZ, lmsZRestricted, normalCdf, rowAt } from "./paeds-data/lms";
import { WHO_BFA } from "./paeds-data/who-bfa";
import { WHO_HCFA } from "./paeds-data/who-hcfa";
import { WHO_LHFA } from "./paeds-data/who-lhfa";
import { WHO_WFA } from "./paeds-data/who-wfa";
import { OpdError } from "./errors";
import { IST_OFFSET_MS } from "./time";
import type { AgeSpec } from "./paeds-data/iap-2023-schedule";
import type { LmsTable, Sex } from "./paeds-data/lms";

/**
 * ═══ THE PAEDIATRICS PROFILE — THE ARITHMETIC (01-CONSULT-ENGINE.md §6.2) ═══
 *
 * Pure functions only; `sections.ts` reads the rows and calls these. Three things:
 *
 *   · AGE in years, months and days on the hospital's (IST) calendar.
 *   · GROWTH — weight, length/height, head circumference and BMI as z-score and centile.
 *     Under 5 years: the WHO Child Growth Standards 2006 (LMS tables in `paeds-data/who-*.ts`).
 *     5–18 years: the IAP 2015 charts (Khadilkar et al., Indian Pediatr 2015;52:47-55) were built
 *     with the LMS method, but the L, M and S values were NOT published — the companion paper says
 *     they "can be obtained by writing to the authors for research purpose" (Khadilkar VV,
 *     Khadilkar AV. Indian J Endocrinol Metab 2015;19:470-6). Approximating them from the printed
 *     centiles would be inventing reference values, so from 5 years the screen shows the
 *     measurement and the BMI and says WHY there is no z-score (`iap_2015_lms_unpublished`). The
 *     owner's move: obtain the LMS file from the IAP Growth Chart Committee (and its licence).
 *   · IMMUNISATION — the IAP 2023 timetable (`paeds-data/iap-2023-schedule.ts`): due, overdue and
 *     given per dose from the date of birth, and "given today" as an APPEND-ONLY record.
 *
 * NOT HERE, BY RULING: weight-based dosing (§11.1 — the IAP Drug Formulary and BNFc are paid
 * references; a licence is an owner ruling). Nothing in this file produces a dose.
 */

const DAY_MS = 86_400_000;

// ——— age ———

/** The IST calendar date of an instant, as a UTC-midnight Date. */
function istDay(at: Date): Date {
  const ist = new Date(at.getTime() + IST_OFFSET_MS);
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()));
}

/** y years and m months after a calendar date; a day the month does not have becomes its last day. */
function addMonths(d: Date, months: number): Date {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + months;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(d.getUTCDate(), last)));
}

export type AgeYmd = { years: number; months: number; days: number; totalDays: number };

/**
 * Completed years, then months, then days — the way a paediatric register writes "1 y 3 m 13 d".
 * `dob` is a calendar date (UTC midnight, as the patients table stores it); `at` is an instant,
 * read on the IST calendar.
 */
export function ageYmd(dob: Date, at: Date): AgeYmd {
  const today = istDay(at);
  const birth = new Date(Date.UTC(dob.getUTCFullYear(), dob.getUTCMonth(), dob.getUTCDate()));
  const totalDays = Math.round((today.getTime() - birth.getTime()) / DAY_MS);
  if (totalDays < 0) return { years: 0, months: 0, days: 0, totalDays };
  let months = (today.getUTCFullYear() - birth.getUTCFullYear()) * 12 + today.getUTCMonth() - birth.getUTCMonth();
  if (addMonths(birth, months).getTime() > today.getTime()) months -= 1;
  const days = Math.round((today.getTime() - addMonths(birth, months).getTime()) / DAY_MS);
  return { years: Math.floor(months / 12), months: months % 12, days, totalDays };
}

const iso = (d: Date): string => d.toISOString().slice(0, 10);
const parseIso = (s: string): Date => new Date(`${s}T00:00:00Z`);

/** The calendar date a child reaches an age in the timetable's unit. */
export function dateAtAge(dobIso: string, spec: AgeSpec): string {
  const dob = parseIso(dobIso);
  if ("w" in spec) return iso(new Date(dob.getTime() + spec.w * 7 * DAY_MS));
  if ("m" in spec) return iso(addMonths(dob, spec.m));
  return iso(addMonths(dob, spec.y * 12));
}

const addDaysIso = (s: string, n: number): string => iso(new Date(parseIso(s).getTime() + n * DAY_MS));
const addMonthsIso = (s: string, n: number): string => iso(addMonths(parseIso(s), n));
const yearsBetweenIso = (from: string, to: string): number => {
  const a = parseIso(from);
  const b = parseIso(to);
  let months = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + b.getUTCMonth() - a.getUTCMonth();
  if (addMonths(a, months).getTime() > b.getTime()) months -= 1;
  return months / 12;
};

// ——— growth ———

export type Indicator = "wfa" | "lhfa" | "hcfa" | "bfa";
export type Measure = "length" | "height";
const TABLES: Record<Indicator, LmsTable> = { wfa: WHO_WFA, lhfa: WHO_LHFA, hcfa: WHO_HCFA, bfa: WHO_BFA };
/** WHO `anthro`'s flags for a z-score too far out to be a measurement (a typo, a wrong unit). */
const IMPLAUSIBLE: Record<Indicator, [number, number]> = { wfa: [-6, 5], lhfa: [-6, 6], hcfa: [-5, 5], bfa: [-5, 5] };
/** Weight-for-age and BMI-for-age use the WHO's restricted z beyond ±3 SD; length and head circumference do not. */
const RESTRICTED: Record<Indicator, boolean> = { wfa: true, lhfa: false, hcfa: false, bfa: true };
/** The WHO standards switch from recumbent length to standing height at 731 days. */
const HEIGHT_FROM_DAY = 731;

/**
 * WHO's length/height convention: a child under 731 days measured standing gains 0.7 cm; a child
 * from 731 days measured lying loses 0.7 cm (WHO `anthro` `adjust_lenhei`). Unknown: as given.
 */
export function adjustLength(ageDays: number, cm: number, measure: Measure | null): number {
  if (measure === "height" && ageDays < HEIGHT_FROM_DAY) return cm + 0.7;
  if (measure === "length" && ageDays >= HEIGHT_FROM_DAY) return cm - 0.7;
  return cm;
}

const round = (n: number, dp: number): number => Math.round(n * 10 ** dp) / 10 ** dp;

/**
 * One WHO z-score: `null` outside the table (0–1826 days) or for a value that is not a positive
 * number. `value` is what was charted (a length after WHO's 0.7 cm adjustment). z to 2 decimals,
 * as the WHO's software reports it; the centile to 1 decimal.
 */
export function whoZ(
  indicator: Indicator, sex: Sex, ageDays: number, value: number, measure: Measure | null = null,
): { value: number; z: number; percentile: number; implausible: boolean } | null {
  if (!Number.isFinite(value) || value <= 0) return null;
  const row = rowAt(TABLES[indicator], sex, ageDays);
  if (row === null) return null;
  const v = indicator === "lhfa" ? adjustLength(ageDays, value, measure) : value;
  const raw = RESTRICTED[indicator] ? lmsZRestricted(v, row) : lmsZ(v, row);
  const z = round(raw, 2);
  const [lo, hi] = IMPLAUSIBLE[indicator];
  return { value: v, z, percentile: round(normalCdf(raw) * 100, 1), implausible: z < lo || z > hi };
}

export type GrowthInput = {
  sex: Sex | null;
  /** Age today in completed days. */
  ageDays: number;
  dobEstimated: boolean;
  /** The weight on record: today's, or the last one with the age it was taken at. */
  weight: { kg: number; ageDays: number; today: boolean } | null;
  lengthCm: number | null;
  measure: Measure | null;
  headCircCm: number | null;
};
export type GrowthReason =
  | "not_measured" | "dob_estimated" | "sex_not_charted" | "iap_2015_lms_unpublished"
  | "who_hc_under_5_only" | "weight_not_today" | "out_of_range";
export type IndicatorResult = {
  key: Indicator;
  /** The measurement charted (length after WHO's adjustment; BMI computed). Null when not measured. */
  value: number | null;
  z: number | null;
  percentile: number | null;
  implausible: boolean;
  reference: "WHO 2006" | "IAP 2015" | null;
  /** Why there is no z-score. Null when there is one. */
  reason: GrowthReason | null;
};

/** The last day the WHO tables cover (5 years). */
export const WHO_LAST_DAY = WHO_WFA.boys.length - 1;

/** The four indicators, each with a z-score or the reason it has none. */
export function growthIndicators(g: GrowthInput): IndicatorResult[] {
  const len = g.lengthCm === null ? null : adjustLength(g.ageDays, g.lengthCm, g.measure);
  const bmi = g.weight !== null && g.weight.today && len !== null && len > 0 ? g.weight.kg / ((len / 100) ** 2) : null;
  const under5 = g.ageDays <= WHO_LAST_DAY;
  const one = (key: Indicator, value: number | null, ageDays: number, extra: GrowthReason | null = null): IndicatorResult => {
    const shown = key === "lhfa" ? len : value;
    const none = (reason: GrowthReason, reference: IndicatorResult["reference"] = null): IndicatorResult =>
      ({ key, value: shown, z: null, percentile: null, implausible: false, reference, reason });
    if (g.dobEstimated) return none("dob_estimated");
    if (g.sex === null) return none("sex_not_charted");
    if (extra !== null) return none(extra);
    if (value === null) return none("not_measured");
    if (!under5 || ageDays > WHO_LAST_DAY) {
      return key === "hcfa" ? none("who_hc_under_5_only") : none("iap_2015_lms_unpublished", "IAP 2015");
    }
    // Length already adjusted above: chart it as given.
    const r = whoZ(key, g.sex, ageDays, value, null);
    if (r === null) return none("out_of_range");
    return { key, value: r.value, z: r.z, percentile: r.percentile, implausible: r.implausible, reference: "WHO 2006", reason: null };
  };
  const weightNotToday = g.weight !== null && !g.weight.today && len !== null;
  return [
    one("wfa", g.weight?.kg ?? null, g.weight?.ageDays ?? g.ageDays),
    one("lhfa", len, g.ageDays),
    one("hcfa", g.headCircCm, g.ageDays),
    one("bfa", bmi, g.ageDays, weightNotToday ? "weight_not_today" : null),
  ];
}

// ——— which weight ———

export type VitalsWeightRow = {
  encounterId: string; weightKg: number | null; heightCm: number | null; carriedForward: readonly string[]; recordedAt: Date;
};

/**
 * THE WEIGHT ON RECORD (§6.2, §11.1: "the weight comes from today's vitals, and a stale weight is
 * flagged"). `rows` are the patient's active vitals, newest first. Today's weight is one MEASURED on
 * this visit — a number carried forward from an earlier chart is not a measurement. Without one,
 * the last measured weight is returned with `today: false` and how many days old it is. The height
 * is taken from this visit's chart only, and only when measured (a child's height is not carried).
 */
export function pickWeight(rows: readonly VitalsWeightRow[], encounterId: string, now: Date): {
  weight: { kg: number; recordedAt: string; today: boolean; daysAgo: number } | null; heightTodayCm: number | null;
} {
  const measured = (r: VitalsWeightRow, k: string): boolean => !r.carriedForward.includes(k);
  const w = rows.find((r) => r.weightKg !== null && measured(r, "weightKg"));
  const todayRow = rows.find((r) => r.encounterId === encounterId);
  const heightTodayCm = todayRow !== undefined && todayRow.heightCm !== null && measured(todayRow, "heightCm") ? todayRow.heightCm : null;
  if (w === undefined) return { weight: null, heightTodayCm };
  const today = w.encounterId === encounterId;
  const daysAgo = Math.round((istDay(now).getTime() - istDay(w.recordedAt).getTime()) / DAY_MS);
  return { weight: { kg: w.weightKg!, recordedAt: w.recordedAt.toISOString(), today, daysAgo }, heightTodayCm };
}

// ——— immunisation ———

export type DoseStatus = "given" | "given_today" | "due" | "overdue" | "upcoming" | "optional" | "waiting" | "not_applicable";
export type GivenDose = { dose: string; on: string | null; where: "today" | "here" | "earlier" };
export type DoseView = {
  id: string; vaccine: string; label: string; status: DoseStatus;
  dueOn: string | null; overdueFrom: string | null;
  givenOn: string | null; givenWhere: GivenDose["where"] | null;
  note: string | null; uip: string | null;
};

/** The reminder window of a single-age dose (see the schedule file's DECIDED). */
const GRACE_DAYS = 28;
const later = (a: string, b: string): string => (a > b ? a : b);

/** Every dose of the timetable, with its status on `today` given what is on record. */
export function immunisationStatus(dobIso: string, today: string, given: readonly GivenDose[]): DoseView[] {
  const byDose = new Map<string, GivenDose>();
  for (const g of given) if (!byDose.has(g.dose)) byDose.set(g.dose, g);
  return IAP_2023_DOSES.map((d): DoseView => {
    const base = { id: d.id, vaccine: d.vaccine, label: d.label, note: d.note ?? null, uip: d.uip ?? null };
    const g = byDose.get(d.id);
    if (g !== undefined) {
      return { ...base, status: g.where === "today" ? "given_today" : "given", dueOn: null, overdueFrom: null, givenOn: g.on, givenWhere: g.where };
    }
    const none = (status: DoseStatus): DoseView => ({ ...base, status, dueOn: null, overdueFrom: null, givenOn: null, givenWhere: null });
    if (d.onlyIfStartedAtOrAfterYears !== undefined) {
      const first = byDose.get(d.onlyIfStartedAtOrAfterYears.dose);
      if (first === undefined || first.on === null || yearsBetweenIso(dobIso, first.on) < d.onlyIfStartedAtOrAfterYears.years) return none("not_applicable");
    }
    if (d.optional === true) return none("optional");
    let dueOn = dateAtAge(dobIso, d.at);
    let overdueFrom = d.overdueFrom !== undefined ? dateAtAge(dobIso, d.overdueFrom) : addDaysIso(dueOn, GRACE_DAYS);
    if (d.after !== undefined) {
      const prior = byDose.get(d.after.dose);
      if (prior === undefined) return none("waiting");
      if (prior.on !== null) {
        const startedAt15 = d.after.monthsIfStartedAt15 !== undefined && yearsBetweenIso(dobIso, prior.on) >= 15;
        dueOn = later(dueOn, addMonthsIso(prior.on, startedAt15 ? d.after.monthsIfStartedAt15! : d.after.months));
      }
      overdueFrom = addDaysIso(dueOn, GRACE_DAYS);
    }
    const status: DoseStatus = today < dueOn ? "upcoming" : today >= overdueFrom ? "overdue" : "due";
    return { ...base, status, dueOn, overdueFrom, givenOn: null, givenWhere: null };
  });
}

export const DOSE_IDS = IAP_2023_DOSES.map((d) => d.id);

const givenTodayEntry = z.object({
  id: z.string().trim().max(64).optional(),
  dose: z.string().trim().min(1).max(32),
  batch: z.string().trim().min(1, "a batch number is required").max(40),
  site: z.enum(VACCINE_SITES),
  brand: z.string().trim().max(60).default(""),
  /** Set once, with the reason, when the entry was wrong. The entry itself is never removed. */
  errorReason: z.string().trim().min(3).max(200).nullable().default(null),
});
const earlierEntry = z.object({
  dose: z.string().trim().min(1).max(32),
  on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
  /** Where it was given, as the card or the parent says ("Anganwadi", "private clinic"). */
  where: z.string().trim().max(80).default(""),
});
export const immunisationBody = z.object({
  givenToday: z.array(givenTodayEntry).max(20).default([]),
  earlier: z.array(earlierEntry).max(60).default([]),
  note: z.string().trim().max(300).default(""),
});
export type ImmunisationBody = z.input<typeof immunisationBody>;
export type ImmunisationRecord = z.output<typeof immunisationBody> & { givenToday: (z.output<typeof givenTodayEntry> & { id: string })[] };

const refuse = (message: string): never => { throw new OpdError("invalid_section_body", message); };
const sameEntry = (a: z.output<typeof givenTodayEntry>, b: z.output<typeof givenTodayEntry>): boolean =>
  a.dose === b.dose && a.batch === b.batch && a.site === b.site && a.brand === b.brand;

/**
 * "GIVEN TODAY" IS APPEND-ONLY. A vaccine given is a fact on a child's record: a save may add an
 * entry, or mark one entered in error WITH A REASON, and nothing else — an entry cannot be removed
 * or rewritten, and a mark cannot be taken back. `givenElsewhere` is every dose on record on the
 * patient's OTHER visits; a dose already given is refused, here or on the card.
 */
export function mergeImmunisation(
  prev: ImmunisationRecord | null, input: ImmunisationBody, givenElsewhere: ReadonlySet<string>, newId: () => string,
): ImmunisationRecord {
  const next = immunisationBody.parse(input);
  const before = new Map((prev?.givenToday ?? []).map((e) => [e.id, e]));
  const seen = new Set<string>();
  const out: ImmunisationRecord["givenToday"] = [];
  for (const e of next.givenToday) {
    const old = e.id === undefined ? undefined : before.get(e.id);
    if (old !== undefined) {
      if (!sameEntry(old, e) || (old.errorReason !== null && old.errorReason !== e.errorReason)) {
        refuse(`the ${old.dose} entry given today cannot be changed — mark it entered in error with a reason instead`);
      }
      out.push({ ...e, id: old.id });
    } else {
      if (e.errorReason !== null) refuse("a new entry cannot arrive already marked in error");
      out.push({ ...e, id: newId() });
    }
  }
  for (const id of before.keys()) if (!out.some((e) => e.id === id)) refuse(`the ${before.get(id)!.dose} entry given today cannot be removed — mark it entered in error with a reason instead`);
  for (const e of [...out.filter((x) => x.errorReason === null), ...next.earlier]) {
    if (!DOSE_IDS.includes(e.dose)) refuse(`unknown dose ${e.dose}`);
    if (seen.has(e.dose) || givenElsewhere.has(e.dose)) refuse(`${e.dose} is already given`);
    seen.add(e.dose);
  }
  return { ...next, givenToday: out };
}
