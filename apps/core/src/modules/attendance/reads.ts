import { and, asc, eq, gte, inArray, isNull, lt, lte, ne, or, sql } from "drizzle-orm";
import { attDays, attHolidays, attLeaves, attOnDuty, attPunches, attRoster, attStaff, attSyncState, users } from "../../kernel/db/schema";
import { CONFIRM_REASONS, DAY_WORDS, KNOWN_STATUSES, dayWord, selfWord } from "@hmis/contracts";
import { addDays, daysInclusive, isIsoDate } from "./ist";
import { linkStates, normaliseMobile } from "./linking";
import type { ConfirmReason, DayWord, SelfWord } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";

/**
 * THE WORDS (owner 2026-10-09) live in `packages/contracts/src/attendance-view.ts` — one file the
 * server and the phone both read, so they cannot disagree about what "Present" is. Re-exported here
 * for this module's own callers.
 */
export { CONFIRM_REASONS, DAY_WORDS, KNOWN_STATUSES, dayWord, selfWord };
export type { ConfirmReason, DayWord, SelfWord };

/**
 * ═══ WHAT THE READ ROUTES ANSWER — AND WHAT NONE OF THEM EVER DOES ═══
 *
 * Every view below is built from an explicit list of columns. `att_staff.mobile`,
 * `att_staff.aadhaar_hash`, `users.phone`, `users.aadhaar_hash` and `users.aadhaar_last4` are in
 * none of those lists, so no read route can return a mobile number or a hash.
 *
 * Dates are IST strings in and out. A `status` bioattend adds after the guide of 2026-10-09 is
 * passed through as it came with `known: false` — "see bioattend", not an error.
 */
const KNOWN: ReadonlySet<string> = new Set(KNOWN_STATUSES);
export const isKnownStatus = (s: string): boolean => KNOWN.has(s);

export const MAX_READ_DAYS = 92;
export const MAX_DAYS_AHEAD = 14;

export class AttendanceRangeError extends Error {
  constructor(readonly code: "bad_date" | "range_reversed" | "range_too_long" | "too_far_ahead") { super(code); }
}

/** `from…to` inclusive, at most 92 days, nothing after today+14. Absent ends default to the last seven days. */
export function readRange(q: { from?: string; to?: string }, today: string): { from: string; to: string } {
  const to = q.to ?? (q.from !== undefined && q.from > today ? q.from : today);
  const from = q.from ?? addDays(to, -6);
  if (!isIsoDate(from) || !isIsoDate(to)) throw new AttendanceRangeError("bad_date");
  if (from > to) throw new AttendanceRangeError("range_reversed");
  if (daysInclusive(from, to) > MAX_READ_DAYS) throw new AttendanceRangeError("range_too_long");
  if (to > addDays(today, MAX_DAYS_AHEAD)) throw new AttendanceRangeError("too_far_ahead");
  return { from, to };
}

export type DayView = {
  date: string; firstIn: string | null; lastOut: string | null; hoursWorked: number | null;
  status: string; known: boolean; shiftName: string | null; locked: boolean;
};
export type PersonView = { pin: string; name: string; dept: string | null; post: string | null };
export type TodayView = {
  date: string; status: string | null; known: boolean; firstIn: string | null; lastOut: string | null;
  onDuty: boolean; inSince: string | null;
};
export type RangeView = {
  days: DayView[];
  leaves: { date: string; reason: string | null }[];
  roster: { date: string; shiftName: string | null; start: string | null; end: string | null; off: boolean; holiday: string | null; leave: boolean }[];
  holidays: { date: string; name: string; cancelled: boolean }[];
};

const dayCols = {
  pin: attDays.pin, date: attDays.date, firstIn: attDays.firstIn, lastOut: attDays.lastOut, hoursWorked: attDays.hoursWorked,
  status: attDays.status, shiftName: attDays.shiftName, locked: attDays.locked,
};
const toDay = (r: { date: string; firstIn: string | null; lastOut: string | null; hoursWorked: number | null; status: string; shiftName: string | null; locked: boolean }): DayView => ({
  date: r.date, firstIn: r.firstIn, lastOut: r.lastOut, hoursWorked: r.hoursWorked, status: r.status, known: isKnownStatus(r.status), shiftName: r.shiftName, locked: r.locked,
});

export async function personOf(db: Db, pin: string): Promise<(PersonView & { userId: string | null }) | null> {
  const rows = await db.select({ pin: attStaff.pin, name: attStaff.name, dept: attStaff.dept, post: attStaff.post, userId: attStaff.userId }).from(attStaff).where(eq(attStaff.pin, pin));
  return rows[0] ?? null;
}

