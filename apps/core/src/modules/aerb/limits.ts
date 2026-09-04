/**
 * PLAN 18c T4 / D10 — **THE STATUTORY OCCUPATIONAL DOSE LIMITS, AS CODE CONSTANTS.**
 *
 * Atomic Energy (Radiation Protection) Rules 2004, following ICRP: for a radiation worker, the
 * effective dose limit is **20 mSv per year averaged over five consecutive years**, with **no more
 * than 30 mSv in any single year** and **100 mSv over the five**. The equivalent-dose limits for
 * the lens of the eye and for skin/extremities are separate and far higher; this phase records
 * Hp(0.07) but compares nothing against those, and a phase that starts to must say so.
 *
 * ═══ WHY THESE ARE CONSTANTS AND THE INVESTIGATION LEVEL IS NOT ═══
 *
 * These are LAW. A hospital that could type its own annual dose limit into a settings screen would
 * be a hospital whose register proves nothing to an inspector — the number would be whatever the
 * last person to touch the screen believed. The **investigation level** is the opposite: it is the
 * institution's own trigger for asking questions, it is set below the limit on purpose, and a
 * hospital choosing a more conservative one must not need a deploy. That one lives in
 * `aerb_settings` (D10).
 *
 * Nothing in this phase BLOCKS on any of these. A dose over a limit is a finding an RSO
 * investigates and a regulator is told about; a system that locked a radiographer out of the
 * roster on the strength of a laboratory report that arrived six weeks late would be making a
 * duty-roster decision (Plan 20's) out of a register entry.
 */

/** mSv. The single-year ceiling — Rule 2004, ICRP 103. */
export const ANNUAL_LIMIT_MSV = 30;

/** mSv per year, averaged over five consecutive years. */
export const FIVE_YEAR_AVERAGE_LIMIT_MSV = 20;

/** mSv. The five-year total the average implies, stated so nothing multiplies it at a call site. */
export const FIVE_YEAR_TOTAL_LIMIT_MSV = 100;

/**
 * The mean length of a Gregorian month in days, for pro-rating a monthly investigation level onto a
 * wearing period of any length. A quarterly badge is not exactly three months and a period that
 * slipped by a fortnight is not four; dividing by a constant here is what keeps the comparison
 * honest for both without asking a laboratory to align its calendar to ours.
 */
export const DAYS_PER_MONTH = 30.436875;

/** The default the settings row ships with (D10). mSv per month; R3 is the owner's to lower. */
export const DEFAULT_INVESTIGATION_LEVEL_MSV_PER_MONTH = 1;

/** The investigation level for a wearing period, pro-rated from the monthly figure. */
export function investigationLevelFor(
  perMonthMsv: number, periodStart: string, periodEnd: string,
): number {
  const start = Date.parse(`${periodStart}T00:00:00Z`);
  const end = Date.parse(`${periodEnd}T00:00:00Z`);
  /** Inclusive of both endpoints: a badge worn 1–31 January was worn for 31 days, not 30. */
  const days = (end - start) / 86_400_000 + 1;
  return (perMonthMsv * days) / DAYS_PER_MONTH;
}
