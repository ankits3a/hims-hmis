import type { labAnalytes, labReferenceRanges } from "../../kernel/db/schema";

/**
 * PLAN 17a T3 / DD2 — THE REFERENCE RANGE, RESOLVED AT ENTRY AND SNAPSHOTTED ONTO THE RESULT.
 *
 * ═══ WHY THIS FILE IS PURE, AND WHY THAT IS THE WHOLE DESIGN ═══
 *
 * A range-book edit must never rewrite a flag on a report a pathologist already signed. The only
 * way to make that true is to resolve the range at ENTRY and store its values on `lab_results` —
 * so this function takes rows and returns a decision, reads nothing, and the caller (17b's
 * `enterResult`) writes the answer down. NABL wants the range the report was signed AGAINST, not
 * the current one, and a resolver that queried at report time would be unable to say which.
 *
 * ═══ THE AGE IS IN IST DAYS AT COLLECTION, AND THE BOUNDARY IS THE ASSERTION ═══
 *
 * A band is `[age_min_days, age_max_days)` — **inclusive low, EXCLUSIVE high** — which is what makes
 * a boundary decidable rather than a matter of opinion when two bands meet. And the age is computed
 * from IST calendar days, not from UTC: a child who turns one at 00:30 IST on the collection day is
 * one year old, and a resolver working in UTC would still call them a neonate for another five and
 * a half hours (T3 A1). `istDayIndex` here is the same arithmetic `modules/opd/time.ts` uses —
 * transcribed rather than imported, because a KERNEL-adjacent module importing an OPD helper for
 * date maths would make the lab depend on the outpatient department to know what day it is.
 */
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The IST calendar day an instant falls in, as a day NUMBER (not a string) — the unit ages count in. */
function istDayIndex(at: Date): number {
  return Math.floor((at.getTime() + IST_OFFSET_MS) / DAY_MS);
}

/** The IST calendar day a `YYYY-MM-DD` names. A date-of-birth is a CALENDAR fact, not an instant. */
function istDayIndexOfDate(date: string): number {
  return Math.floor(Date.parse(`${date}T00:00:00Z`) / DAY_MS);
}

/**
 * AGE IN WHOLE IST DAYS AT COLLECTION. Exported because T3 A1 asserts it directly: a boundary case
 * proved through five layers of resolution is a boundary case nobody can read.
 */
export function ageInDaysIst(dob: string, collectedAt: Date): number {
  return istDayIndex(collectedAt) - istDayIndexOfDate(dob);
}

/**
 * ═══ IS THIS RANGE-BOOK DATE STILL IN THE FUTURE? ═══
 *
 * `catalogue.ts` refuses a reference band whose `effective_from` has not arrived, and deciding that
 * needs the hospital's calendar day. **It lives HERE rather than there, and the reason is a census.**
 *
 * `test/ist-clock-parity.test.ts` pins every file allowed to construct the IST offset, and it caught
 * the range-book door adding a FOURTEENTH copy on its first CI run — as it caught the thirteenth,
 * and for the same reason. Two legitimate answers were available: add `catalogue.ts` to the list with
 * an argument, or put the question where the clock already is. This file is already on the list, it
 * already owns the range book's other calendar judgement (`ageInDaysIst`), and **"what is today"
 * should have exactly one definition in a module that decides which band a patient falls in**.
 *
 * Both sides use `istDayIndex`, so the comparison is between two IST calendar DAYS and not between
 * an instant and a midnight: a band dated today is in effect from 00:00 IST today, and at 23:00 IST
 * the day before it is not — which is the answer a curator entering tomorrow's kit lot expects.
 */
export function isFutureIstDay(date: string, at: Date): boolean {
  return istDayIndexOfDate(date) > istDayIndex(at);
}

export type RangeSubject = {
  /** `null` when the patient has no recorded date of birth (E7's UNK row, H4's estimate). */
  dob: string | null;
  /** `patients.administrative_gender` — the field the range book is written against. */
  sex: string | null;
  /** DD2 — reserved for the trimester-specific bands 17-M's obstetric panel will add. */
  pregnancyTrimester?: number | null;
};

export type AnalyteRow = typeof labAnalytes.$inferSelect;
export type RangeRow = typeof labReferenceRanges.$inferSelect;

export type ResolvedRange = {
  /** The row the flag was decided against — stored on the result so the decision is auditable. */
  refRangeId: string | null;
  low: string | null;
  high: string | null;
  text: string | null;
  /** DD12 — the band that opens a critical call, WITH the analyte default already applied. */
  criticalLow: string | null;
  criticalHigh: string | null;
  /** 02 H4/H5 — printed on the report when the range could not be chosen on the usual evidence. */
  note: string | null;
};

