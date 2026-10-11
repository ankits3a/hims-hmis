/**
 * E1.2 — PERSONAL REMINDERS (decision 0064; spec /opt/hmis-context/SPEC-reminders-2026-10-11.md,
 * owner yes 2026-10-11). "Remind me at 4 pm to see bed 12", "every Monday 9 am": a staff member's
 * own reminder, raised on their own bell and phone, seen by nobody else.
 *
 * Pure TypeScript with no imports, like `my-pace.ts`: the server enforces these limits and computes
 * the next time with them, and the phone (outside the pnpm workspace) reads this file by path to
 * offer the same choices and say the same next time.
 *
 * TIME IS IST, FIXED +05:30. India keeps no daylight saving, so "the same time tomorrow" is exactly
 * 24 hours later and a repeat never drifts.
 */

/** once · every day · Monday to Saturday (the hospital's working week) · once a week on the first time's weekday. */
export const REMINDER_REPEATS = ["none", "daily", "mon_sat", "weekly"] as const;
export type ReminderRepeat = (typeof REMINDER_REPEATS)[number];

export const REMINDER_TEXT_MAX = 80;
/** Active = not yet fired (a one-off) or still repeating, and not cancelled. */
export const REMINDER_MAX_ACTIVE = 20;
/** A reminder is set at least a minute ahead and at most a year ahead. */
export const REMINDER_MIN_LEAD_MS = 60_000;
export const REMINDER_MAX_AHEAD_DAYS = 365;

/** What `GET /reminders` lists and `POST /reminders` answers. */
export type ReminderRow = { id: string; text: string; dueAt: string; repeat: ReminderRepeat; createdAt: string };

const DAY_MS = 24 * 60 * 60 * 1000;
const IST_OFFSET_MS = 330 * 60 * 1000;

/** The IST calendar of an instant: `YYYY-MM-DD`, `HH:MM` and the weekday (0 = Sunday). */
export function istClock(at: Date): { day: string; hhmm: string; weekday: number } {
  const shifted = new Date(at.getTime() + IST_OFFSET_MS);
  const iso = shifted.toISOString();
  return { day: iso.slice(0, 10), hhmm: iso.slice(11, 16), weekday: shifted.getUTCDay() };
}

/** The instant of `HH:MM` IST on the IST day `YYYY-MM-DD`. Null on a malformed day or time. */
export function istInstant(day: string, hhmm: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(hhmm)) return null;
  const at = new Date(`${day}T${hhmm}:00.000+05:30`);
  return Number.isNaN(at.getTime()) ? null : at;
}

/**
 * The first time a new reminder fires. Only a `mon_sat` reminder set for a Sunday moves — to the
 * Monday at the same time; every other choice fires when the person said.
 */
export function firstDue(repeat: ReminderRepeat, at: Date): Date {
  if (repeat === "mon_sat" && istClock(at).weekday === 0) return new Date(at.getTime() + DAY_MS);
  return at;
}

/**
 * The next time a repeating reminder fires after it fired at `due`: the first of its times that is
 * strictly after `now`. A worker that was down for a day therefore fires ONCE on recovery and moves
 * on — no backlog of missed days. Null for a one-off.
 */
export function nextOccurrence(repeat: ReminderRepeat, due: Date, now: Date): Date | null {
  if (repeat === "none") return null;
  const step = repeat === "weekly" ? 7 * DAY_MS : DAY_MS;
  let next = due.getTime() + step;
  if (next <= now.getTime()) next += Math.ceil((now.getTime() - next + 1) / step) * step;
  if (repeat === "mon_sat" && istClock(new Date(next)).weekday === 0) next += DAY_MS;
  return new Date(next);
}
