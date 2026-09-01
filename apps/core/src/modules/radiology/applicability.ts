/**
 * PLAN 18a T3 / DD14 — **THE PCPNDT APPLICABILITY RULE, AND IT IS PURE ON PURPOSE.**
 *
 * The rule that decides whether a scan falls under the Pre-Conception and Pre-Natal Diagnostic
 * Techniques Act is three facts and no I/O: the study type's own `pcpndt_applicable` flag, the
 * patient's CLINICAL SEX, and the patient's age on the day of the scan. It is a separate file from
 * `place.ts` for one reason — a rule with a criminal statute behind it should be testable without a
 * database, so that every boundary can be walked cheaply and none is left to an e2e that happens to
 * use a 24-year-old.
 *
 * ═══ `sex`, NEVER `administrative_gender` — AND THIS IS THE FIRST CLINICAL READER OF EITHER ═══
 *
 * Plan 22c-A DD4 split the two deliberately: `administrative_gender` is the LEGAL identity marker
 * that prints on the card and is amendment-gated, and `sex` is the CLINICAL fact. `patients.ts`'s
 * own header records that at the time of that split *"no clinical reader of `sex` exists yet — all
 * 52 non-test references are display, document…"*. **This function is that first clinical reader**,
 * and the distinction is not academic here: a trans man whose administrative gender reads `male`
 * and whose clinical sex is `female` is a person the Act covers, and reading the legal marker would
 * leave that scan unregistered under a criminal statute. T3 A3's mutant is exactly this swap.
 *
 * ═══ THE AGE BAND IS INCLUSIVE AT BOTH ENDS ═══
 *
 * DD14 says "age 10–55". A3's mutant is `>` where `>=` belongs — *"a 55-year-old escapes the
 * form"* — so 10 and 55 are both INSIDE the band. Stated as `>= 10 && <= 55` rather than as a
 * negation, because the negated form is where the off-by-one hides.
 *
 * ═══ AN UNKNOWN DATE OF BIRTH IS APPLICABLE, NOT EXEMPT — DECIDED ═══
 *
 * `patients.dob` is nullable and `dob_estimated` marks an age the counter derived rather than read
 * off a document. DD14 says an estimated DOB COUNTS; it does not say what an ABSENT one does, and
 * the choice is this file's.
 *
 * **A female patient of unknown age, having a study type the Act covers, is treated as applicable.**
 * The Act's own direction is that the form is the default and the exemption is the thing that must
 * be established — N2's "no emergency bypass exists" is the same instinct one clause earlier. The
 * cost of over-applying is a Form F filled in for a woman who turns out to be 68; the cost of
 * under-applying is an unregistered obstetric scan and a prosecution. Those are not symmetrical, and
 * a null in a nullable column is not evidence of anything.
 *
 * `dob_estimated` does NOT weaken the rule for the same reason: an estimated 30 is still a 30.
 */

/** The patient facts the rule reads. Deliberately three fields, so a caller cannot pass a row. */
export type PcpndtPatientFacts = {
  /** The CLINICAL sex (`patients.sex`), never `administrative_gender`. */
  sex: string;
  /** `patients.dob` — nullable, and a null is APPLICABLE rather than exempt (see header). */
  dob: Date | null;
  /** True when the DOB was derived from an entered age. Counts exactly as a read one does. */
  dobEstimated?: boolean;
};

/** The study-type facts the rule reads. */
export type PcpndtStudyTypeFacts = {
  /** DD13's study-type body flag — whether this TYPE is one the Act covers at all. */
  pcpndtApplicable: boolean;
};

export type PcpndtApplicability = {
  /** True ⇒ the order item is `restricted` and the study carries `form_f_required`. */
  applicable: boolean;
  /**
   * Why, in a word, so a screen and an audit row can say something better than "no". Never shown to
   * a patient; it is for the technologist who asks why a form opened.
   */
  reason:
    | "type_not_covered"
    | "sex_not_female"
    | "age_outside_band"
    | "within_band"
    | "age_unknown"
    /** F65 — a date of birth after the day of the scan. Applicable, and a data-quality flag. */
    | "dob_not_credible";
  /** The age used, in whole years, or `null` when the DOB is absent. */
  ageYears: number | null;
};

/** The inclusive age band, as one constant with one owner (16a DD5). */
export const PCPNDT_AGE_MIN_YEARS = 10;
export const PCPNDT_AGE_MAX_YEARS = 55;

/**
 * Whole years elapsed, by CALENDAR and not by division. `(now - dob) / 365.25` is wrong twice a
 * year at the boundary, and this rule has two boundaries that decide whether a statutory form
 * opens. A patient whose birthday is today is exactly their new age.
 */
export function ageInYearsOn(dob: Date, asOf: Date): number {
  let age = asOf.getUTCFullYear() - dob.getUTCFullYear();
  const monthDelta = asOf.getUTCMonth() - dob.getUTCMonth();
  if (monthDelta < 0 || (monthDelta === 0 && asOf.getUTCDate() < dob.getUTCDate())) {
    age -= 1;
  }
  return age;
}

/**
 * DD14's rule. `asOf` is the day of the SCAN, passed by the caller — never `new Date()` here, so
 * that a backfilled placement and a test walk the same code and neither depends on when it runs.
 */
export function pcpndtApplicability(
  patient: PcpndtPatientFacts,
  studyType: PcpndtStudyTypeFacts,
  asOf: Date,
): PcpndtApplicability {
  if (!studyType.pcpndtApplicable) {
    return { applicable: false, reason: "type_not_covered", ageYears: null };
  }

  /**
   * `other` and `unknown` are NOT female. The Act is written about the sex determination of a
   * foetus; a patient recorded `unknown` is a data-quality problem to fix at the counter, and
   * treating it as female here would open a statutory form on every incomplete record in the
   * building — which is how a control becomes noise the floor routes around.
   */
  if (patient.sex !== "female") {
    return { applicable: false, reason: "sex_not_female", ageYears: null };
  }

  if (patient.dob === null) {
    return { applicable: true, reason: "age_unknown", ageYears: null };
  }

  const ageYears = ageInYearsOn(patient.dob, asOf);

  /**
   * ═══ F65 (CLOSE REVIEW) — A NULL DOB IS FAIL-SAFE AND A NONSENSE ONE WAS FAIL-OPEN ═══
   *
   * `ageInYearsOn` returns a NEGATIVE number for a date of birth after the day of the scan, and the
   * band test treated that as an ordinary out-of-band age: `applicable: false`, no `restricted`, no
   * `form_f_required`, no `form_f` gate, and `assertFormFRecorded` short-circuits — **an obstetric
   * scan performed with no entry in the statutory register at all.** A registration desk typing
   * `2004` as `2024`, or an ABDM import landing a DOB in the future, is all it takes.
   *
   * The header already argues this case for a NULL: *"the Act's default is the form and the
   * exemption is what must be established"*, and *"a null in a nullable column is not evidence of
   * anything"*. **An arithmetically impossible date is less evidence than a null**, not more — it is
   * a null wearing a number — so it lands on the same side. The reason is its own value so a screen
   * can say "this record's date of birth cannot be right" rather than "this scan is covered", which
   * is the sentence that gets the record fixed.
   */
  if (ageYears < 0) {
    return { applicable: true, reason: "dob_not_credible", ageYears };
  }

  const withinBand = ageYears >= PCPNDT_AGE_MIN_YEARS && ageYears <= PCPNDT_AGE_MAX_YEARS;
  return {
    applicable: withinBand,
    reason: withinBand ? "within_band" : "age_outside_band",
    ageYears,
  };
}
