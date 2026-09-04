import { useEffect, useState } from "react";

/**
 * The shared render helpers of the billing screens (Plan 08 T13 — "the lift").
 *
 * THE LIFT IS ADDITIVE. `fmtIst` and `useDebounced` already exist as private copies inside
 * `screens/opd-desk.tsx`, `screens/opd-appointments.tsx`, `screens/opd-vitals.tsx`,
 * `screens/registration-desk.tsx`, `screens/merge-review.tsx` and `components/patient-picker.tsx`.
 * Every one of those files is FROZEN for this plan, so the copies STAY: this module is the shared
 * export the four billing screens use, and the residual duplication is recorded (plan self-review
 * 17), not silently left and not deleted. `fmtIst` below is TRANSCRIBED from `opd-desk.tsx:47` —
 * never imported from a frozen screen — and format.test.ts pins the behaviour it transcribes.
 */

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/**
 * Rupee integer part in INDIAN digit grouping: the last three digits, then pairs
 * (12,34,567 — not 1,234,567). `Intl.NumberFormat("en-IN")` would do this too, but the desk
 * machines' ICU data is not something this app gets to assume, and the arithmetic is four lines.
 */
function groupIndian(rupees: number): string {
  const digits = String(rupees);
  if (digits.length <= 3) return digits;
  const tail = digits.slice(-3);
  let head = digits.slice(0, -3);
  const groups: string[] = [];
  while (head.length > 2) {
    groups.unshift(head.slice(-2));
    head = head.slice(0, -2);
  }
  if (head !== "") groups.unshift(head);
  return `${groups.join(",")},${tail}`;
}

/**
 * THE money renderer. Input is integer paise — the only money representation that exists on the
 * wire (Global Constraint, plan line 134) — and the output is the rupee string a cashier reads.
 * Negative input renders signed (`-₹1,720.00`): the cashier session screen's variance is a real
 * negative number and printing it unsigned would be a lie.
 */
export function fmtPaise(paise: number): string {
  const negative = paise < 0;
  const abs = negative ? -paise : paise;
  const rupees = Math.trunc(abs / 100);
  const fraction = abs % 100;
  return `${negative ? "-" : ""}₹${groupIndian(rupees)}.${String(fraction).padStart(2, "0")}`;
}

/**
 * UTC instant → IST 'HH:MM'. Arithmetic, no Intl — IST is a fixed +05:30 with no DST, so this
 * never depends on the desk machine's timezone (which is routinely wrong on hospital hardware).
 * Transcribed from `opd-desk.tsx`'s private copy, character for character.
 */
export function fmtIst(iso: string): string {
  const shifted = new Date(new Date(iso).getTime() + IST_OFFSET_MS);
  return `${String(shifted.getUTCHours()).padStart(2, "0")}:${String(shifted.getUTCMinutes()).padStart(2, "0")}`;
}

/**
 * FD-11 — UTC instant → IST `MMM YYYY`, for "on file since".
 *
 * The same fixed +05:30 arithmetic as `fmtIst` and for the same reason: a hospital desk machine's
 * timezone is routinely wrong, and a record registered at 02:00 IST on the 1st must not read as the
 * previous month because the terminal thinks it is in UTC. Month precision is deliberate — a clerk
 * telling two records apart needs "2019 or this week", not a date they would have to read carefully.
 */
const MONTHS_EN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function monthYearIst(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const shifted = new Date(t + IST_OFFSET_MS);
  return `${MONTHS_EN[shifted.getUTCMonth()]!} ${String(shifted.getUTCFullYear())}`;
}

/**
 * FD-16 — an IST CALENDAR DATE (`YYYY-MM-DD`) → `DD Mon`, for the history rail and the day's book.
 *
 * NO TIMEZONE ARITHMETIC, and that is the whole point of it being a separate function from
 * `monthYearIst` above. `serviceDate` is already the IST calendar day the server decided; running
 * it through a UTC offset would shift it by a day near midnight and print the wrong date for the
 * one class of visit — a late-night arrival — where getting the day right matters most.
 */
export function dayMonthIst(serviceDate: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(serviceDate);
  if (m === null) return serviceDate;
  const month = MONTHS_EN[Number(m[2]) - 1] ?? "";
  return `${m[3]} ${month}`;
}

/** Transcribed from `patient-picker.tsx`'s private copy: the trailing value, `ms` after it settles. */
export function useDebounced(value: string, ms: number): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}
