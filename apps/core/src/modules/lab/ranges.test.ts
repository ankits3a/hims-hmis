import { ageInDaysIst, applicabilityBreach, flagFor, resolveRange } from "./ranges";
import type { AnalyteRow, RangeRow } from "./ranges";

/**
 * PLAN 17a T3 — THE RANGE RESOLVER. Assertion Book rows **A1, A2 and A8**.
 *
 * ═══ FAIL-FIRST, AND WHY IT IS THE MUTANT RATHER THAN A RED RUN (AGENT-RULES §2.4/§2.5) ═══
 *
 * These are brand-new pure functions. A test written before them fails with
 * `Cannot find module './ranges'` — an unresolved-import error, which §2.5 says proves nothing. The
 * fail-first owed by this task is therefore discharged by the MUTANTS: each one is a wrong
 * implementation of a rule that a reader would find plausible, and the assertion's failure against
 * it is quoted in the phase document's §9.4. That is the stronger evidence and it is the one §2.5
 * points at.
 */
const ANALYTE = (over: Partial<AnalyteRow> = {}): Pick<AnalyteRow, "criticalLow" | "criticalHigh"> => ({
  criticalLow: null, criticalHigh: null, ...over,
});

function range(over: Partial<RangeRow> = {}): RangeRow {
  return {
    id: "rr-1", analyteId: "an-1", sex: "any", ageMinDays: 0, ageMaxDays: 36500,
    low: "11.0", high: "15.0", text: null, criticalLow: null, criticalHigh: null,
    source: "kit insert", effectiveFrom: "2026-01-01", createdBy: "t",
    createdAt: new Date(),
    // `...over` LAST, and its absence is what the first run of this file caught: every row came
    // back `rr-1` and all five assertions failed against a fixture that could not vary. A fixture
    // that cannot express the difference under test is the §9.4/A2 shape — it makes a suite look
    // rigorous while reaching nothing.
    ...over,
  } as RangeRow;
}

