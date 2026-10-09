/**
 * ═══ HOW LONG PATIENTS WAIT — EVERY THRESHOLD IN ONE FILE (owner 2026-10-09) ═══
 *
 * The wait report (`flow.ts`) and the nightly learning (`flow-learning.ts`) read their limits from here
 * and nowhere else, so a number the owner questions is changed in one place and the tests that pin it
 * go red in one place.
 */

/** A wait over this many minutes (eight hours) is a clock or a data slip, not a wait. Dropped and counted. */
export const FLOW_MAX_WAIT_MIN = 480;

/** The learning looks back this many days for each department's own usual numbers. */
export const BASELINE_DAYS = 28;

/** bay_peak — the vitals bay is slow in a two-hour window on one weekday, week after week. */
export const BAY_PEAK_RATIO = 1.5;
export const BAY_PEAK_HIT_DAYS = 3;
export const BAY_PEAK_LOOK_DAYS = 4;
export const BAY_PEAK_MIN_N = 8;
/** A same-weekday day counts as "slow" only with at least this many visits in the window. */
export const BAY_PEAK_DAY_MIN_N = 2;
/** The windows: 08–10, 10–12, … 18–20 IST — fixed, so a finding's key is the same from night to night. */
export const BAY_WINDOW_HOURS = 2;
export const BAY_WINDOW_STARTS: readonly number[] = [8, 10, 12, 14, 16, 18];

/** doctor_start_late — vitals → doctor is long in a department's first hour of the day, week after week. */
export const START_LATE_RATIO = 1.5;
export const START_LATE_HIT_DAYS = 3;
export const START_LATE_LOOK_DAYS = 4;
export const START_LATE_MIN_N = 8;
export const START_LATE_DAY_MIN_N = 2;
/** "The first hour": from the department's first vitals save of the day, this many minutes. */
export const START_LATE_WINDOW_MIN = 60;

/** dept_outlier — a department's vitals → doctor median against the hospital's, over 28 days. */
export const DEPT_OUTLIER_RATIO = 1.5;
export const DEPT_OUTLIER_MIN_N = 30;

/** week_regression — this week's desk → doctor median against the four weeks before it. */
export const WEEK_REGRESSION_RATIO = 1.25;
export const WEEK_REGRESSION_MIN_N = 30;
export const WEEK_DAYS = 7;
export const WEEK_REGRESSION_BASE_DAYS = 28;

/** improved — an open finding whose numbers sit within 1.1× its baseline for two weeks is resolved. */
export const RESOLVE_RATIO = 1.1;
export const RESOLVE_DAYS = 14;

/** × — a dismissed finding stays quiet this many days, and comes back early only at 20 % worse. */
export const DISMISS_QUIET_DAYS = 28;
export const DISMISS_RETURN_RATIO = 1.2;

/** "Fixed" lists findings resolved in the last this-many days. */
export const FIXED_SHOWN_DAYS = 90;
