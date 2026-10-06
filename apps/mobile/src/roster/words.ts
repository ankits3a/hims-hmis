import { dutyWhatKey, istMinutes } from "./rules";
import type { WireCoverReason, WireCoverRefusal, WireDutyRef } from "./rules";

/**
 * Days, months and clock times for the roster's screens, in IST by fixed arithmetic and in the
 * reader's language from the app's own locale files. Deliberately NOT `Intl`: what a phone's engine
 * knows about `hi-IN` weekday names varies by build, and a board that says "Sun" on one phone and
 * "रवि" on the next is two boards.
 */
type T = (key: string, vars?: Record<string, string | number>) => string;

const IST_OFFSET_MS = 330 * 60_000;
const pad = (n: number): string => String(n).padStart(2, "0");

/** "16:39" in IST. */
export function hm(iso: string): string {
  const m = istMinutes(iso);
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
}

/** IST calendar parts of an instant. */
function partsOf(iso: string): { dow: number; day: number; month: number } {
  const d = new Date(Date.parse(iso) + IST_OFFSET_MS);
  return { dow: d.getUTCDay(), day: d.getUTCDate(), month: d.getUTCMonth() + 1 };
}
/** Calendar parts of an IST date (`YYYY-MM-DD`). */
function partsOfDate(istDate: string): { dow: number; day: number; month: number } {
  const d = new Date(`${istDate}T12:00:00Z`);
  return { dow: d.getUTCDay(), day: d.getUTCDate(), month: d.getUTCMonth() + 1 };
}

export const weekdayLong = (iso: string, t: T): string => t(`mobile.roster.day.long.${partsOf(iso).dow}`);
export const weekdayShort = (iso: string, t: T): string => t(`mobile.roster.day.short.${partsOf(iso).dow}`);
/** "Sunday 4 October, 16:39" — the board's clock line. */
export function clockLine(iso: string, t: T): string {
  const p = partsOf(iso);
  return `${t(`mobile.roster.day.long.${p.dow}`)} ${p.day} ${t(`mobile.roster.month.long.${p.month}`)}, ${hm(iso)}`;
}
/** "Sun 4 Oct, 16:39" — when a hole opens, when a flag was raised. */
export function shortWhen(iso: string, t: T): string {
  const p = partsOf(iso);
  return `${t(`mobile.roster.day.short.${p.dow}`)} ${p.day} ${t(`mobile.roster.month.short.${p.month}`)}, ${hm(iso)}`;
}
/** "Sun 4 Oct" */
export function shortDay(iso: string, t: T): string {
  const p = partsOf(iso);
  return `${t(`mobile.roster.day.short.${p.dow}`)} ${p.day} ${t(`mobile.roster.month.short.${p.month}`)}`;
}

/** "WED" — the board's three-letter day, of an IST date. */
export const dowShort = (istDate: string, t: T): string => t(`mobile.roster.day.short.${partsOfDate(istDate).dow}`).toUpperCase();
/** "Saturday" */
export const dowLong = (istDate: string, t: T): string => t(`mobile.roster.day.long.${partsOfDate(istDate).dow}`);
/** "Saturday 10 Oct" */
export function dayLong(istDate: string, t: T): string {
  const p = partsOfDate(istDate);
  return `${t(`mobile.roster.day.long.${p.dow}`)} ${p.day} ${t(`mobile.roster.month.short.${p.month}`)}`;
}
export const dateOfMonth = (istDate: string): number => partsOfDate(istDate).day;

/** A key's sentence, or null when the locale has none for it. */
export function said(t: T, key: string, vars?: Record<string, string | number>): string | null {
  const text = t(key, vars);
  return text === key ? null : text;
}

/** A key's sentence, or the fallback key's when the first has none (the web's `defaultValue`). */
export function tf(t: T, key: string, fallback: string, vars?: Record<string, string | number>): string {
  const said = t(key, vars);
  return said === key ? t(fallback, vars) : said;
}

export const hoursOf = (d: { startsAt: string; endsAt: string }, t: T): string => t("rosterMyDuties.hours", { from: hm(d.startsAt), to: hm(d.endsAt) });

/** What a duty IS, in one or two words: "Ward night", "OPD", "Theatre", "Take · 24 hours". */
export function dutyWhat(d: WireDutyRef & { activities?: string[] }, t: T): string {
  const what = dutyWhatKey(d);
  return what.fallback === undefined ? t(what.key) : tf(t, what.key, what.fallback);
}
/** "Saturday night" / "Saturday's duty" — how a request names the duty, as the board does. */
export function dutyName(d: WireDutyRef, t: T): string {
  return t(d.night ? "rosterMyDuties.dutyNight" : "rosterMyDuties.dutyDay", { day: dowLong(d.istDate, t) });
}
export function reasonText(r: Pick<WireCoverReason, "ruleKey">, t: T): string {
  const key = `rosterMyDuties.why.${r.ruleKey}`;
  const said = t(key);
  return said === key ? t("rosterMyDuties.why.other", { rule: r.ruleKey }) : said;
}
/** Why a person cannot take a duty — "Has Sunday night. This would be a second night in three." */
export function whyNot(r: Pick<WireCoverRefusal, "reason" | "near">, t: T): string {
  const why = reasonText(r.reason, t);
  if (r.near === null || r.reason.ruleKey === "unavailable") return why;
  return `${t(r.near.night ? "rosterMyDuties.nearNight" : "rosterMyDuties.nearDay", { day: dowLong(r.near.istDate, t) })} ${why}`;
}
/** A grade as the Doctor Desk header writes it ("Asst. Prof"), or the raw key when it has no word. */
export const gradeWord = (grade: string, t: T): string => {
  const key = `doctorDesk.grade.${grade}`;
  const said = t(key);
  return said === key ? grade : said;
};
