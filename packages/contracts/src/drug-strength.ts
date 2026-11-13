/**
 * ═══ A STRENGTH AS A PERSON READS IT (walk 2026-11-13) ═══
 *
 * The drug catalogue stores many strengths with an empty denominator: `500 mg/` is how 70,980 rows arrive, a
 * per-unit the source bundle never filled in. The counter, the desk, the bill and the label printed "500 mg/".
 * Only that empty denominator is dropped; a real one (`250 mg/5 ml`) is kept, and the stored value is untouched.
 *
 * Shared by the server (paper prescription, label, register name) and the screens (the web reads it from source).
 * No imports.
 */
export function strengthShown(label: string | null | undefined): string | null {
  if (label === null || label === undefined) return null;
  const shown = label.replace(/\/\s*$/, "").trim();
  return shown === "" ? null : shown;
}
