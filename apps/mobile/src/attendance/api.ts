import { addDays, todayCounts, type ConfirmReason, type SelfWord, type TodayCounts, type TodayState } from "./rules";
import type { Call } from "../doctor/api";

/**
 * The attendance routes, as the server answers them (`apps/core/src/modules/attendance`).
 *
 * A PERSON'S OWN DAYS ARE WORDS. `firstIn`, `lastOut`, `hoursWorked` and `punches` are OPTIONAL here
 * because the server leaves them OUT of the payload until the hospital switches times on
 * (`ATTENDANCE_SELF_SHOWS_TIMES`); a screen draws a time only when the key is there.
 */
export type SelfDay = { date: string; status: SelfWord; reason?: ConfirmReason; firstIn?: string | null; lastOut?: string | null; hoursWorked?: number | null };
export type SelfToday = { date: string; state: TodayState; status: SelfWord | null; firstIn?: string | null; lastOut?: string | null; inSince?: string | null };
export type Person = { pin: string; name: string; dept: string | null; post: string | null };
export type Me =
  | { linked: false; reason: string; configured: boolean; leadsTeam?: boolean }
  | { linked: true; configured: boolean; leadsTeam?: boolean; showsTimes: boolean; person: Person; from: string; to: string; today: SelfToday; days: SelfDay[]; needsConfirm: string[] };
export type Punch = { time: string; direction: string | null; device: string | null; verify: string | null };
export type MyPunches = { linked: boolean; date: string; showsTimes: boolean; status: SelfWord | null; reason?: ConfirmReason; punches?: Punch[] };
export type MyRequest = { id: string; date: string; reasonCode: string; note: string | null; status: "open" | "seen" | "closed" | "resolved_by_correction"; createdAt: string; closedAt: string | null; closeNote: string | null };

/** What managers see: the machine's own status, with times. */
export type FullDay = { date: string; firstIn: string | null; lastOut: string | null; hoursWorked: number | null; status: string; known: boolean; shiftName: string | null; locked: boolean };
export type TodayRow = Person & { status: string | null; known: boolean; firstIn: string | null; lastOut: string | null; onDuty: boolean; hasLogin: boolean };
export type TodayList = { date: string; configured: boolean; people: TodayRow[]; summary: { total: number; byStatus: Record<string, number>; byDept: { dept: string | null; total: number }[] } };
export type PersonRange =
  | { detail: "full"; person: Person; from: string; to: string; days: FullDay[] }
  | { detail: "self"; showsTimes: boolean; person: Person; from: string; to: string; days: SelfDay[] };
export type TeamMember = { userId: string; name: string; linked: boolean; pin: string | null; today: { status: string | null; known: boolean; firstIn: string | null; lastOut: string | null; onDuty: boolean } | null };
export type TeamToday = { date: string; members: TeamMember[]; summary: { total: number; linked: number } };
export type SyncState = { configured: boolean; enabled: boolean; onDutyAsOf: string | null; lastErrorClass: string | null; stages: Record<string, { lastOkAt: string | null; lastOutcome: string | null }> };
export type QueueRequest = MyRequest & { name: string; dept: string | null; post: string | null; ageHours: number; seenAt: string | null };
export type RequestTab = "open" | "seen" | "closed";

export const ALL_READ = "attendance.all.read";
/** The home card reads this many days back in its ONE request: enough for the "Confirm" warning the server keeps (31 days). */
export const HOME_WINDOW_DAYS = 31;

const enc = encodeURIComponent;

export function attendanceApi(call: Call) {
  return {
    me: (from: string, to: string) => call<Me>("GET", `/attendance/me?from=${from}&to=${to}`),
    myPunches: (date: string) => call<MyPunches>("GET", `/attendance/me/punches?date=${date}`),
    myRequests: () => call<{ requests: MyRequest[] }>("GET", "/attendance/me/requests"),
    askToMeet: (date: string) => call<{ created: boolean; request: MyRequest }>("POST", "/attendance/me/requests", { date }),
    today: () => call<TodayList>("GET", "/attendance/today"),
    syncState: () => call<SyncState>("GET", "/attendance/sync-state"),
    person: (pin: string, from: string, to: string) => call<PersonRange>("GET", `/attendance/person/${enc(pin)}?from=${from}&to=${to}`),
    teamToday: () => call<TeamToday>("GET", "/attendance/team/today"),
    requests: (status: RequestTab) => call<{ status: RequestTab; requests: QueueRequest[] }>("GET", `/attendance/requests?status=${status}`),
    markSeen: (id: string) => call<{ request: MyRequest }>("POST", `/attendance/requests/${enc(id)}/seen`),
    close: (id: string, note: string) => call<{ request: MyRequest }>("POST", `/attendance/requests/${enc(id)}/close`, note.trim() === "" ? {} : { note: note.trim() }),
  };
}

/** The home card's one read: today and the 31 days behind it. */
export function homeRange(today: string): { from: string; to: string } {
  return { from: addDays(today, -HOME_WINDOW_DAYS), to: today };
}

/**
 * FOR THE OWNER'S HOME (another lane's Staff tile): everyone on the machine today as four counts and
 * whether the machine is connected. One request; `null` when it could not be read or the caller may
 * not read it — a tile draws nothing rather than a zero.
 */
export async function attendanceTodaySummary(call: Call): Promise<(TodayCounts & { date: string; configured: boolean }) | null> {
  try {
    const list = await attendanceApi(call).today();
    return { ...todayCounts(list.people), date: list.date, configured: list.configured };
  } catch {
    return null;
  }
}
