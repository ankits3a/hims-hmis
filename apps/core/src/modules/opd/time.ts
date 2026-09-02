/** IST = UTC+05:30, fixed, no DST — the hospital clock. Pure: no Intl, no process TZ. */
export const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 86_400_000;

/** Whole IST days since the epoch — subtract two to count calendar days between instants. */
export function istDayIndex(at: Date): number {
  return Math.floor((at.getTime() + IST_OFFSET_MS) / DAY_MS);
}

/** The IST calendar date of an instant, 'YYYY-MM-DD'. */
export function istDate(at: Date): string {
  return new Date(istDayIndex(at) * DAY_MS).toISOString().slice(0, 10);
}

function parts(date: string): [number, number, number] {
  const [y, m, d] = date.split("-").map(Number);
  return [y!, m!, d!];
}

/** An IST wall-clock 'HH:MM' on an IST date → the UTC instant. */
export function istDateTimeToUtc(date: string, hhmm: string): Date {
  const [y, m, d] = parts(date);
  const [hh, mm] = hhmm.split(":").map(Number);
  return new Date(Date.UTC(y, m - 1, d, hh!, mm!) - IST_OFFSET_MS);
}

/** 0 = Sunday … 6 = Saturday for an IST calendar date. */
export function istWeekday(date: string): number {
  const [y, m, d] = parts(date);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function addDays(date: string, n: number): string {
  const [y, m, d] = parts(date);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** [start, end) UTC instants of the IST calendar month containing `at`. */
export function istMonthBounds(at: Date): { start: Date; end: Date } {
  const [y, m] = parts(istDate(at));
  return {
    start: new Date(Date.UTC(y, m - 1, 1) - IST_OFFSET_MS),
    end: new Date(Date.UTC(y, m, 1) - IST_OFFSET_MS),
  };
}

/** Whole years between dob and `at`, UTC, anniversary-aware (mirrors patients/types.ts yearsBetween, which is module-private). */
export function ageYearsAt(dob: Date, at: Date): number {
  // VD-2 T0 (review MINOR) — the birthday is an IST calendar day: a child who turns 13 today is 13
  // from midnight IST, not from 05:30. `dob` is a calendar date stored at UTC midnight; `at` is
  // an instant, shifted into the hospital's clock before its date is read.
  const ist = new Date(at.getTime() + IST_OFFSET_MS);
  const years = ist.getUTCFullYear() - dob.getUTCFullYear();
  const notYet =
    ist.getUTCMonth() < dob.getUTCMonth() ||
    (ist.getUTCMonth() === dob.getUTCMonth() && ist.getUTCDate() < dob.getUTCDate());
  return notYet ? years - 1 : years;
}

/**
 * PLAN 07c T2 — 'HH:MM' on the hospital's clock, for a report cut on the IST day.
 *
 * It lives HERE rather than in the caller because `test/ist-clock-parity.test.ts` pins the census of
 * files that write the offset out by hand, and it goes red on a new one — which is the guard doing
 * its job (ledger §2.105: one expression, plus a test that reddens when the copies disagree). The
 * desk provider that needed this had written an eleventh copy; this is where the tenth already was.
 */
export function istHourMinute(at: Date): string {
  return new Date(at.getTime() + IST_OFFSET_MS).toISOString().slice(11, 16);
}
