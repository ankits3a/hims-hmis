/**
 * THE EYE LINE's shared vocabulary (board "Ophthal", 2026-09-23: "an eye line has an eye and a taper").
 *
 * ONE copy, imported by both sides: the server stores `taperText(steps)` as a tapered line's
 * `frequency` at issue, and the consult card shows the same words before the doctor issues it. Two
 * hand-kept copies would drift, and then the card and the print would disagree.
 */
export type Eye = "od" | "os" | "ou";
export type TaperStep = { timesPerDay: number; days: number };

export const EYES: readonly Eye[] = ["od", "os", "ou"];

/** The words for an eye wherever a line is rendered as words — the print, the label, the sig. */
export const EYE_TEXT: Record<Eye, string> = { od: "RIGHT EYE", os: "LEFT EYE", ou: "BOTH EYES" };

/** The route's bounds (`rxLineBody`), shared so the step editor cannot offer what the server refuses. */
export const TAPER_MIN_STEPS = 2;
export const TAPER_MAX_STEPS = 8;
export const TAPER_MAX_TIMES = 12;
export const TAPER_MAX_DAYS = 60;

/** "Taper: 6×/day × 7d → 4×/day × 7d" — THE one wording of a taper. */
export function taperText(steps: readonly TaperStep[]): string {
  return `Taper: ${steps.map((step) => `${String(step.timesPerDay)}×/day × ${String(step.days)}d`).join(" → ")}`;
}

export function taperDays(steps: readonly TaperStep[]): number {
  return steps.reduce((sum, s) => sum + s.days, 0);
}
