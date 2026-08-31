import {
  PCPNDT_AGE_MAX_YEARS, PCPNDT_AGE_MIN_YEARS, ageInYearsOn, pcpndtApplicability,
} from "./applicability";

/**
 * PLAN 18a T3 — Assertion Book row **A3**, walked at every boundary.
 *
 * The rule is pure precisely so this suite can be exhaustive at the edges rather than
 * representative in the middle. A3 names two mutants and both are boundary or column mistakes:
 * reading `administrative_gender` instead of `sex`, and `>` where `>=` belongs.
 */
describe("the PCPNDT applicability rule (18a T3 A3 / DD14)", () => {
  const SCAN_DAY = new Date(Date.UTC(2026, 7, 31)); // 2026-08-31
  const covered = { pcpndtApplicable: true };
  const notCovered = { pcpndtApplicable: false };
  /** A DOB that makes the patient exactly `years` old on SCAN_DAY. */
  const dobForAge = (years: number) => new Date(Date.UTC(2026 - years, 7, 31));

  it("A3: a covered study on a female aged 24 IS applicable", () => {
    const v = pcpndtApplicability({ sex: "female", dob: dobForAge(24) }, covered, SCAN_DAY);
    expect(v).toEqual({ applicable: true, reason: "within_band", ageYears: 24 });
  });

  it("A3: the same study on a MALE is not applicable, and the reason says which fact decided it", () => {
    const v = pcpndtApplicability({ sex: "male", dob: dobForAge(24) }, covered, SCAN_DAY);
    expect(v).toEqual({ applicable: false, reason: "sex_not_female", ageYears: null });
  });

  it("A3: the same study on a female aged 62 is not applicable", () => {
    const v = pcpndtApplicability({ sex: "female", dob: dobForAge(62) }, covered, SCAN_DAY);
    expect(v).toEqual({ applicable: false, reason: "age_outside_band", ageYears: 62 });
  });

  it("a study type the Act does not cover is never applicable, whoever the patient is", () => {
    const v = pcpndtApplicability({ sex: "female", dob: dobForAge(24) }, notCovered, SCAN_DAY);
    expect(v).toEqual({ applicable: false, reason: "type_not_covered", ageYears: null });
  });

  /**
   * ═══ A3's SECOND MUTANT, AT BOTH ENDS — `>` WHERE `>=` BELONGS ═══
   *
   * *"compare age > 55 with `>=` → a 55-year-old escapes the form."* The band is INCLUSIVE, so 10
   * and 55 are inside and 9 and 56 are outside. All four are asserted, because a fix at one end
   * that broke the other would otherwise pass.
   */
  it("A3 mutant: the age band is INCLUSIVE at both ends — 10 and 55 are inside, 9 and 56 are not", () => {
    const applicableAt = (age: number) =>
      pcpndtApplicability({ sex: "female", dob: dobForAge(age) }, covered, SCAN_DAY).applicable;
    expect([9, 10, 55, 56].map(applicableAt)).toEqual([false, true, true, false]);
    expect([PCPNDT_AGE_MIN_YEARS, PCPNDT_AGE_MAX_YEARS]).toEqual([10, 55]);
  });

  /**
   * The day BEFORE a 10th birthday is nine; the birthday itself is ten. A rule that divided
   * milliseconds by 365.25 gets this wrong twice a year, and here it is the difference between a
   * statutory form opening and not.
   */
  it("the boundary turns on the BIRTHDAY, not on a division — the day before turns it off", () => {
    const tenthBirthday = new Date(Date.UTC(2016, 7, 31));
    const dayBefore = { sex: "female", dob: tenthBirthday, } as const;
    expect(pcpndtApplicability(dayBefore, covered, new Date(Date.UTC(2026, 7, 30))))
      .toMatchObject({ applicable: false, ageYears: 9 });
    expect(pcpndtApplicability(dayBefore, covered, new Date(Date.UTC(2026, 7, 31))))
      .toMatchObject({ applicable: true, ageYears: 10 });
  });

  it("ageInYearsOn counts whole calendar years, including across a leap day", () => {
    expect(ageInYearsOn(new Date(Date.UTC(2000, 1, 29)), new Date(Date.UTC(2026, 1, 28)))).toBe(25);
    expect(ageInYearsOn(new Date(Date.UTC(2000, 1, 29)), new Date(Date.UTC(2026, 2, 1)))).toBe(26);
  });

  /**
   * ═══ THE ESTIMATED DOB COUNTS, AND THE ABSENT ONE IS APPLICABLE ═══
   *
   * DD14 says an estimated DOB counts and is silent on an absent one. The decision — recorded in
   * `applicability.ts`'s header — is that a female patient of unknown age on a covered study type
   * is APPLICABLE: the form is the Act's default and the exemption is what must be established, and
   * the two errors are not symmetrical. A null in a nullable column is not evidence of age.
   */
  it("an ESTIMATED date of birth is read exactly as a documented one", () => {
    const v = pcpndtApplicability(
      { sex: "female", dob: dobForAge(30), dobEstimated: true }, covered, SCAN_DAY,
    );
    expect(v).toEqual({ applicable: true, reason: "within_band", ageYears: 30 });
  });

  it("an ABSENT date of birth is APPLICABLE, and says so with its own reason", () => {
    const v = pcpndtApplicability({ sex: "female", dob: null }, covered, SCAN_DAY);
    expect(v).toEqual({ applicable: true, reason: "age_unknown", ageYears: null });
    // …and a male with no DOB is still not applicable: the sex leg decides first.
    expect(pcpndtApplicability({ sex: "male", dob: null }, covered, SCAN_DAY).applicable).toBe(false);
  });

  /**
   * `other` and `unknown` are not female. Opening a statutory form on every incomplete record is
   * how a control becomes noise the floor learns to route around — the data-quality fix belongs at
   * the counter, not here.
   */
  it("`other` and `unknown` are not female", () => {
    for (const sex of ["other", "unknown", "Female", "FEMALE", ""]) {
      expect([sex, pcpndtApplicability({ sex, dob: dobForAge(24) }, covered, SCAN_DAY).applicable])
        .toEqual([sex, false]);
    }
  });

  /**
   * A3's FIRST mutant, written as an assertion rather than as prose: the rule must read the
   * CLINICAL sex. A trans man recorded `administrative_gender: 'male'` with clinical `sex: 'female'`
   * is a person the Act covers, and a rule reading the legal marker leaves that scan unregistered.
   * The function's parameter type carries no `administrativeGender` field at all, which is the
   * strongest form of this assertion; this test pins the BEHAVIOUR the type enforces.
   */
  it("A3 mutant: the rule reads clinical `sex` — a female-sexed patient is covered whatever the legal marker says", () => {
    const facts = { sex: "female", dob: dobForAge(24) };
    expect(pcpndtApplicability(facts, covered, SCAN_DAY).applicable).toBe(true);
    // The shape a mutant would need in order to read the wrong column is not constructible:
    expect(Object.keys(facts)).not.toContain("administrativeGender");
  });
});
