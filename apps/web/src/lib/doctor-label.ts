/**
 * 2026-10-04 (owner) — WHAT A STAFF OPD SCREEN SAYS BESIDE A DOCTOR'S NAME.
 *
 * "Dr. Chandan · Unit I", "Dr. S.I Raza · Guest Faculty", "Dr. Yash Vardhan · Unit I · Sr. Resident".
 * The unit (from the roster, that day's membership) comes first because that is what the owner asked
 * to see; the designation follows, shortened so a row stays one quiet line. A doctor in no unit and
 * with no designation gets nothing: the name alone.
 */
const SHORT: readonly [RegExp, string][] = [
  [/\bAssistant Professor\b/gi, "Asst. Prof."],
  [/\bAssociate Professor\b/gi, "Assoc. Prof."],
  [/\bDeputy Superintendent\b/gi, "Dy. Supdt."],
  [/\bMedical Superintendent\b/gi, "MS"],
  [/\bSenior Resident\b/gi, "Sr. Resident"],
  [/\bJunior Resident\b/gi, "Jr. Resident"],
];

export function shortDesignation(designation: string | null | undefined): string | null {
  const d = designation?.trim() ?? "";
  if (d === "") return null;
  return SHORT.reduce((s, [re, to]) => s.replace(re, to), d);
}

export function besideName(opts: { unit?: string | null; designation?: string | null }): string | null {
  const parts = [opts.unit ?? null, shortDesignation(opts.designation)].filter((x): x is string => x !== null && x !== "");
  return parts.length === 0 ? null : parts.join(" · ");
}
