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
  const years = at.getUTCFullYear() - dob.getUTCFullYear();
  const notYet =
    at.getUTCMonth() < dob.getUTCMonth() ||
    (at.getUTCMonth() === dob.getUTCMonth() && at.getUTCDate() < dob.getUTCDate());
  return notYet ? years - 1 : years;
}
