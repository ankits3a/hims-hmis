/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * FD-25 — WHAT AN APPOINTMENT ROW *IS*, ON A SCREEN, AS PURE FUNCTIONS
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Two front-desk screens now render the day's book, and both need answers to the same two questions
 * — "did this person turn up?" and "which of today's rows still need chasing?". Neither answer is a
 * column, both are derivations, and a derivation written twice is a derivation that will disagree.
 */

/*
  MOVED 2026-10-07 to packages/contracts/src/appointment-book.ts — the phone's Desk One reads an
  appointment by the same rules, and a derivation written twice is a derivation that will disagree.
  Every name that lived here is re-exported, bodies unchanged; `WireAppointment` satisfies the shared
  row shape, so no caller changed.
*/
export {
  rowStateOf, bookCounts, bookOrder, rebookingToday, upcomingOf, slotClock, dayPartOf,
} from "../../../../packages/contracts/src/appointment-book";
export type { RowState, DayPart } from "../../../../packages/contracts/src/appointment-book";
