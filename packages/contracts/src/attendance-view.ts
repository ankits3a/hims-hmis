/**
 * STAFF ATTENDANCE AS PEOPLE SEE IT — ONE SET OF RULES (owner, 2026-10-09; board "Attendance in the
 * app"). Pure TypeScript with no imports, like `app-home.ts`: the server reads it for the word it
 * sends a person about their own day, and the phone (outside the pnpm workspace) reads it by path
 * for the label, the colour and the calendar. So the two cannot disagree about what "Present" is.
 *
 *   · a person's OWN day is one word — Present, Absent, Leave, Off, Partial ("late days simply show
 *     as Present"), or Confirm for a past day with a single punch (`dayWord`, `selfWord`);
 *   · managers see the machine's own status: the same word, plus "Late" (`managerDay`);
 *   · green present, amber partial, red absent, blue leave, grey off (`WORD_TONE`);
 *   · weeks run Monday to Sunday, and nothing is drawn after today (`weekOf`, `monthGrid`).
 *
 * Dates are IST calendar strings (`YYYY-MM-DD`) throughout; the arithmetic is done at UTC midnight,
 * which has no daylight saving and cannot slide a day.
 */

/* ═══ the words ═══ */

/** Every status in bioattend's guide of 2026-10-09. A value outside it is passed through and reads "—". */
export const KNOWN_STATUSES = [
  "on_time", "late", "below_min_full", "below_min_half", "single_punch", "absent", "approved_leave", "holiday", "weekly_off",
  "worked_on_holiday", "worked_on_off_day", "on_call", "on_call_worked", "no_shift",
] as const;

export const DAY_WORDS = ["present", "absent", "leave", "off", "partial", "unknown"] as const;
export type DayWord = (typeof DAY_WORDS)[number];
/** What a person may see of their own day: a word, or `confirm`. */
export type SelfWord = DayWord | "confirm";
/** Why a day reads `confirm`. A fixed key, never free text; the set is open for later reasons. */
export const CONFIRM_REASONS = ["one_punch_only"] as const;
export type ConfirmReason = (typeof CONFIRM_REASONS)[number];

const WORD_OF: Readonly<Record<string, DayWord>> = {
  on_time: "present", late: "present", worked_on_holiday: "present", worked_on_off_day: "present", on_call_worked: "present",
  below_min_full: "partial", below_min_half: "partial", single_punch: "partial",
  absent: "absent",
  approved_leave: "leave",
  weekly_off: "off", holiday: "off", on_call: "off",
};

/**
 *   present   on_time, late, worked_on_holiday, worked_on_off_day, on_call_worked
 *   partial   below_min_full, below_min_half, single_punch
 *   absent    absent
 *   leave     approved_leave
 *   off       weekly_off, holiday, on_call
 *   no_shift  present when the day has any punch, else off
 *   anything bioattend adds later → `unknown` (the app prints "—")
 */
export function dayWord(status: string, hasPunch: boolean): DayWord {
  if (status === "no_shift") return hasPunch ? "present" : "off";
  return Object.prototype.hasOwnProperty.call(WORD_OF, status) ? WORD_OF[status]! : "unknown";
}

/** A day BEFORE today that the machine calls `single_punch` is `confirm` to its own person, with a fixed reason. */
export function selfWord(status: string, hasPunch: boolean, date: string, today: string): { status: SelfWord; reason?: ConfirmReason } {
  if (status === "single_punch" && date < today) return { status: "confirm", reason: "one_punch_only" };
  return { status: dayWord(status, hasPunch) };
}

export type AttendanceTone = "green" | "amber" | "red" | "blue" | "grey" | "warn" | "none";
/** Green present, amber partial, red absent, blue leave, grey off; Confirm is the amber WARNING; unknown has no colour. */
export const WORD_TONE: Readonly<Record<SelfWord, AttendanceTone>> = {
  present: "green", partial: "amber", absent: "red", leave: "blue", off: "grey", confirm: "warn", unknown: "none",
};
/** The locale key of a word (`attendance.word.present` …). An unknown word is drawn as "—" by the screen, not looked up. */
export function wordKey(word: SelfWord): string {
  return `attendance.word.${word}`;
}
export function reasonKey(reason: string): string {
  return (CONFIRM_REASONS as readonly string[]).includes(reason) ? `attendance.reason.${reason}` : "attendance.reason.other";
}

/** Today for its own person, by the COUNT of the day's punches (the guide says direction is unreliable). */
export type TodayState = "not_checked_in" | "checked_in" | "checked_out";
export const TODAY_TONE: Readonly<Record<TodayState, AttendanceTone>> = { not_checked_in: "grey", checked_in: "green", checked_out: "grey" };

/* ═══ what a manager sees ═══ */

export type ManagerDay = { word: DayWord; late: boolean; onePunch: boolean };
/** The machine's own status for those who may see it: the word, and the two tags a word would hide. */
export function managerDay(status: string, hasPunch: boolean): ManagerDay {
  return { word: dayWord(status, hasPunch), late: status === "late", onePunch: status === "single_punch" };
}

