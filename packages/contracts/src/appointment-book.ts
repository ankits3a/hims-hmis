/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * AN APPOINTMENT ON A SCREEN — ONE FILE FOR THE COUNTER PC AND THE PHONE (owner 2026-10-07)
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Pure reading rules, no imports. The web's `lib/appointment-view.ts` re-exports every name that
 * lived there (moved here, bodies unchanged) and `desk-one/stages.tsx` cuts its morning / noon /
 * evening cards with `dayPartOf`; the phone's Desk One reads the same file through its
 * `counter/appointment-rules.ts`. A derivation written twice is a derivation that will disagree.
 *
 * NOTHING HERE DECIDES A BOOKING. Which instants are slots, which are taken, whether a doctor is on
 * leave and whether a booking may be moved, cancelled or checked in are the server's answers
 * (`modules/opd/appointments.ts`, `slots.ts`). These functions only say how to read them.
 */

export type BookStatus = "booked" | "checked_in" | "cancelled" | "no_show" | "needs_rebooking" | "rescheduled";
export type BookRow = { status: BookStatus; slotStart: string; slotEnd: string; serviceDate: string };
export type BookSlot = { start: string; end: string; booked: boolean; past: boolean };
export type BookSchedule = { weekday: number; startTime: string; endTime: string; validFrom: string; validTo: string | null; active: boolean };
export type BookLeave = { fromDate: string; toDate: string; status: string; reason?: string | null };

/**
 * ═══ `no_show` IS NOT THE ANSWER TO "DID THEY TURN UP", AND IT NEVER WILL BE TODAY ═══
 *
 * The no-show sweep claims rows with `serviceDate < today` (`appointments.ts`). NOTHING sets
 * `no_show` on the current date, by design — a 09:40 booking is not a no-show at 09:41. So a screen
 * that derives "missed" from `status === "no_show"` shows **permanently zero missed rows for
 * today**, which is the one day a front desk can still do something about it.
 *
 * The correct derivation already exists SERVER-SIDE, in the desk tile: `status === "booked" AND
 * slotEnd < now`. This is that rule, client-side, for the screens. A row carried over from a
 * previous day already wears `no_show`, so both roads are honoured: the status when the sweep has
 * run, the clock when it has not yet.
 */
export type RowState = "seen" | "in_consult" | "waiting" | "booked" | "missed" | "cancelled" | "needs_rebooking";

export function rowStateOf(a: BookRow, now: Date = new Date()): RowState {
  if (a.status === "cancelled" || a.status === "rescheduled") return "cancelled";
  if (a.status === "needs_rebooking") return "needs_rebooking";
  if (a.status === "no_show") return "missed";
  if (a.status === "checked_in") return "waiting";
  /* `booked` and the slot's end has passed — nobody arrived, and today's sweep has not run. */
  return new Date(a.slotEnd).getTime() < now.getTime() ? "missed" : "booked";
}

/** The three count pills, from one pass so they cannot disagree with the rows. */
export function bookCounts(rows: readonly BookRow[], now: Date = new Date()): {
  checkedIn: number; toArrive: number; missed: number;
} {
  let checkedIn = 0; let toArrive = 0; let missed = 0;
  for (const a of rows) {
    const state = rowStateOf(a, now);
    if (state === "waiting" || state === "in_consult" || state === "seen") checkedIn += 1;
    else if (state === "booked") toArrive += 1;
    else if (state === "missed") missed += 1;
  }
  return { checkedIn, toArrive, missed };
}

/**
 * The book's order: read forwards through the morning by somebody calling the next name. A missed
 * row is not the next name — it is a phone call for later — so it sinks; within each group, the clock.
 */
export function bookOrder<A extends BookRow>(rows: readonly A[], now: Date = new Date()): A[] {
  const rank = (a: A): number => {
    const state = rowStateOf(a, now);
    return state === "missed" || state === "cancelled" ? 1 : 0;
  };
  return [...rows].sort((a, b) => rank(a) - rank(b) || a.slotStart.localeCompare(b.slotStart));
}

/**
 * The rebooking list is TODAY FORWARD. `GET /opd/appointments?needsRebooking=true` has no date
 * bound, so the raw answer is every such row the hospital has ever created; the bound is the
 * screen's, said out loud.
 */
export function rebookingToday<A extends BookRow>(rows: readonly A[], todayIsoDate: string): A[] {
  return rows
    .filter((a) => a.status === "needs_rebooking" && a.serviceDate >= todayIsoDate)
    .sort((a, b) => a.slotStart.localeCompare(b.slotStart));
}

/**
 * What this patient still has booked. Bound on the CALENDAR day, not the clock: today's slot whose
 * hour has passed is still the patient's appointment until somebody checks them in, cancels it or
 * marks the no-show. Soonest first.
 */
export function upcomingOf<A extends BookRow>(rows: readonly A[] | undefined, todayIsoDate: string): A[] {
  return (rows ?? [])
    .filter((a) => (a.status === "booked" || a.status === "needs_rebooking") && a.serviceDate.slice(0, 10) >= todayIsoDate)
    .sort((a, b) => a.slotStart.localeCompare(b.slotStart));
}

