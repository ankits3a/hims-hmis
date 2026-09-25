/**
 * Which diagnoses ask which eye — the web's copy of `@hmis/contracts` eye-codes.ts (the web imports
 * only TYPES from that package; see eye-line.ts). `eye-codes.test.ts` runs both copies over the same
 * codes, so a drift fails that test rather than hiding the eye pills from a cataract.
 */
const EYE_CHAPTER = /^H[0-5][0-9](?:\.?[0-9A-Z]*)$/;
const DIABETIC_EYE = /^E1[0-4]\.?3[0-9A-Z]*$/;

export function isEyeCode(icd10: string | null): boolean {
  if (icd10 === null) return false;
  const code = icd10.trim().toUpperCase();
  return EYE_CHAPTER.test(code) || DIABETIC_EYE.test(code);
}
