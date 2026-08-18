/**
 * Plan 08 — billing's IST / fiscal-year clock. Pure: no Intl, no process TZ, no clock read.
 * `istDay` is the OPD `istDate` arithmetic copied module-locally on purpose: cross-module
 * internals are not importable (spec §4 — only through a module's index.ts), and a fiscal
 * year is not an OPD concept. The duplication is deliberate and recorded here.
 */
export const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 86_400_000;

/** The IST calendar date of an instant, 'YYYY-MM-DD'. */
export function istDay(at: Date): string {
  return new Date(Math.floor((at.getTime() + IST_OFFSET_MS) / DAY_MS) * DAY_MS).toISOString().slice(0, 10);
}

/**
 * The Indian fiscal year (Apr 1 – Mar 31, IST) of an instant. The boundary is IST midnight,
 * never UTC midnight. `fyShort` is what document numbers carry: `INV/26-27/000001` is exactly
 * 16 characters, the GST serial ceiling (D5), which `bigserial` alone could never hold.
 */
export function fyOf(at: Date): { fy: string; fyShort: string } {
  const day = istDay(at);
  const year = Number(day.slice(0, 4));
  const month = Number(day.slice(5, 7));
  const start = month >= 4 ? year : year - 1;
  const end = String((start + 1) % 100).padStart(2, "0");
  return { fy: `${start}-${end}`, fyShort: `${String(start % 100).padStart(2, "0")}-${end}` };
}
