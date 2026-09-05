import type { WireAppointment } from "./opd-api";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * FD-25 — WHAT AN APPOINTMENT ROW *IS*, ON A SCREEN, AS PURE FUNCTIONS
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Two front-desk screens now render the day's book, and both need answers to the same two questions
 * — "did this person turn up?" and "which of today's rows still need chasing?". Neither answer is a
 * column, both are derivations, and a derivation written twice is a derivation that will disagree.
 */

/**
 * ═══ `no_show` IS NOT THE ANSWER TO "DID THEY TURN UP", AND IT NEVER WILL BE TODAY ═══
 *
 * The no-show sweep claims rows with `serviceDate < today` (`appointments.ts`). NOTHING sets
 * `no_show` on the current date, by design — a 09:40 booking is not a no-show at 09:41. So a screen
 * that derives "missed" from `status === "no_show"` shows **permanently zero missed rows for
 * today**, which is the one day a front desk can still do something about it.
 *
 * The correct derivation already exists SERVER-SIDE, in the desk tile: `status === "booked" AND
 * slotEnd < now`, and its own comment says so. This is that rule, client-side, for the screens.
 * A row carried over from a previous day already wears `no_show`, so both roads are honoured:
 * the status when the sweep has run, the clock when it has not yet.
 *
 * The artboard's red "3 missed" pill and its `08:50 · Lakshmi Prasad · missed · Rebook` row are
 * this function. Derived from the status alone they would both have been empty on every screenshot
 * anyone ever took, and the screen would have looked fine.
 */
export type RowState = "seen" | "in_consult" | "waiting" | "booked" | "missed" | "cancelled" | "needs_rebooking";

export function rowStateOf(a: WireAppointment, now: Date = new Date()): RowState {
  if (a.status === "cancelled" || a.status === "rescheduled") return "cancelled";
  if (a.status === "needs_rebooking") return "needs_rebooking";
  if (a.status === "no_show") return "missed";
  if (a.status === "checked_in") return "waiting";
  /* `booked` and the slot's end has passed — nobody arrived, and today's sweep has not run. */
  return new Date(a.slotEnd).getTime() < now.getTime() ? "missed" : "booked";
}

/** The artboard's three count pills, from one pass so they cannot disagree with the rows. */
export function bookCounts(rows: readonly WireAppointment[], now: Date = new Date()): {
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
 * ═══ THE BOOK'S ORDER, AND WHY MISSED ROWS SINK ═══
 *
 * The artboard's sample list puts an 08:50 row AFTER 09:40, which looks like a mistake until you
 * ask what the book is FOR: it is read forwards through the morning by somebody calling the next
 * name. A missed row is not the next name — it is a phone call for later — so it belongs at the
 * bottom rather than in the middle of the queue the clerk is working down.
 *
 * Within each group the order is the clock, because a book that is not in time order is not a book.
 */
export function bookOrder(rows: readonly WireAppointment[], now: Date = new Date()): WireAppointment[] {
  const rank = (a: WireAppointment): number => {
    const state = rowStateOf(a, now);
    return state === "missed" || state === "cancelled" ? 1 : 0;
  };
  return [...rows].sort((a, b) => rank(a) - rank(b) || a.slotStart.localeCompare(b.slotStart));
}

/**
 * ═══ THE REBOOKING RAIL IS TODAY FORWARD, NOT EVERY ROW EVER ═══
 *
 * `GET /opd/appointments?needsRebooking=true` has NO date bound — `listAppointments` supports only
 * an exact `serviceDate` — so it returns every `needs_rebooking` row the hospital has ever created,
 * oldest first, capped at 500. A rail built on it fills with last month's cancelled leave and its
 * count is wrong in the direction that matters: it looks like more work than there is, so the clerk
 * stops trusting it.
 *
 * The desk tile does the right thing server-side with `gte(serviceDate, today)`; the SPA cannot
 * express that yet, so it is done here and said out loud rather than left to look like the server's
 * answer. If `serviceDateFrom` is added to `appointmentsQuery` later, this becomes a one-line delete.
 */
export function rebookingToday(rows: readonly WireAppointment[], todayIsoDate: string): WireAppointment[] {
  return rows
    .filter((a) => a.status === "needs_rebooking" && a.serviceDate >= todayIsoDate)
    .sort((a, b) => a.slotStart.localeCompare(b.slotStart));
}

/**
 * A slot's clock face in IST. ONE helper for the chips, the confirm button and the day's book, so
 * the three cannot disagree — a slot offered as 10:20 and confirmed as 10:50 is a booking nobody
 * can defend. Lifted out of `desk-one/stages.tsx`, where it served the same purpose for one screen.
 */
export function slotClock(iso: string): string {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date(iso));
}