/** The four values `lab_reference_ranges.sex` admits. `any` is the fallback, never a wildcard match. */
const SEX_ANY = "any";

/**
 * ═══ THE FALLBACK IS `any`, AND IT IS NOT `male` (T3 A2) ═══
 *
 * A patient whose `administrative_gender` is `other` or `unknown` has no sex-specific row, and the
 * temptation is to fall back to the commoner one. **That silently prints a male haemoglobin range
 * for a patient nobody asked about**, and the clinician reading it has no way to know. So the
 * fallback is the `any` row if one exists, and otherwise NO numeric range plus a note that says
 * exactly why — an absent range a human must interpret is safer than a present range that is wrong.
 */
function pickBySex(rows: readonly RangeRow[], sex: string | null): { row: RangeRow | null; note: string | null } {
  const exact = sex === null ? undefined : rows.find((r) => r.sex === sex);
  if (exact) return { row: exact, note: null };
  const any = rows.find((r) => r.sex === SEX_ANY);
  if (any) {
    // A patient of unstated sex matched on an `any` row is normal and needs no footnote; one whose
    // stated sex simply has no row of its own is a GAP in the range book and the report says so.
    const note = sex === null || sex === "other" || sex === "unknown"
      ? "reference range: unspecified sex"
      : null;
    return { row: any, note };
  }
  return { row: null, note: "reference range: unspecified sex" };
}

/**
 * RESOLVE THE RANGE FOR ONE ANALYTE ON ONE PATIENT AT ONE INSTANT.
 *
 * `rows` are this analyte's range rows — the caller loads them once per analyte and passes them in,
 * which is what keeps this function pure and what lets T3 A1 and A2 assert boundaries without a
 * database.
 *
 * The order of the two filters is load-bearing: **AGE first, then SEX.** A neonate has a different
 * potassium range whatever their sex, and a range book that filtered by sex first would drop the
 * age-banded `any` row before ever comparing the ages.
 */
export function resolveRange(
  analyte: Pick<AnalyteRow, "criticalLow" | "criticalHigh">,
  rows: readonly RangeRow[],
  subject: RangeSubject,
  collectedAt: Date,
): ResolvedRange {
  const notes: string[] = [];

  /**
   * NO DATE OF BIRTH ⇒ NO AGE-BANDED RANGE, and the report says so (02 H4). The UNK patient (E7)
   * and an estimated DOB both land here. Choosing the adult band "because most patients are adults"
   * would be the same class of silent guess `pickBySex` refuses.
   */
  let candidates: readonly RangeRow[];
  if (subject.dob === null) {
    notes.push("reference range: date of birth not recorded");
    candidates = rows.filter((r) => r.ageMinDays === 0 && r.ageMaxDays >= 36500);
  } else {
    const ageDays = ageInDaysIst(subject.dob, collectedAt);
    // Inclusive low, EXCLUSIVE high — see the header. `36500` is the open-ended adult band's top.
    candidates = rows.filter((r) => ageDays >= r.ageMinDays && ageDays < r.ageMaxDays);
  }

  const { row, note } = pickBySex(candidates, subject.sex);
  if (note !== null) notes.push(note);

  /**
   * ═══ THE CRITICAL BAND: THE RANGE ROW'S OVERRIDE BEATS THE ANALYTE'S DEFAULT (T3 A8) ═══
   *
   * A neonate's critical potassium is not an adult's, and the override lives on the age-banded row
   * for exactly that reason. Reading only the analyte's default would open a critical call on a
   * value that is normal for a three-day-old — and the call ladder that follows is a telephone call
   * to a paediatrician at 02:00, so a false positive here is not free.
   *
   * `??` and not `||`: a critical bound of `0` is a real bound.
   */
  return {
    refRangeId: row?.id ?? null,
    low: row?.low ?? null,
    high: row?.high ?? null,
    text: row?.text ?? null,
    criticalLow: row?.criticalLow ?? analyte.criticalLow ?? null,
    criticalHigh: row?.criticalHigh ?? analyte.criticalHigh ?? null,
    note: notes.length === 0 ? null : notes.join("; "),
  };
}

/**
 * THE FLAG THE RESULT CARRIES — `L`/`H` outside the range, `LL`/`HH` outside the CRITICAL band,
 * `N` inside, `A` for an abnormal non-numeric result, `null` when there is nothing to compare to.
 *
 * The critical band is checked FIRST and wins, because `LL` is what a screen colours red and what a
 * worklist sorts to the top; a potassium of 7.2 that read `H` because the ordinary range was
 * consulted first is the flag failing at the one value it exists for.
 */
