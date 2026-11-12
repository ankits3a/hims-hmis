/**
 * OWNER 2026-11-12 — A TEST FOR ONE SEX IS NOT OFFERED TO THE OTHER ("why is the pregnancy related test allowed
 * in male gender?"). The catalogue marks an analyte female-only or male-only (`lab_analytes.applies_to_sex`); a
 * TEST is for one sex when every one of its parameters is (the urine pregnancy test, PSA). The server refuses such
 * a test for a patient recorded as the other sex, and every test picker hides it.
 *
 * A patient recorded as `other` or `unknown` is never refused: the counter's default is `unknown`, and the full
 * bench's rule (`applicabilityBreach`) makes the same choice.
 *
 * No imports: the phone app reads this file too.
 */
export type TestSex = "male" | "female";

/** One test that is for one sex only — `GET /ordering/sex-specific-tests`. */
export type SexSpecificTest = { serviceId: string; code: string; forSex: TestSex };

/** True when a test meant for `forSex` must not be offered to or done for a patient recorded as `patientSex`. */
export function wrongSex(forSex: TestSex | null | undefined, patientSex: string | null | undefined): boolean {
  if (forSex !== "male" && forSex !== "female") return false;
  return (patientSex === "male" || patientSex === "female") && patientSex !== forSex;
}

/** The sentence a refusal shows. */
export function wrongSexText(code: string, forSex: TestSex, patientSex: string): string {
  return `${code} is only for ${forSex} patients and this patient is recorded as ${patientSex} — check the patient`;
}
