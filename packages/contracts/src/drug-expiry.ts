/**
 * ═══ A MEDICINE EXPIRES IN A MONTH, NOT ON A DAY ═══
 *
 * An Indian drug label prints its expiry as MM/YYYY and means the LAST day of that month. The opening-stock
 * sheet has always stored it so; the GRN's date picker sent whatever day was picked, so one batch arrived as
 * two expiries and the second delivery was refused as `batch_mismatch` (2026-11-13). This file is the ONE
 * statement of the rule: the opening sheet (`pharmacy/opening-stock.ts`), the GRN gate (`materials/grn.ts`)
 * and the GRN screen (`materials-grn.tsx`) all read it, so they cannot disagree about a month's last day.
 *
 * Pure calendar arithmetic on `YYYY-MM-DD` strings — the hospital's (IST) calendar dates — with no instant,
 * no process time zone and no clock. No imports: the screens read this file directly.
 */

/** The last day of `month` (1–12) of `year`, `YYYY-MM-DD`. */
function lastDayOf(year: number, month: number): string {
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${String(year)}-${String(month).padStart(2, "0")}-${String(last).padStart(2, "0")}`;
}

/**
 * The forms a person may type a label's month in, for the words a refusal uses: `08/28`, `0828`, `08/2028`.
 * Every one of them, and `8/28` and `082028`, is the same month.
 */
export const EXPIRY_LABEL_FORMS = "08/28, 0828 or 08/2028";

/**
 * The label's `MM/YYYY` or `MM/YY` (a dash also separates) → the last day of that month; null when unreadable.
 * Walk 2026-11-13: a phone's number pad has no "/", so the month is also read typed without it — `MMYY` (four
 * digits) or `MMYYYY` (six). Three or five digits are refused rather than guessed at; month 0 or 13 is no month.
 */
export function expiryFromLabel(text: string): string | null {
  const m = /^\s*(\d{1,2})\s*[/-]\s*(\d{2}|\d{4})\s*$/.exec(text) ?? /^\s*(\d{2})(\d{2}|\d{4})\s*$/.exec(text);
  if (m === null) return null;
  const month = Number(m[1]);
  const year = m[2]!.length === 2 ? 2000 + Number(m[2]) : Number(m[2]);
  if (month < 1 || month > 12) return null;
  return lastDayOf(year, month);
}

/** Any day `YYYY-MM-DD` → the last day of its month; null when it is not such a date. */
export function monthEndOf(isoDate: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (m === null) return null;
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  return lastDayOf(Number(m[1]), month);
}

/** Two expiries are the same expiry when they name the same year and month (both absent counts as the same). */
export function sameExpiryMonth(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  return a.slice(0, 7) === b.slice(0, 7);
}