export function flagFor(value: number, range: ResolvedRange): "L" | "H" | "LL" | "HH" | "N" | null {
  const num = (s: string | null): number | null => (s === null ? null : Number(s));
  const cl = num(range.criticalLow), ch = num(range.criticalHigh);
  if (ch !== null && value >= ch) return "HH";
  if (cl !== null && value <= cl) return "LL";
  const lo = num(range.low), hi = num(range.high);
  if (lo === null && hi === null) return null;
  if (hi !== null && value > hi) return "H";
  if (lo !== null && value < lo) return "L";
  return "N";
}

/* ═══════════════════ 17d T1 — APPLICABILITY: is this test ABOUT this patient? ═══════════════════ */

/**
 * The breach, or `null` when the analyte applies. Pure, so the rule can be read in one place and
 * asserted without a database — and so the two ways it can fire are named rather than collapsed
 * into a boolean.
 */
export type ApplicabilityBreach =
  | { kind: "sex"; declared: string; patient: string }
  | { kind: "age"; declaredMinDays: number | null; declaredMaxDays: number | null; patientDays: number };

/**
 * **A VALUE CAN BE PERFECTLY ORDINARY AND STILL BE IMPOSSIBLE** (design board EdgeCases #15).
 *
 * A beta-hCG of 4200 mIU/mL is inside every envelope `outsideAbsurdEnvelope` knows about. What is
 * wrong with it is the man it is standing next to, and the ordinary explanation for that pairing is
 * not a rare endocrine tumour — it is that two tubes were swapped at the chair five minutes ago.
 * So this reads the PATIENT, which is the one thing the number-shaped guards never do.
 *
 * ═══ THE TWO REFUSALS THIS RULE DELIBERATELY DOES NOT MAKE ═══
 *
 * · **A patient of `other` or `unknown` administrative gender is never refused by the sex rule.**
 *   The record does not support the refusal. `pickBySex` already treats those two as "no sex-specific
 *   row applies" and footnotes the report; withholding the result instead would be a laboratory
 *   declining to work from a registration default, and the counter's default is `unknown`.
 * · **A patient with no recorded date of birth is never refused by the age rule** (E7's UNK row).
 *   An unknown age is not an age outside the band, and an age band that fired on a null would refuse
 *   every unidentified emergency admission in the hospital — which is the population least able to
 *   wait for a second technologist to walk over.
 *
 * Both silences are the same principle: this rule exists to catch a SWAP, and neither an
 * unrecorded sex nor an unrecorded birthday is evidence of one.
 */
export function applicabilityBreach(
  analyte: Pick<AnalyteRow, "appliesToSex" | "appliesMinAgeDays" | "appliesMaxAgeDays">,
  subject: RangeSubject,
  collectedAt: Date,
): ApplicabilityBreach | null {
  const declaredSex = analyte.appliesToSex;
  if (declaredSex !== null && (subject.sex === "male" || subject.sex === "female") && subject.sex !== declaredSex) {
    return { kind: "sex", declared: declaredSex, patient: subject.sex };
  }
  const { appliesMinAgeDays: min, appliesMaxAgeDays: max } = analyte;
  if ((min !== null || max !== null) && subject.dob !== null) {
    const days = ageInDaysIst(subject.dob, collectedAt);
    if ((min !== null && days < min) || (max !== null && days >= max)) {
      return { kind: "age", declaredMinDays: min, declaredMaxDays: max, patientDays: days };
    }
  }
  return null;
}

/** What the refusal says on a screen a technologist reads at speed. */
export function applicabilityBreachText(analyteCode: string, breach: ApplicabilityBreach): string {
  if (breach.kind === "sex") {
    return `${analyteCode} is reported only for ${breach.declared} patients and this record reads ` +
      `${breach.patient} — check the tube against the patient before the number goes in, and check ` +
      "every tube drawn at the same chair in the same minute";
  }
  const band = breach.declaredMinDays === null
    ? `under ${breach.declaredMaxDays} days`
    : breach.declaredMaxDays === null
      ? `from ${breach.declaredMinDays} days`
      : `${breach.declaredMinDays}–${breach.declaredMaxDays} days`;
  return `${analyteCode} is reported only for patients aged ${band} and this patient is ` +
    `${breach.patientDays} days old — check the tube against the patient before the number goes in`;
}