export async function personOfUser(db: Db, userId: string): Promise<PersonView | null> {
  const rows = await db.select({ pin: attStaff.pin, name: attStaff.name, dept: attStaff.dept, post: attStaff.post }).from(attStaff).where(eq(attStaff.userId, userId));
  return rows[0] ?? null;
}

/** Why a login has no attendance to show — said in words the app can turn into one sentence. */
export type UnlinkedReason = "no_mobile_or_aadhaar" | "two_matches" | "no_match";
export async function unlinkedReason(db: Db, userId: string): Promise<UnlinkedReason> {
  const u = (await db.select({ phone: users.phone, aadhaarHash: users.aadhaarHash }).from(users).where(eq(users.id, userId)))[0];
  if (u === undefined || (normaliseMobile(u.phone) === null && u.aadhaarHash === null)) return "no_mobile_or_aadhaar";
  // The same judgement that withheld the link (`decideLinks`), so the app and the Users screen agree.
  return (await linkStates(db)).get(userId) === "two_matches" ? "two_matches" : "no_match";
}

export async function personRange(db: Db, person: PersonView, from: string, to: string): Promise<RangeView> {
  const days = await db.select(dayCols).from(attDays).where(and(eq(attDays.pin, person.pin), gte(attDays.date, from), lte(attDays.date, to))).orderBy(asc(attDays.date));
  const leaves = await db.select({ date: attLeaves.date, reason: attLeaves.reason }).from(attLeaves)
    .where(and(eq(attLeaves.pin, person.pin), gte(attLeaves.date, from), lte(attLeaves.date, to))).orderBy(asc(attLeaves.date));
  const roster = await db.select({
    date: attRoster.date, shiftName: attRoster.shiftName, start: attRoster.startTime, end: attRoster.endTime, off: attRoster.off, holiday: attRoster.holiday, leave: attRoster.leave,
  }).from(attRoster).where(and(eq(attRoster.pin, person.pin), gte(attRoster.date, from), lte(attRoster.date, to))).orderBy(asc(attRoster.date));
  // A holiday is this person's when it is for everyone (`dept` null) or for their department.
  const holidays = await db.select({ date: attHolidays.date, name: attHolidays.name, cancelled: attHolidays.cancelled }).from(attHolidays)
    .where(and(gte(attHolidays.date, from), lte(attHolidays.date, to), person.dept === null ? isNull(attHolidays.dept) : or(isNull(attHolidays.dept), eq(attHolidays.dept, person.dept))))
    .orderBy(asc(attHolidays.date), asc(attHolidays.name));
  return { days: days.map(toDay), leaves, roster, holidays };
}

export async function todayOf(db: Db, pin: string, today: string): Promise<TodayView> {
  const d = (await db.select(dayCols).from(attDays).where(and(eq(attDays.pin, pin), eq(attDays.date, today))))[0];
  const duty = (await db.select({ inSince: attOnDuty.inSince }).from(attOnDuty).where(eq(attOnDuty.pin, pin)))[0];
  return {
    date: today, status: d?.status ?? null, known: d === undefined ? true : isKnownStatus(d.status), firstIn: d?.firstIn ?? null, lastOut: d?.lastOut ?? null,
    onDuty: duty !== undefined, inSince: duty?.inSince ?? null,
  };
}

/** A person's own "Confirm" days are listed for this many days back, for the home card. */
export const NEEDS_CONFIRM_DAYS = 31;

/** A person's OWN day: the word (and why, for `confirm`), and — only with `ATTENDANCE_SELF_SHOWS_TIMES` on — the times. The time keys are ABSENT otherwise, not null. */
export type SelfDayView = { date: string; status: SelfWord; reason?: ConfirmReason; firstIn?: string | null; lastOut?: string | null; hoursWorked?: number | null };
/**
 * Today, three states, BY COUNT of today's stored punches — the guide says a punch's direction is
 * unreliable ("many devices send `in` for every punch"): none = not in; an odd number = in; an even
 * number (two or more) = out. The day's word is given only once checked out.
 */
export type SelfTodayState = "not_checked_in" | "checked_in" | "checked_out";
export type SelfTodayView = { date: string; state: SelfTodayState; status: SelfWord | null; firstIn?: string | null; lastOut?: string | null; inSince?: string | null };

async function punchedDays(db: Db, pin: string, from: string, to: string): Promise<Set<string>> {
  const rows = await db.selectDistinct({ day: attPunches.day }).from(attPunches).where(and(eq(attPunches.pin, pin), gte(attPunches.day, from), lte(attPunches.day, to)));
  return new Set(rows.map((r) => r.day));
}

