/**
 * The drug as the registers name it (Schedule H1, Rule 65(3); the walk-in sale's H1 row): brand,
 * strength and form, else the doctor's words.
 *
 * WALK FINDING 2026-09-29 — "Azee 500 500 mg tablet". Indian brand names very often carry their
 * strength ("Azee 500", "Dolo 650", "Pan 40"), and the catalogue's `strength_label` repeats it. The
 * strength is left out when the brand already says it: its leading number is a whole number token in
 * the brand, or the brand contains the whole label once spaces are ignored. A strength the brand does
 * not say ("Crocin" + "500 mg", "Augmentin 625 Duo" + "500 mg + 125 mg") is kept.
 */
export function registerDrugName(med: { brandName: string; strengthLabel: string | null; form: string } | undefined, fallback: string): string {
  if (med === undefined) return fallback;
  const strength = med.strengthLabel?.trim() ?? "";
  return strength === "" || brandSaysStrength(med.brandName, strength) ? `${med.brandName} ${med.form}` : `${med.brandName} ${strength} ${med.form}`;
}

function brandSaysStrength(brand: string, strength: string): boolean {
  const squash = (s: string): string => s.toLowerCase().replace(/\s+/g, "");
  if (squash(brand).includes(squash(strength))) return true;
  const lead = /^(\d+(?:\.\d+)?)/.exec(strength)?.[1];
  if (lead === undefined || /[+/,]/.test(strength)) return false;
  return (brand.match(/\d+(?:\.\d+)?/g) ?? []).includes(lead);
}