/** One person on a manager's "today" list, as the server sends it (`/attendance/today`, `/attendance/team/today`). */
export type TodayPerson = { status: string | null; firstIn: string | null; lastOut: string | null; onDuty: boolean };
export type TodayPlace = "in" | "not_in" | "leave" | "off";
/**
 * Where somebody is today. IN = the machine has a first-in for them (or lists them on duty). LEAVE
 * and OFF are the machine's words for a day nobody expects them. Everybody else is NOT IN — which
 * includes a day with no row yet, because the list is of who has not come.
 */
export function todayPlace(p: TodayPerson): TodayPlace {
  if (p.firstIn !== null || p.onDuty) return "in";
  if (p.status === "approved_leave") return "leave";
  if (p.status === "weekly_off" || p.status === "holiday" || p.status === "on_call") return "off";
  return "not_in";
}
const PLACE_ORDER: Readonly<Record<TodayPlace, number>> = { not_in: 0, in: 1, leave: 2, off: 3 };
/** "Not in" first, then who came (latest first-in on top: the late ones lead), then leave, then off; by name within. */
export function sortToday<T extends TodayPerson & { name: string }>(people: readonly T[]): T[] {
  return [...people].sort((a, b) => {
    const pa = todayPlace(a), pb = todayPlace(b);
    if (pa !== pb) return PLACE_ORDER[pa] - PLACE_ORDER[pb];
    if (pa === "in" && a.firstIn !== b.firstIn) return (b.firstIn ?? "") < (a.firstIn ?? "") ? -1 : 1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
}
export type TodayCounts = { in: number; notIn: number; late: number; leave: number; total: number };
export function todayCounts(people: readonly TodayPerson[]): TodayCounts {
  const c: TodayCounts = { in: 0, notIn: 0, late: 0, leave: 0, total: people.length };
  for (const p of people) {
    const place = todayPlace(p);
    if (place === "in") c.in += 1; else if (place === "not_in") c.notIn += 1; else if (place === "leave") c.leave += 1;
    if (p.status === "late") c.late += 1;
  }
  return c;
}

/* ═══ the calendar ═══ */

const DAY_MS = 86_400_000;
const at = (date: string): number => Date.parse(`${date}T00:00:00Z`);
const iso = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export function addDays(date: string, n: number): string {
  return iso(at(date) + n * DAY_MS);
}
/** 0 = Monday … 6 = Sunday. */
export function weekdayOf(date: string): number {
  return (new Date(at(date)).getUTCDay() + 6) % 7;
}
/** The seven dates, Monday to Sunday, of the week `date` is in. */
export function weekOf(date: string): string[] {
  const monday = addDays(date, -weekdayOf(date));
  return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
}
/** `YYYY-MM` of a date. */
export function monthOf(date: string): string {
  return date.slice(0, 7);
}
export function addMonths(month: string, n: number): string {
  const total = Number(month.slice(0, 4)) * 12 + (Number(month.slice(5, 7)) - 1) + n;
  return `${String(Math.floor(total / 12)).padStart(4, "0")}-${String((total % 12) + 1).padStart(2, "0")}`;
}
export function monthDays(month: string): string[] {
  const first = `${month}-01`;
  const next = `${addMonths(month, 1)}-01`;
  const out: string[] = [];
  for (let d = first; d < next; d = addDays(d, 1)) out.push(d);
  return out;
}
/** A month as rows of seven, Monday first; `null` pads the first and last rows. */
export function monthGrid(month: string): (string | null)[][] {
  const days = monthDays(month);
  const cells: (string | null)[] = [...Array.from({ length: weekdayOf(days[0]!) }, () => null), ...days];
  while (cells.length % 7 !== 0) cells.push(null);
  return Array.from({ length: cells.length / 7 }, (_, r) => cells.slice(r * 7, r * 7 + 7));
}
/** The last date a read may ask for in a period: its end, but never after today. `null` when the whole period is ahead. */
export function clampToToday(from: string, to: string, today: string): { from: string; to: string } | null {
  if (from > today) return null;
  return { from, to: to > today ? today : to };
}

export type WordCounts = Record<"present" | "partial" | "absent" | "leave" | "off", number> & { confirm: number; days: number };
/** How many of each word in a list of days. `days` counts the ones somebody was expected (not off, not leave). */
export function countWords(words: readonly SelfWord[]): WordCounts {
  const c: WordCounts = { present: 0, partial: 0, absent: 0, leave: 0, off: 0, confirm: 0, days: 0 };
  for (const w of words) {
    if (w === "unknown") continue;
    c[w] += 1;
    if (w !== "off" && w !== "leave") c.days += 1;
  }
  return c;
}

/** The most recent date needing "Confirm", and how many more there are behind it. */
export function confirmSummary(needsConfirm: readonly string[]): { date: string; more: number } | null {
  if (needsConfirm.length === 0) return null;
  const sorted = [...needsConfirm].sort();
  return { date: sorted[sorted.length - 1]!, more: sorted.length - 1 };
}

/** `HH:MM` out of `HH:MM`, `HH:MM:SS` or `YYYY-MM-DD HH:MM:SS`; anything else is null. */
export function clockOf(text: string | null | undefined): string | null {
  const m = /(?:^|\s)(\d{2}:\d{2})(?::\d{2})?$/.exec(text ?? "");
  return m === null ? null : m[1]!;
}