export async function selfDays(db: Db, pin: string, from: string, to: string, today: string, withTimes: boolean): Promise<SelfDayView[]> {
  const days = await db.select(dayCols).from(attDays).where(and(eq(attDays.pin, pin), gte(attDays.date, from), lte(attDays.date, to))).orderBy(asc(attDays.date));
  const punched = await punchedDays(db, pin, from, to);
  return days.map((d) => ({
    date: d.date, ...selfWord(d.status, d.firstIn !== null || punched.has(d.date), d.date, today),
    ...(withTimes ? { firstIn: d.firstIn, lastOut: d.lastOut, hoursWorked: d.hoursWorked } : {}),
  }));
}

/** The person's own days in the last 31 that read `confirm` — so a home card can warn without loading a month. */
export async function needsConfirm(db: Db, pin: string, today: string): Promise<string[]> {
  const rows = await db.select({ date: attDays.date }).from(attDays)
    .where(and(eq(attDays.pin, pin), eq(attDays.status, "single_punch"), gte(attDays.date, addDays(today, -NEEDS_CONFIRM_DAYS)), lt(attDays.date, today))).orderBy(asc(attDays.date));
  return rows.map((r) => r.date);
}

export async function selfToday(db: Db, pin: string, today: string, withTimes: boolean): Promise<SelfTodayView> {
  const d = (await db.select(dayCols).from(attDays).where(and(eq(attDays.pin, pin), eq(attDays.date, today))))[0];
  const n = (await db.select({ n: sql<number>`count(*)::int` }).from(attPunches).where(and(eq(attPunches.pin, pin), eq(attPunches.day, today))))[0]!.n;
  const state: SelfTodayState = n === 0 ? "not_checked_in" : n % 2 === 1 ? "checked_in" : "checked_out";
  const duty = withTimes ? (await db.select({ inSince: attOnDuty.inSince }).from(attOnDuty).where(eq(attOnDuty.pin, pin)))[0] : undefined;
  return {
    date: today, state, status: state === "checked_out" && d !== undefined ? dayWord(d.status, true) : null,
    ...(withTimes ? { firstIn: d?.firstIn ?? null, lastOut: d?.lastOut ?? null, inSince: duty?.inSince ?? null } : {}),
  };
}

export type PunchView = { time: string; direction: string | null; device: string | null; verify: string | null };
export async function punchesOf(db: Db, pin: string, date: string): Promise<PunchView[]> {
  const rows = await db.select({ ts: attPunches.ts, direction: attPunches.direction, device: attPunches.device, verify: attPunches.verify })
    .from(attPunches).where(and(eq(attPunches.pin, pin), eq(attPunches.day, date))).orderBy(asc(attPunches.ts), asc(attPunches.id));
  return rows.map((r) => ({ time: r.ts.slice(11), direction: r.direction, device: r.device, verify: r.verify }));
}

export type TodayRow = PersonView & {
  status: string | null; known: boolean; firstIn: string | null; lastOut: string | null; onDuty: boolean; hasLogin: boolean;
};
export type CountsByStatus = Record<string, number>;
const NOT_YET = "not_yet";

function countBy(rows: readonly { status: string | null }[]): CountsByStatus {
  const out: CountsByStatus = {};
  for (const r of rows) out[r.status ?? NOT_YET] = (out[r.status ?? NOT_YET] ?? 0) + 1;
  return out;
}

/**
 * Everyone on the machine's list today — INCLUDING people with no HMIS login (college staff: the
 * owner's ruling, "committee sees them from machine's list"). A person who has left is listed only
 * if bioattend still has a row for them today. `pins` narrows it to a team.
 */
export async function todayList(db: Db, today: string, filter: { dept?: string; pins?: readonly string[] } = {}): Promise<{
  people: TodayRow[]; byStatus: CountsByStatus; byDept: { dept: string | null; total: number; byStatus: CountsByStatus }[];
}> {
  if (filter.pins !== undefined && filter.pins.length === 0) return { people: [], byStatus: {}, byDept: [] };
  const conds = [or(ne(attStaff.status, "left"), sql`${attDays.pin} is not null`)];
  if (filter.dept !== undefined) conds.push(eq(attStaff.dept, filter.dept));
  if (filter.pins !== undefined) conds.push(inArray(attStaff.pin, [...filter.pins]));
  const rows = await db.select({
    pin: attStaff.pin, name: attStaff.name, dept: attStaff.dept, post: attStaff.post, userId: attStaff.userId,
    status: attDays.status, firstIn: attDays.firstIn, lastOut: attDays.lastOut, dutyPin: attOnDuty.pin,
  }).from(attStaff)
    .leftJoin(attDays, and(eq(attDays.pin, attStaff.pin), eq(attDays.date, today)))
    .leftJoin(attOnDuty, eq(attOnDuty.pin, attStaff.pin))
    .where(and(...conds)).orderBy(asc(attStaff.dept), asc(attStaff.name), asc(attStaff.pin));
  const people: TodayRow[] = rows.map((r) => ({
    pin: r.pin, name: r.name, dept: r.dept, post: r.post, status: r.status, known: r.status === null ? true : isKnownStatus(r.status),
    firstIn: r.firstIn, lastOut: r.lastOut, onDuty: r.dutyPin !== null, hasLogin: r.userId !== null,
  }));
  const depts = [...new Set(people.map((p) => p.dept))];
  return {
    people, byStatus: countBy(people),
    byDept: depts.map((dept) => { const mine = people.filter((p) => p.dept === dept); return { dept, total: mine.length, byStatus: countBy(mine) }; }),
  };
}

