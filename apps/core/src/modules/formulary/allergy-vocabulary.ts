import { FormularyError } from "./errors";
import { normalizeDrugName } from "./resolve";

/**
 * ═══ FORMULARY P22 — THE ALLERGY CLASSES THE PRESCRIBING CHECK KNOWS ═══
 *
 * Phase doc `docs/superpowers/plans/2026-09-17-phase-formulary-p22-allergy-classes.md`.
 *
 * The owner's clinical master (`allergy_cross_reactivity_rules`) names six allergen classes (a seventh,
 * cephalosporins, is the hospital's own). The doctor's allergen picker (`cds/allergens.ts`) records
 * one of the six by its bundle name, as both the substance and `allergenClass`. The prescribing check compared the TEXT with a moiety's
 * `drug_class`. Neither the bundle name nor any of those six classes was a `drug_class` of a real
 * moiety, so a picked "Penicillins / Beta-Lactams" never raised the hard warning on amoxicillin.
 *
 * This file is the mapping the handoff asked for: each class has one KEY, which is what a moiety
 * carries in `allergy_classes`. It reaches that key in two ways:
 *   - the picker's class name (`bundleClass`);
 *   - the whole typed allergy text, when it IS the class ("Sulpha drugs", "NSAIDs"). Normalised as
 *     every other drug text is, and compared whole. A phrase that merely contains a class word is
 *     not guessed at (`patients/allergies.ts`: the picker exists to make that judgement explicit).
 *
 * The memberships themselves are data, adopted by resolution: `scripts/data/allergy-classes-*.ts`.
 */
export const ALLERGY_CLASSES = {
  penicillin: {
    bundleClass: "Penicillins / Beta-Lactams",
    words: ["penicillin", "penicillins", "beta lactam", "beta lactams", "betalactam", "betalactams", "penicillin allergy"],
  },
  sulfonamide_antibiotic: {
    bundleClass: "Sulfonamides (Sulfa)",
    words: ["sulfa", "sulpha", "sulfa drugs", "sulpha drugs", "sulfonamide", "sulfonamides", "sulphonamide", "sulphonamides"],
  },
  nsaid: {
    bundleClass: "NSAIDs / Aspirin (AERD)",
    words: ["nsaid", "nsaids", "aerd", "painkillers nsaids"],
  },
  opioid_morphinan: {
    bundleClass: "Opioids",
    words: ["opioid", "opioids", "opiate", "opiates"],
  },
  ester_local_anaesthetic: {
    bundleClass: "Ester Local Anesthetics",
    words: ["ester local anaesthetic", "ester local anaesthetics", "ester local anesthetic", "ester local anesthetics"],
  },
  statin: {
    bundleClass: "Statins",
    words: ["statin", "statins"],
  },
  /**
   * The hospital's own class, not the clinical master's: every Indian hospital allergy list carries
   * "Cephalosporins", and a doctor types it. The picker does not offer it (it offers the bundle's six).
   */
  cephalosporin: {
    bundleClass: null,
    words: ["cephalosporin", "cephalosporins"],
  },
} as const satisfies Record<string, { bundleClass: string | null; words: readonly string[] }>;

export type AllergyClassKey = keyof typeof ALLERGY_CLASSES;

export function isAllergyClassKey(key: string): key is AllergyClassKey {
  return Object.prototype.hasOwnProperty.call(ALLERGY_CLASSES, key);
}

/**
 * The class keys an allergy record names: its picked class, or its whole text. Pure; the check calls
 * it per allergy. Empty for an allergy that names no class (most of them name a drug).
 */
export function allergyClassKeys(substance: string, allergenClass: string | null | undefined): AllergyClassKey[] {
  const text = normalizeDrugName(substance);
  const picked = allergenClass == null ? "" : normalizeDrugName(allergenClass);
  const out: AllergyClassKey[] = [];
  for (const [key, c] of Object.entries(ALLERGY_CLASSES) as [AllergyClassKey, (typeof ALLERGY_CLASSES)[AllergyClassKey]][]) {
    const bundle = c.bundleClass === null ? "" : normalizeDrugName(c.bundleClass);
    const names = [bundle, normalizeDrugName(key), ...c.words.map(normalizeDrugName)].filter((n) => n !== "");
    if ((picked !== "" && picked === bundle) || (text !== "" && names.includes(text))) out.push(key);
  }
  return out;
}

/** Refuses a class the check does not know, so a curator's typo cannot record a class nothing reads. */
export function requireAllergyClasses(keys: readonly string[]): string[] {
  const clean = [...new Set(keys.map((k) => k.trim()))];
  const unknown = clean.filter((k) => !isAllergyClassKey(k));
  if (unknown.length > 0) {
    throw new FormularyError("invalid_allergy_class", `unknown allergy class ${unknown.join(", ")} — the check knows ${Object.keys(ALLERGY_CLASSES).join(", ")}`);
  }
  return clean.sort();
}
