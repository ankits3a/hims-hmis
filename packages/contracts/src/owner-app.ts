/**
 * THE OWNER'S SCREENS IN THE STAFF APP (owner, 2026-10-09: "Home as seven tiles (drawn)" — Money, OPD,
 * Recorded, Appointments, Pharmacy, Staff, Learning; each opens a page with Today / Week / Month /
 * Custom). Pure TypeScript with no imports, like `app-home.ts`: the server reads it for the periods it
 * accepts, and the phone (outside the pnpm workspace) reads it by path — so the two cannot disagree
 * about what "this week" or "the same days last month" means.
 *
 * Every day here is an IST calendar day, 'YYYY-MM-DD'. Nothing reads a clock: `today` is the caller's.
 */

export type OwnerPeriod = "today" | "week" | "month" | "custom";
export const OWNER_PERIODS: readonly OwnerPeriod[] = ["today", "week", "month", "custom"];
/** The longest range a page may ask for. */
export const OWNER_MAX_DAYS = 92;

const DAY_MS = 86_400_000;
const IST_OFFSET_MS = 5.5 * 3_600_000;

/** The IST calendar day of an instant. */
export function istDayOf(ms: number): string {
  return new Date(Math.floor((ms + IST_OFFSET_MS) / DAY_MS) * DAY_MS).toISOString().slice(0, 10);
}
export function isIsoDay(s: unknown): s is string {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === s;
}
export function addDayIso(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}
/** Days in `from`..`to`, both ends counted. */
export function daysInclusive(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1;
}
/** 0 = Monday … 6 = Sunday. */
export function mondayIndex(day: string): number {
  return (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7;
}
function lastDayOfMonth(year: number, month1: number): number {
  return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}
const two = (n: number): string => String(n).padStart(2, "0");

export type DayRange = { from: string; to: string };
export type RangeProblem = "bad_date" | "order" | "too_long" | "future";

/** Why a range cannot be asked for, or null. The server refuses with the same four words. */
export function rangeProblem(from: unknown, to: unknown, today: string): RangeProblem | null {
  if (!isIsoDay(from) || !isIsoDay(to)) return "bad_date";
  if (to < from) return "order";
  if (to > today) return "future";
  if (daysInclusive(from, to) > OWNER_MAX_DAYS) return "too_long";
  return null;
}

/** The first of the month to `today`, and the previous month from its first to the same day number. */
export function monthSoFar(today: string): { now: DayRange; before: DayRange } {
  const y = Number(today.slice(0, 4)), m = Number(today.slice(5, 7)), d = Number(today.slice(8, 10));
  const py = m === 1 ? y - 1 : y, pm = m === 1 ? 12 : m - 1;
  const pd = Math.min(d, lastDayOfMonth(py, pm));
  return {
    now: { from: `${today.slice(0, 8)}01`, to: today },
    before: { from: `${String(py)}-${two(pm)}-01`, to: `${String(py)}-${two(pm)}-${two(pd)}` },
  };
}

/**
 * The days a period covers on `today`, and what it is compared with:
 *   today  ↔ the same weekday last week
 *   week   (Monday to today) ↔ the previous week, Monday to the same weekday
 *   month  (the 1st to today) ↔ the previous month, the 1st to the same day number
 *   custom ↔ nothing
 * A custom range that cannot be asked for (`rangeProblem`) gives null.
 */
export function ownerRange(period: OwnerPeriod, today: string, custom?: Partial<DayRange> | null): (DayRange & { compare: DayRange | null }) | null {
  if (period === "today") return { from: today, to: today, compare: { from: addDayIso(today, -7), to: addDayIso(today, -7) } };
  if (period === "week") {
    const monday = addDayIso(today, -mondayIndex(today));
    return { from: monday, to: today, compare: { from: addDayIso(monday, -7), to: addDayIso(today, -7) } };
  }
  if (period === "month") { const m = monthSoFar(today); return { ...m.now, compare: m.before }; }
  if (rangeProblem(custom?.from, custom?.to, today) !== null) return null;
  return { from: custom!.from!, to: custom!.to!, compare: null };
}

/** Whole percent of `now` against `before`; null when there is nothing to compare with. */
export function percentChange(now: number, before: number | null | undefined): number | null {
  if (before === null || before === undefined || before <= 0) return null;
  return Math.round(((now - before) / before) * 100);
}

/* ═══ what the server sends ═══ — counts and sums only: no patient, no invoice number. */

export type TenderSplit = { cash: number; upi: number; card: number };
/** A drawer, in words: still open and not counted, or counted and exact / short / excess. */
export type DrawerState = "open" | "exact" | "short" | "excess";
export type OwnerMoney = DayRange & {
  collectedPaise: number; receipts: number; byMode: TenderSplit;
  /** The comparison range's collected total; null when none was asked for. */
  previous: (DayRange & { collectedPaise: number }) | null;
  /** Always the month of the server's today — whatever range was asked for. */
  month: { now: DayRange & { collectedPaise: number }; before: DayRange & { collectedPaise: number } };
  cashiers: { name: string; openedDay: string; collectedPaise: number; state: DrawerState; variancePaise: number | null }[];
  refunds: { count: number; amountPaise: number };
  discountsPaise: number;
  /** Visits the desk let through without the fee (a named bypass) whose fee is still unsettled. */
  letThroughUnpaid: number;
};

export type AppointmentCounts = { total: number; came: number; toCome: number; missed: number; needRebooking: number; cancelled: number };
export type OwnerAppointments = DayRange & AppointmentCounts & {
  previous: (DayRange & { total: number }) | null;
  doctors: { id: string; name: string; total: number; came: number }[];
};

export type OwnerPharmacy = DayRange & {
  bills: number;
  /** Money: only for a reader who holds the pharmacy's reports; null otherwise (the counts stay). */
  salesPaise: number | null;
  refundsPaise: number | null;
  previous: (DayRange & { bills: number; salesPaise: number | null }) | null;
  /** Prescription bills from the counter's queue, and sales without one. */
  split: { key: "dispense" | "walk_in" | "downtime"; bills: number; salesPaise: number | null }[];
  /** Prescriptions that reached the counter in the range, and how many of them were handed over. */
  prescriptions: { reached: number; served: number };
  /** The counter's stock as it stands now (never of the range); null when the counter's store is not set up. */
  stock: { low: number; expiring60: number; askedOut: number; askedNames: string[] } | null;
};

export type StaffToday = {
  day: string;
  onDuty: number;
  onLeave: { userId: string; name: string }[];
  gaps: { department: string; from: string; what: string | null }[];
  waiting: { cover: number; coverLines: { department: string; day: string }[]; leave: number };
};

export type LearningNickname = {
  id: string; nickname: string; medicine: string | null; detail: string | null;
  state: "suggested" | "trusted" | "removed"; removedBy: "owner" | "doctors" | null; doctors: number; taps: number; changedAt: string;
};
export type OwnerLearning = {
  /** Whether the nickname pipeline is switched on. */
  on: boolean;
  /** Whether this reader may take a nickname back (`opd.masters.manage`). */
  mayUndo: boolean;
  /** Changed in the last seven days. */
  nicknames: LearningNickname[];
  /** Of the suggestions a doctor acted on in the last seven days: how many were tapped. Null when none. */
  tapped: { accepted: number; acted: number } | null;
  /** Words typed or heard in the last seven days that matched nothing. */
  misses: number;
};
