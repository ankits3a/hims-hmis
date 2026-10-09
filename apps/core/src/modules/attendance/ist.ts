/**
 * IST DATES AS STRINGS. bioattend speaks `YYYY-MM-DD` and `HH:MM` in Asia/Kolkata with no offset, and
 * so does every table and route of this module. The only `Date` in here is the instant "now", turned
 * into an IST calendar date ONCE; every later step is calendar arithmetic on the string (through
 * UTC-midnight, which has no daylight saving and cannot slide a day).
 */
const IST_OFFSET_MS = 330 * 60_000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function istDate(now: Date): string {
  return new Date(now.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** `HH:MM` on the IST wall clock. */
export function istTime(now: Date): string {
  return new Date(now.getTime() + IST_OFFSET_MS).toISOString().slice(11, 16);
}

export function isIsoDate(s: string): boolean {
  if (!ISO_DATE.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === s;
}

export function addDays(date: string, n: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

/** Inclusive day count: `daysBetween(d, d) === 1`. */
export function daysInclusive(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
}

export function monthStart(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

/** The first and last day of the month before `date`'s. */
export function previousMonth(date: string): { from: string; to: string } {
  const to = addDays(monthStart(date), -1);
  return { from: monthStart(to), to };
}

/** `from…to` cut into inclusive pieces of at most `max` days (bioattend allows 62 per ranged call). */
export function chunkRange(from: string, to: string, max: number): { from: string; to: string }[] {
  const out: { from: string; to: string }[] = [];
  let at = from;
  while (at <= to) {
    const end = addDays(at, max - 1);
    out.push({ from: at, to: end < to ? end : to });
    at = addDays(end, 1);
  }
  return out;
}