describe("the reference-range resolver (17a T3)", () => {
  /**
   * ═══ A1 — THE AGE IS IN IST DAYS AT COLLECTION, AND THE BOUNDARY IS INCLUSIVE-LOW ═══
   *
   * The discriminating instant is deliberately just after IST midnight and therefore on the
   * PREVIOUS UTC day: `2026-08-29T00:30+05:30` is `2026-08-28T19:00Z`. A resolver working in UTC
   * calls this child 364 days old and puts them in the neonate band; the shipped one calls them
   * 365 and puts them in the infant band, whose `ref_high` is different. A clinician reading the
   * flag cannot tell which band was used, which is what makes this silent rather than merely wrong.
   */
  it("A1: age is IST days at COLLECTION, and the band is [min, max)", () => {
    const collectedAt = new Date("2026-08-28T19:00:00.000Z"); // 00:30 IST on 2026-08-29
    expect(ageInDaysIst("2025-08-29", collectedAt)).toBe(365);
    // Half an hour earlier is still the previous IST day, and the child is a day younger.
    expect(ageInDaysIst("2025-08-29", new Date("2026-08-28T18:00:00.000Z"))).toBe(364);

    const neonate = range({ id: "rr-neonate", ageMinDays: 0, ageMaxDays: 365, high: "22.0" });
    const infant = range({ id: "rr-infant", ageMinDays: 365, ageMaxDays: 1825, high: "14.0" });
    const resolved = resolveRange(ANALYTE(), [neonate, infant], { dob: "2025-08-29", sex: "female" }, collectedAt);
    expect([resolved.refRangeId, resolved.high]).toEqual(["rr-infant", "14.0"]);

    // The boundary is INCLUSIVE at the low end and EXCLUSIVE at the high: at exactly 365 days the
    // infant band owns the patient, and the neonate band has already let go.
    const dayBefore = resolveRange(ANALYTE(), [neonate, infant], { dob: "2025-08-29" , sex: "female" },
      new Date("2026-08-28T18:00:00.000Z"));
    expect(dayBefore.refRangeId).toBe("rr-neonate");
  });

  /**
   * ═══ A2 — `any` IS THE FALLBACK, AND IT IS NOT `male` ═══
   *
   * The mutant falls back to the male row, which is the commoner one and looks harmless. It prints
   * a male haemoglobin range for a patient of unstated sex with nothing on the report to say so.
   */
  it("A2: sex falls back to `any`, never to male, and says so in a note", () => {
    const male = range({ id: "rr-m", sex: "male", low: "13.0", high: "17.0" });
    const female = range({ id: "rr-f", sex: "female", low: "12.0", high: "15.0" });

    const other = resolveRange(ANALYTE(), [male, female], { dob: "1990-01-01", sex: "other" }, new Date());
    expect(other.refRangeId).toBeNull();
    expect(other.low).toBeNull();
    expect(other.note).toBe("reference range: unspecified sex");

    // With an `any` row present it is used, and no note is needed for a patient who HAS a sex.
    const any = range({ id: "rr-any", sex: "any", low: "11.5", high: "16.0" });
    const withAny = resolveRange(ANALYTE(), [male, female, any], { dob: "1990-01-01", sex: "other" }, new Date());
    expect([withAny.refRangeId, withAny.note]).toEqual(["rr-any", "reference range: unspecified sex"]);
    const known = resolveRange(ANALYTE(), [male, female, any], { dob: "1990-01-01", sex: "male" }, new Date());
    expect([known.refRangeId, known.note]).toEqual(["rr-m", null]);
  });

  it("A2b: a patient with no date of birth gets the adult band and a footnote, never a guess", () => {
    const neonate = range({ id: "rr-neonate", ageMinDays: 0, ageMaxDays: 365 });
    const adult = range({ id: "rr-adult", ageMinDays: 0, ageMaxDays: 36500 });
    const r = resolveRange(ANALYTE(), [neonate, adult], { dob: null, sex: "female" }, new Date());
    expect(r.refRangeId).toBe("rr-adult");
    expect(r.note).toContain("date of birth not recorded");
  });

  /**
   * ═══ A8 — THE RANGE ROW'S CRITICAL OVERRIDE BEATS THE ANALYTE DEFAULT ═══
   *
   * A neonate's critical potassium is not an adult's. The mutant reads only the analyte's default
   * (6.0) and opens a critical call on 6.5 — a telephone call to a paediatrician at 02:00 about a
   * value that is normal for a three-day-old. The shipped resolver reads the band's 7.0 and does not.
   */
  it("A8: a critical override on the resolved band beats the analyte's default", () => {
    const analyte = ANALYTE({ criticalLow: "2.5", criticalHigh: "6.0" });
    const neonatal = range({ id: "rr-k-neo", ageMinDays: 0, ageMaxDays: 28, criticalHigh: "7.0", low: "3.5", high: "6.5" });
    const r = resolveRange(analyte, [neonatal], { dob: "2026-08-20", sex: "male" }, new Date("2026-08-29T06:30:00Z"));
    expect(r.criticalHigh).toBe("7.0");
    expect(flagFor(6.5, r)).not.toBe("HH");

    // With no override the analyte's own band applies, and 6.5 IS critical.
    const adult = range({ id: "rr-k-adult", ageMinDays: 0, ageMaxDays: 36500, low: "3.5", high: "5.1" });
    const a = resolveRange(analyte, [adult], { dob: "1990-01-01", sex: "male" }, new Date());
    expect([a.criticalHigh, flagFor(6.5, a)]).toEqual(["6.0", "HH"]);
  });

  /**
   * THE FLAG'S OWN ORDER: the CRITICAL band is consulted before the ordinary one. A potassium of
   * 7.2 that read `H` because the ordinary range was checked first is the flag failing at the one
   * value it exists for — `LL`/`HH` is what a worklist sorts to the top and what a screen reddens.
   */
  it("flagFor puts the critical band ahead of the ordinary one, and returns null with nothing to compare", () => {
    const r = resolveRange(ANALYTE({ criticalLow: "2.5", criticalHigh: "6.0" }),
      [range({ low: "3.5", high: "5.1" })], { dob: "1990-01-01", sex: "male" }, new Date());
    expect([flagFor(7.2, r), flagFor(5.5, r), flagFor(4.0, r), flagFor(3.0, r), flagFor(2.0, r)])
      .toEqual(["HH", "H", "N", "L", "LL"]);
    const textOnly = resolveRange(ANALYTE(), [range({ low: null, high: null, text: "Negative" })],
      { dob: "1990-01-01", sex: "male" }, new Date());
    expect([textOnly.text, flagFor(1, textOnly)]).toEqual(["Negative", null]);
  });

  /* ═════════ 17d T1 — APPLICABILITY: is this test ABOUT this patient? (design EdgeCases #15) ═════════ */

  /**
   * ═══ FAIL-FIRST, BY MUTANT, FOR THE REASON THIS FILE'S HEADER ALREADY GIVES ═══
   *
   * `applicabilityBreach` is a new pure function, so a test written before it fails on an
   * unresolved import and proves nothing (§2.5). Each assertion below is therefore paired with the
   * plausible wrong implementation it kills, named in the test.
   */
  const APPLIES = (over: Partial<AnalyteRow> = {}): Pick<
    AnalyteRow, "appliesToSex" | "appliesMinAgeDays" | "appliesMaxAgeDays"
  > => ({ appliesToSex: null, appliesMinAgeDays: null, appliesMaxAgeDays: null, ...over });

  const AT = new Date("2026-09-03T06:30:00Z");

  it("an undeclared analyte applies to everybody — which is every analyte seeded before 17d", () => {
    // MUTANT: a rule that treats `null` as "declared for nobody" refuses the whole catalogue.
    expect(applicabilityBreach(APPLIES(), { dob: "1990-05-10", sex: "male" }, AT)).toBeNull();
    expect(applicabilityBreach(APPLIES(), { dob: null, sex: null }, AT)).toBeNull();
  });

  it("a female-only analyte on a male record is a SEX breach, and names both sides of it", () => {
    // MUTANT: `subject.sex !== declared` written as a truthiness check passes `null !== "female"`
    // and refuses every patient of unrecorded sex — see the next test for why that is wrong.
    expect(applicabilityBreach(APPLIES({ appliesToSex: "female" }), { dob: "1990-05-10", sex: "male" }, AT))
      .toEqual({ kind: "sex", declared: "female", patient: "male" });
    expect(applicabilityBreach(APPLIES({ appliesToSex: "male" }), { dob: "1990-05-10", sex: "male" }, AT))
      .toBeNull();
  });

  /**
   * The two silences the rule keeps on purpose. Both are the same principle: this rule exists to
   * catch a SWAPPED TUBE, and neither an unrecorded sex nor an unrecorded birthday is evidence of
   * one — while refusing on either would withhold a result over a registration default.
   */
  it("`other`, `unknown` and an absent sex are NEVER refused by the sex rule", () => {
    // MUTANT: `subject.sex !== declared` without the male/female guard refuses all three.
    for (const sex of ["other", "unknown", null]) {
      expect(applicabilityBreach(APPLIES({ appliesToSex: "female" }), { dob: "1990-05-10", sex }, AT))
        .toBeNull();
    }
  });

  it("a patient with no recorded date of birth is NEVER refused by the age rule", () => {
    // MUTANT: `ageInDaysIst(subject.dob!, …)` on a null dob yields NaN, and every comparison with
    // NaN is false — so the mutant does not refuse either, it silently stops CHECKING. The kill is
    // the row below it: a real dob outside the band must still breach.
    expect(applicabilityBreach(APPLIES({ appliesMinAgeDays: 0, appliesMaxAgeDays: 29 }), { dob: null, sex: "female" }, AT))
      .toBeNull();
    expect(applicabilityBreach(APPLIES({ appliesMinAgeDays: 0, appliesMaxAgeDays: 29 }), { dob: "1990-05-10", sex: "female" }, AT))
      .toMatchObject({ kind: "age", declaredMinDays: 0, declaredMaxDays: 29 });
  });

  it("the age band is half-open [min, max) at COLLECTION, and an open end is honoured", () => {
    const neonatal = APPLIES({ appliesMinAgeDays: 0, appliesMaxAgeDays: 29 });
    const born = "2026-08-06"; // 28 days old at AT, 29 the next day
    // MUTANT: `days <= max` makes the 29th day applicable, which is a whole day of wrong ranges.
    expect(applicabilityBreach(neonatal, { dob: born, sex: "female" }, new Date("2026-09-03T06:30:00Z")))
      .toBeNull();
    expect(applicabilityBreach(neonatal, { dob: born, sex: "female" }, new Date("2026-09-04T06:30:00Z")))
      .toMatchObject({ kind: "age", patientDays: 29 });
    // An open lower end: declared only for adults, nothing said about the top.
    const adult = APPLIES({ appliesMinAgeDays: 6570, appliesMaxAgeDays: null });
    expect(applicabilityBreach(adult, { dob: "1990-05-10", sex: "male" }, AT)).toBeNull();
    expect(applicabilityBreach(adult, { dob: "2020-05-10", sex: "male" }, AT)).toMatchObject({ kind: "age" });
  });

  it("SEX is reported before AGE when both breach — the tube is the graver of the two", () => {
    // MUTANT: age checked first turns a swapped tube into a paediatric range query.
    const both = APPLIES({ appliesToSex: "female", appliesMinAgeDays: 0, appliesMaxAgeDays: 29 });
    expect(applicabilityBreach(both, { dob: "1990-05-10", sex: "male" }, AT)).toMatchObject({ kind: "sex" });
  });
});
