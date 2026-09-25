/**
 * The ophthal line (board "Ophthal", 2026-09-23): "an eye line has an eye and a taper".
 *
 * The vocabulary is defined ONCE for the server in `@hmis/contracts` (rx-eye.ts). The web imports
 * only TYPES from that package — its runtime entry is the built `dist/`, which the web build does
 * not produce — so the few values below are a copy, and `eye-line.test.ts` holds them equal to the
 * contracts source character for character. A drift fails that test, not a prescription.
 */
import type { Eye, TaperStep } from "@hmis/contracts";

export type { Eye, TaperStep } from "@hmis/contracts";

export const EYES: readonly Eye[] = ["od", "os", "ou"];
/** English on purpose: it is what the label and the e-Rx print, and the pharmacist matches them. */
export const EYE_TEXT: Record<Eye, string> = { od: "RIGHT EYE", os: "LEFT EYE", ou: "BOTH EYES" };
export const TAPER_MIN_STEPS = 2;
export const TAPER_MAX_STEPS = 8;
export const TAPER_MAX_TIMES = 12;
export const TAPER_MAX_DAYS = 60;

export function taperText(steps: readonly TaperStep[]): string {
  return `Taper: ${steps.map((step) => `${String(step.timesPerDay)}×/day × ${String(step.days)}d`).join(" → ")}`;
}

export function taperDays(steps: readonly TaperStep[]): number {
  return steps.reduce((sum, s) => sum + s.days, 0);
}

/** The one preset the board draws: the steroid taper, 6-4-3-2-1 a day, a week at each. */
export const TAPER_PRESET: readonly TaperStep[] = [6, 4, 3, 2, 1].map((n) => ({ timesPerDay: n, days: 7 }));


export function eyeTextOf(eye: Eye | null | undefined): string | null {
  return eye === undefined || eye === null ? null : EYE_TEXT[eye];
}