export type SummaryGroup = { key: string | null; total: number; byStatus: CountsByStatus; byWord: Record<DayWord, number> };
const noWords = (): Record<DayWord, number> => ({ present: 0, absent: 0, leave: 0, off: 0, partial: 0, unknown: 0 });
/** Counts only — nobody's name, pin or time. Each group carries the machine's statuses AND the five-word tally (`dayWord`). */
export async function summary(db: Db, from: string, to: string, groupBy: "dept" | "status" | "day"): Promise<SummaryGroup[]> {
  const key = groupBy === "dept" ? attStaff.dept : groupBy === "day" ? sql<string>`${attDays.date}::text` : attDays.status;
  const punched = sql<boolean>`(${attDays.firstIn} is not null or exists (select 1 from ${attPunches} where ${attPunches.pin} = ${attDays.pin} and ${attPunches.day} = ${attDays.date}))`;
  const rows = await db.select({ key: sql<string | null>`${key}`, status: attDays.status, punched, n: sql<number>`count(*)::int` })
    .from(attDays).leftJoin(attStaff, eq(attStaff.pin, attDays.pin))
    .where(and(gte(attDays.date, from), lte(attDays.date, to))).groupBy(sql`1`, attDays.status, sql`3`).orderBy(sql`1`);
  const groups = new Map<string | null, SummaryGroup>();
  for (const r of rows) {
    const g = groups.get(r.key) ?? { key: r.key, total: 0, byStatus: {}, byWord: noWords() };
    g.total += r.n;
    g.byStatus[r.status] = (g.byStatus[r.status] ?? 0) + r.n;
    g.byWord[dayWord(r.status, r.punched)] += r.n;
    groups.set(r.key, g);
  }
  return [...groups.values()];
}

/** The linked pins of a set of logins — a team's attendance records. */
export async function peopleOfUsers(db: Db, userIds: readonly string[]): Promise<(PersonView & { userId: string })[]> {
  if (userIds.length === 0) return [];
  const rows = await db.select({ pin: attStaff.pin, name: attStaff.name, dept: attStaff.dept, post: attStaff.post, userId: attStaff.userId })
    .from(attStaff).where(inArray(attStaff.userId, [...userIds]));
  return rows.filter((r): r is typeof r & { userId: string } => r.userId !== null);
}

export async function daysOfPins(db: Db, pins: readonly string[], from: string, to: string): Promise<Map<string, DayView[]>> {
  const out = new Map<string, DayView[]>(pins.map((p) => [p, []]));
  if (pins.length === 0) return out;
  const rows = await db.select(dayCols).from(attDays).where(and(inArray(attDays.pin, [...pins]), gte(attDays.date, from), lte(attDays.date, to))).orderBy(asc(attDays.date));
  for (const r of rows) out.get(r.pin)!.push(toDay(r));
  return out;
}

export type StageState = { lastAttemptAt: string | null; lastOkAt: string | null; lastOutcome: string | null };
export type SyncStateView = {
  cursor: number | null;
  /** bioattend's own "as of" for who is in right now — IST text, e.g. `2026-10-09 16:20:00`. */
  onDutyAsOf: string | null;
  stages: Record<string, StageState>;
  /** The outcome NAME of the newest failure still standing (`bad_key`, `ip_not_allowed`, `network`, …), or null. */
  lastErrorClass: string | null;
};
export async function syncState(db: Db): Promise<SyncStateView> {
  const rows = await db.select().from(attSyncState);
  const stages: Record<string, StageState> = {};
  let lastErrorClass: string | null = null;
  let newest = 0;
  for (const r of rows) {
    if (r.stage === "refused") continue;
    stages[r.stage] = { lastAttemptAt: r.lastAttemptAt?.toISOString() ?? null, lastOkAt: r.lastOkAt?.toISOString() ?? null, lastOutcome: r.lastOutcome };
    const at = r.lastAttemptAt?.getTime() ?? 0;
    if (r.lastOutcome !== null && r.lastOutcome !== "ok" && at >= newest) { newest = at; lastErrorClass = r.lastOutcome; }
  }
  return {
    cursor: rows.find((r) => r.stage === "punches")?.cursor ?? null,
    onDutyAsOf: rows.find((r) => r.stage === "today")?.note ?? null,
    stages, lastErrorClass,
  };
}
