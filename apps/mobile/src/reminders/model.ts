import { REMINDER_TEXT_MAX, istClock, istInstant } from "../../../../packages/contracts/src/reminders";
import type { ReminderRepeat, ReminderRow } from "../../../../packages/contracts/src/reminders";

/**
 * E1.2 — PERSONAL REMINDERS on the phone (decision 0064; spec /opt/hmis-context/SPEC-reminders-2026-10-11.md).
 * The pure half: which days the form offers, what a typed time means, and how a reminder's next time
 * reads in a few words (owner 2026-10-09: one line at 390 px). Limits and the repeat grammar are the
 * server's own (`packages/contracts/src/reminders.ts`, read by path).
 */
export type { ReminderRepeat, ReminderRow };
export const REPEAT_CHOICES: readonly ReminderRepeat[] = ["none", "daily", "mon_sat", "weekly"];
export const TEXT_MAX = REMINDER_TEXT_MAX;
/** Today and the six days after it — enough for "every Monday" and "on Friday". */
export const DAY_CHOICES = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

type T = (key: string, vars?: Record<string, string | number>) => string;

/** The IST days the form offers, from today. */
export function dayChoices(nowMs: number): { day: string; weekday: number; offset: number }[] {
  return Array.from({ length: DAY_CHOICES }, (_, i) => {
    const c = istClock(new Date(nowMs + i * DAY_MS));
    return { day: c.day, weekday: c.weekday, offset: i };
  });
}

/** "9:5", "0905", "09.05", "9" → "09:05" / "09:00"; anything else → null. */
export function readTime(raw: string): string | null {
  const v = raw.trim().replace(/[.\s]/g, ":");
  const m = /^(\d{1,2})(?::?(\d{2}))?$/.exec(v);
  if (m === null) return null;
  const h = Number(m[1]); const min = m[2] === undefined ? 0 : Number(m[2]);
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

/** The instant the form describes, or why not: no words, no time, or a time already gone. */
export function formInstant(text: string, day: string, rawTime: string, nowMs: number): { at: string } | { problem: "text" | "time" | "past" } {
  if (text.trim() === "") return { problem: "text" };
  const hhmm = readTime(rawTime);
  const at = hhmm === null ? null : istInstant(day, hhmm);
  if (at === null) return { problem: "time" };
  if (at.getTime() < nowMs + 60_000) return { problem: "past" };
  return { at: at.toISOString() };
}

/** "Today 16:00", "Tomorrow 09:00", "Mon 19 · 09:00". */
export function whenText(t: T, dueAt: string, nowMs: number): string {
  const due = istClock(new Date(dueAt));
  const today = istClock(new Date(nowMs)).day;
  const tomorrow = istClock(new Date(nowMs + DAY_MS)).day;
  if (due.day === today) return t("reminders.today", { time: due.hhmm });
  if (due.day === tomorrow) return t("reminders.tomorrow", { time: due.hhmm });
  return t("reminders.onDay", { day: t(`reminders.wd.${String(due.weekday)}`), date: Number(due.day.slice(8, 10)), time: due.hhmm });
}

/** The chip label of an offered day. */
export function dayLabel(t: T, c: { weekday: number; offset: number; day: string }): string {
  if (c.offset === 0) return t("reminders.day.today");
  if (c.offset === 1) return t("reminders.day.tomorrow");
  return t("reminders.dayChip", { day: t(`reminders.wd.${String(c.weekday)}`), date: Number(c.day.slice(8, 10)) });
}
