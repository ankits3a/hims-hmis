/**
 * "MY PACE" — a person's own average time per patient beside the anonymous average of their
 * department and of the hospital (owner, 2026-10-09: "I also want each doctor to see their
 * performance compared to other doctor's average. Let the doctor see average time per consultation
 * compared to average of the department and average to the hospital. Same goes to Vitals staff as
 * well."). Pure TypeScript with no imports, like `app-home.ts`: the server reads it for the floors
 * it enforces, and the phone (outside the pnpm workspace) reads it by path.
 *
 * It extends decision 0042's "start with their own numbers": an AVERAGE of a group may now stand
 * beside one's own number. Never another person's name, id or figure — the wire shape below has
 * no field that could hold one, and a group line is withheld (`enough: false`) whenever it could be
 * read back into one colleague.
 */

export const PACE_PERIODS = ["today", "7d", "30d"] as const;
export type PacePeriod = (typeof PACE_PERIODS)[number];
export const PACE_DEFAULT_PERIOD: PacePeriod = "30d";
/** How many IST days a period covers, today included. */
export const PACE_PERIOD_DAYS: Readonly<Record<PacePeriod, number>> = { today: 1, "7d": 7, "30d": 30 };

/**
 * A single duration outside these two bounds is a data-entry artefact, not a consultation: a visit
 * opened and closed in one tap, or one left open over lunch. Dropped from every figure and counted.
 */
export const PACE_MIN_MINUTES = 1;
export const PACE_MAX_MINUTES = 90;

/** One's own number is shown only over at least this many qualifying items in the period. */
export const PACE_OWN_FLOOR = 10;
/** A group average is shown only over at least this many DISTINCT people … */
export const PACE_GROUP_PEOPLE_FLOOR = 3;
/** … AND at least this many items — so no average ever reveals one colleague. */
export const PACE_GROUP_ITEMS_FLOOR = 30;

/** The caller's own figures. `n` is their own count, so it is theirs to read at any size. */
export type PaceOwn = { enough: boolean; meanMin: number | null; medianMin: number | null; n: number };
/**
 * A group's figures: a mean, a median and whether the floors were met — nothing else. No headcount,
 * no item count (either would let own + group be solved for a colleague), no id, no name.
 */
export type PaceGroup = { enough: boolean; meanMin: number | null; medianMin: number | null };
/** What was left out of the caller's OWN figure, so the screen can say so. */
export type PaceExcluded = { paper: number; abandoned: number; outOfBounds: number };

export type PaceBlock = {
  own: PaceOwn;
  /** Null where the measure has no department split. */
  department: PaceGroup | null;
  /** Everybody the measure covers: the hospital's doctors, or the one vitals bay. */
  all: PaceGroup;
  excluded: PaceExcluded;
};

export type MyPace = {
  period: PacePeriod; from: string; to: string;
  /** Minutes from a consultation's start to its completion on a screen. Null: the caller is no doctor. */
  consultation: PaceBlock | null;
  /**
   * Minutes from taking a patient in hand at the vitals bay to saving the chart. ALWAYS NULL TODAY:
   * the moment a patient is taken in hand is not stored anywhere, and it is not invented from the
   * gaps between saves.
   */
  vitals: PaceBlock | null;
};

/** Minutes as a person reads them: whole, never below 1. */
export function paceWholeMinutes(meanMin: number): number {
  return Math.max(1, Math.round(meanMin));
}

/** Each shown figure's share (0–1) of ONE shared scale — the largest shown figure fills the bar. */
export function paceShares(values: readonly (number | null)[]): (number | null)[] {
  const top = Math.max(0, ...values.filter((v): v is number => v !== null));
  return values.map((v) => (v === null || top <= 0 ? null : Math.max(0.04, Math.min(1, v / top))));
}
