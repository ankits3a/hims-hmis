/**
 * WHICH DIAGNOSES ASK WHICH EYE (board "Ophthal", 2026-09-23: "each eye-code asks which eye").
 *
 * ICD-10 has no laterality — "H25.1 Senile nuclear cataract" is the same code for either eye — so
 * the eye is stored BESIDE the code (`opd_encounter_diagnoses.laterality`), and this is the one rule
 * that says when it means anything: chapter VII (H00–H59, the eye and adnexa) and diabetes with
 * ophthalmic complications (E10.3–E14.3, with or without a further digit). H60–H95 is the ear.
 *
 * ONE copy for the server; the web keeps a character-for-character copy held equal by
 * `apps/web/src/lib/eye-codes.test.ts`, for the reason `eye-line.ts` gives.
 */
const EYE_CHAPTER = /^H[0-5][0-9](?:\.?[0-9A-Z]*)$/;
const DIABETIC_EYE = /^E1[0-4]\.?3[0-9A-Z]*$/;

export function isEyeCode(icd10: string | null): boolean {
  if (icd10 === null) return false;
  const code = icd10.trim().toUpperCase();
  return EYE_CHAPTER.test(code) || DIABETIC_EYE.test(code);
}