/**
 * A slot's clock face in IST. ONE helper for the chips, the confirm button and the day's book, so
 * the three cannot disagree — a slot offered as 10:20 and confirmed as 10:50 is a booking nobody
 * can defend.
 */
export function slotClock(iso: string): string {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date(iso));
}

/**
 * ═══ MORNING, NOON OR EVENING FIRST — THEN THE SLOTS (owner, 2026-10-01) ═══
 *
 * The parts are cut on the IST clock the slot buttons print: morning before 12:00, noon from 12:00,
 * evening from 17:00.
 */
export type DayPart = "morning" | "noon" | "evening";
export const DAY_PART_ORDER: readonly DayPart[] = ["morning", "noon", "evening"];
export function dayPartOf(iso: string): DayPart {
  const hour = Number.parseInt(slotClock(iso).slice(0, 2), 10);
  return hour < 12 ? "morning" : hour < 17 ? "noon" : "evening";
}

/** Each part's slots and how many are still free — a full morning is seen before it is opened. */
export function partCounts(slots: readonly BookSlot[]): Record<DayPart, { all: number; free: number }> {
  const out: Record<DayPart, { all: number; free: number }> = { morning: { all: 0, free: 0 }, noon: { all: 0, free: 0 }, evening: { all: 0, free: 0 } };
  for (const s of slots) {
    const p = out[dayPartOf(s.start)];
    p.all += 1;
    if (!s.booked && !s.past) p.free += 1;
  }
  return out;
}

// ——— the days a doctor can be booked on (the phone's date strip; the server's slot list stays the judge) ———

const isoParts = (date: string): [number, number, number] => {
  const [y, m, d] = date.slice(0, 10).split("-").map((x) => Number.parseInt(x, 10));
  return [y ?? 1970, m ?? 1, d ?? 1];
};
/** 0 = Sunday … 6 = Saturday, of an IST calendar date — the server's `istWeekday`. */
export function weekdayOf(date: string): number {
  const [y, m, d] = isoParts(date);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}
export function addDaysIso(date: string, n: number): string {
  const [y, m, d] = isoParts(date);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
/** `count` calendar dates from `from`, inclusive. */
export function daysFrom(from: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => addDaysIso(from, i));
}

/**
 * Why a date can or cannot be offered, in the order the server's `slotsForDate` applies it: a
 * scheduled leave empties the day whatever the timetable says; otherwise the day is open only when
 * an active template of that weekday is inside its validity.
 */
export type DayOffer =
  | { kind: "open"; sessions: { startTime: string; endTime: string }[] }
  | { kind: "leave"; reason: string | null }
  | { kind: "no_session" };

export function dayOffer(date: string, schedules: readonly BookSchedule[], leaves: readonly BookLeave[]): DayOffer {
  const leave = leaves.find((l) => l.status === "scheduled" && l.fromDate <= date && date <= l.toDate);
  if (leave !== undefined) return { kind: "leave", reason: (leave.reason ?? "").trim() === "" ? null : (leave.reason ?? "").trim() };
  const weekday = weekdayOf(date);
  const sessions = schedules
    .filter((t) => t.active && t.weekday === weekday && t.validFrom <= date && (t.validTo === null || t.validTo >= date))
    .map((t) => ({ startTime: t.startTime.slice(0, 5), endTime: t.endTime.slice(0, 5) }))
    .sort((a, b) => a.startTime.localeCompare(b.startTime));
  return sessions.length === 0 ? { kind: "no_session" } : { kind: "open", sessions };
}

/** The weekdays (0–6) a doctor sits on as of `date` — "sits Mon, Wed, Fri". */
export function sittingWeekdays(schedules: readonly BookSchedule[], date: string): number[] {
  const days = new Set<number>();
  for (const t of schedules) if (t.active && t.validFrom <= date && (t.validTo === null || t.validTo >= date)) days.add(t.weekday);
  return [...days].sort((a, b) => a - b);
}

/**
 * A lost answer is settled by READING, never by guessing (the phone's rule for every write that
 * must not happen twice). Given the patient's appointments re-read from the server:
 *   • a booking asked for (doctor, instant) HAPPENED when a live row holds exactly that slot;
 *   • a move HAPPENED when the old row says `rescheduled` and names its successor;
 *   • a cancel HAPPENED when the row says `cancelled`.
 */
export type SettleRow = BookRow & { id: string; doctorId: string; rescheduledToId?: string | null };
export function bookedAlready<A extends SettleRow>(rows: readonly A[], doctorId: string, slotStartIso: string): A | null {
  const at = new Date(slotStartIso).getTime();
  return rows.find((a) => (a.status === "booked" || a.status === "checked_in") && a.doctorId === doctorId && new Date(a.slotStart).getTime() === at) ?? null;
}
export function movedAlready<A extends SettleRow>(rows: readonly A[], appointmentId: string): A | null {
  const from = rows.find((a) => a.id === appointmentId);
  if (from === undefined || from.status !== "rescheduled" || from.rescheduledToId == null) return null;
  return rows.find((a) => a.id === from.rescheduledToId) ?? null;
}
