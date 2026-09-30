/**
 * PLAN 18-S RS3 — the desk's clock arithmetic, in IST whatever the terminal thinks its zone is
 * (`format.ts`'s reason: hospital hardware's timezone is routinely wrong).
 *
 * The booking box is an `<input type="datetime-local">`, whose value carries no zone. 18a's desk
 * appended `Z` to it, so a receptionist who typed 10:00 booked 15:30 IST. The desk types IST, so
 * the value is read as IST here, and nowhere else.
 */
const IST_OFFSET_MS = 330 * 60_000;

/** `2026-09-29T10:00` (typed at the desk, IST) → the ISO instant the server stores. */
export function istInputToIso(value: string): string {
  return new Date(`${value}:00+05:30`).toISOString();
}

/** An instant → the `YYYY-MM-DDTHH:mm` an IST `datetime-local` box shows. */
export function isoToIstInput(iso: string): string {
  return new Date(new Date(iso).getTime() + IST_OFFSET_MS).toISOString().slice(0, 16);
}

/** The IST calendar day of an instant, `YYYY-MM-DD`. */
export function istDay(at: string | number | Date): string {
  return new Date(new Date(at).getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** The next quarter hour from `now`, as the IST box value — the desk's default slot. */
export function nextQuarterIstInput(now: number): string {
  const q = 15 * 60_000;
  return isoToIstInput(new Date(Math.ceil(now / q) * q).toISOString());
}

/** Minutes between two instants, floored — the clocks read "34 min". */
export function minutesSince(iso: string, now: number): number {
  return Math.floor((now - new Date(iso).getTime()) / 60_000);
}
