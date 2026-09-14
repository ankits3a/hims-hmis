import { describe, expect, it } from "vitest";
import { bookCounts, bookOrder, rebookingToday, rowStateOf, upcomingFor } from "./appointment-view";
import type { WireAppointment } from "./opd-api";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * FD-25 — THE TWO DERIVATIONS THE APPOINTMENT BOOK IS BUILT ON
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Both are pure functions for one reason: each answers a question the SERVER cannot answer today,
 * and a wrong answer to either looks exactly like a correct one on screen. These are the tests that
 * make the difference visible.
 */

const NOW = new Date("2026-09-05T05:00:00.000Z"); // 10:30 IST

const apt = (over: Partial<WireAppointment>): WireAppointment => ({
  id: "a-1", patientId: "p-1", doctorId: "doc-1", departmentId: "d-1",
  serviceDate: "2026-09-05", slotStart: "2026-09-05T04:00:00.000Z", slotEnd: "2026-09-05T04:10:00.000Z",
  status: "booked", source: "desk", note: null, encounterId: null,
  rescheduledToId: null, rescheduledFromId: null, cancelReason: null, leaveId: null,
  bookedBy: "u1", bookedAt: "2026-09-01T00:00:00.000Z", updatedBy: "u1", updatedAt: "2026-09-01T00:00:00.000Z",
  ...over,
});

describe("rowStateOf — 'missed' is a clock question, not a status question", () => {
  /**
   * ═══ THE DEFECT THIS EXISTS TO PREVENT ═══
   *
   * The no-show sweep only claims rows with `serviceDate < today`. NOTHING sets `no_show` on the
   * current date — correctly, since a 09:40 booking is not a no-show at 09:41. So a screen deriving
   * "missed" from `status === "no_show"` shows PERMANENTLY ZERO missed rows for today, which is the
   * one day the desk can still ring somebody.
   *
   * It would have looked right in every screenshot: a red "0 missed" pill is not obviously wrong.
   */
  it("a booking whose slot has ended and nobody arrived is MISSED, though its status still says booked", () => {
    const past = apt({ status: "booked", slotEnd: "2026-09-05T04:10:00.000Z" }); // 09:40 IST, now is 10:30
    expect(past.status).toBe("booked");
    expect(rowStateOf(past, NOW)).toBe("missed");
  });

  it("a booking later today is still BOOKED, not missed — the slot has not ended", () => {
    expect(rowStateOf(apt({ slotEnd: "2026-09-05T06:00:00.000Z" }), NOW)).toBe("booked");
  });

  /** A row carried over from a previous day already wears the sweep's verdict; both roads count. */
  it("honours the sweep's own no_show for a row from a previous day", () => {
    expect(rowStateOf(apt({ status: "no_show", serviceDate: "2026-09-04" }), NOW)).toBe("missed");
  });

  it("a checked-in patient is waiting, whatever the clock says", () => {
    expect(rowStateOf(apt({ status: "checked_in", slotEnd: "2026-09-05T04:10:00.000Z" }), NOW)).toBe("waiting");
  });

  it("needs_rebooking is its own state — it is a call to make, not a person who failed to arrive", () => {
    expect(rowStateOf(apt({ status: "needs_rebooking" }), NOW)).toBe("needs_rebooking");
  });
});

describe("bookCounts — the three pills agree with the rows beneath them", () => {
  it("counts checked-in, still-to-arrive and missed in one pass", () => {
    const rows = [
      apt({ id: "1", status: "checked_in" }),
      apt({ id: "2", status: "booked", slotEnd: "2026-09-05T06:00:00.000Z" }),
      apt({ id: "3", status: "booked", slotEnd: "2026-09-05T04:10:00.000Z" }),
      apt({ id: "4", status: "cancelled" }),
    ];
    expect(bookCounts(rows, NOW)).toEqual({ checkedIn: 1, toArrive: 1, missed: 1 });
  });

  /**
   * THE PILL AND THE ROWS COME FROM ONE FUNCTION, so they cannot disagree. A count computed from
   * the status and rows rendered from the clock would have shown "0 missed" above a visibly missed
   * row — the badge-contradicts-the-heading defect that a screenshot caught on `/registration`.
   */
  it("a row the pill counts as missed is a row the list renders as missed", () => {
    const rows = [apt({ status: "booked", slotEnd: "2026-09-05T04:10:00.000Z" })];
    expect(bookCounts(rows, NOW).missed).toBe(1);
    expect(rowStateOf(rows[0]!, NOW)).toBe("missed");
  });
});

describe("bookOrder — missed rows sink, and that is not a sorting bug", () => {
  /**
   * The artboard's sample list puts an 08:50 row AFTER 09:40, which reads as a mistake until you
   * ask what the book is FOR: it is worked down by somebody calling the next name. A missed row is
   * not the next name — it is a phone call for later.
   */
  it("puts a missed 08:50 below a booked 09:40, and keeps the clock inside each group", () => {
    const rows = [
      apt({ id: "missed-0850", slotStart: "2026-09-05T03:20:00.000Z", slotEnd: "2026-09-05T03:30:00.000Z" }),
      apt({ id: "booked-0940", slotStart: "2026-09-05T04:10:00.000Z", slotEnd: "2026-09-05T06:00:00.000Z" }),
      apt({ id: "booked-0900", slotStart: "2026-09-05T03:30:00.000Z", slotEnd: "2026-09-05T06:30:00.000Z" }),
    ];
    expect(bookOrder(rows, NOW).map((a) => a.id)).toEqual(["booked-0900", "booked-0940", "missed-0850"]);
  });
});

describe("rebookingToday — the rail is today forward, not every row ever", () => {
  /**
   * `GET /opd/appointments?needsRebooking=true` has NO date bound, so it returns every such row the
   * hospital has ever created, capped at 500 and OLDEST FIRST. A rail built on the raw list fills
   * with last month's cancelled leave — and the count is wrong in the direction that matters: it
   * looks like more work than there is, so the clerk stops trusting the rail.
   */
  it("drops rows from days that have already passed", () => {
    const rows = [
      apt({ id: "old", status: "needs_rebooking", serviceDate: "2026-08-01" }),
      apt({ id: "today", status: "needs_rebooking", serviceDate: "2026-09-05" }),
      apt({ id: "future", status: "needs_rebooking", serviceDate: "2026-09-11" }),
    ];
    expect(rebookingToday(rows, "2026-09-05").map((a) => a.id)).toEqual(["today", "future"]);
  });

  it("keeps only rows that actually need rebooking, whatever else the read returned", () => {
    const rows = [
      apt({ id: "booked", status: "booked", serviceDate: "2026-09-06" }),
      apt({ id: "needs", status: "needs_rebooking", serviceDate: "2026-09-06" }),
    ];
    expect(rebookingToday(rows, "2026-09-05").map((a) => a.id)).toEqual(["needs"]);
  });
});

describe("upcomingFor — what this patient still has standing, which no rail could see", () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════════════════════════════
   * THE DEFECT THIS EXISTS TO PREVENT
   * ═══════════════════════════════════════════════════════════════════════════════════════════════
   *
   * Owner, 2026-09-14: *"while booking an appointment for a patient, when I future book an
   * appointment for the patient, then I can definitely see list of appointments in history in the
   * left lane of the dashboard, but I can't see any future appointment(s) on the left lane."*
   *
   * The rail's history is `patientTimeline`, which reads `opd_encounters`. A future booking has NO
   * encounter until somebody checks it in — that is the whole design of `POST /opd/appointments` —
   * so a booked slot is invisible to that query BY CONSTRUCTION, not by a bug in it. The rail
   * needed a second read, and this is the derivation over it.
   */
  it("lists a booking made for a later day, which the timeline read can never contain", () => {
    const rows = [apt({ id: "next-week", serviceDate: "2026-09-11", slotStart: "2026-09-11T04:00:00.000Z" })];
    expect(upcomingFor(rows, "2026-09-05").map((a) => a.id)).toEqual(["next-week"]);
  });

  it("is ordered by the clock — the next appointment is the first row", () => {
    const rows = [
      apt({ id: "later", serviceDate: "2026-09-20", slotStart: "2026-09-20T04:00:00.000Z" }),
      apt({ id: "sooner", serviceDate: "2026-09-11", slotStart: "2026-09-11T04:00:00.000Z" }),
      apt({ id: "soonest", serviceDate: "2026-09-06", slotStart: "2026-09-06T04:00:00.000Z" }),
    ];
    expect(upcomingFor(rows, "2026-09-05").map((a) => a.id)).toEqual(["soonest", "sooner", "later"]);
  });

  /**
   * ═══ A STRANDED BOOKING IS STILL A COMMITMENT THE PATIENT IS HOLDING ═══
   *
   * When a doctor's leave is scheduled over a booked day the row becomes `needs_rebooking`. The
   * patient was never told: as far as they know they have an appointment. Dropping it here would
   * make the rail say "none booked" to the face of somebody standing at the counter holding a slip
   * — and `rescheduleAppointment` accepts `booked` AND `needs_rebooking` precisely because moving
   * one is the act the counter is for.
   */
  it("keeps a stranded needs_rebooking row — the patient still thinks they have an appointment", () => {
    const rows = [apt({ id: "stranded", status: "needs_rebooking", serviceDate: "2026-09-11" })];
    expect(upcomingFor(rows, "2026-09-05").map((a) => a.id)).toEqual(["stranded"]);
  });

  /**
   * ═══ THE BOUND IS THE CALENDAR DAY, NOT THE CLOCK, AND THAT IS DELIBERATE ═══
   *
   * The no-show sweep runs at 23:55 IST, so between a slot passing and midnight the row is still
   * `booked`. Bounding on the clock would delete today's missed 09:40 from the rail at 09:41 — the
   * one row a patient standing there at 14:00 is asking about. It stays, and `rowStateOf` tags it
   * `missed`, so the rail says what happened rather than nothing at all.
   */
  it("keeps today's already-passed slot, for rowStateOf to tag as missed", () => {
    const rows = [apt({ id: "this-morning", serviceDate: "2026-09-05", slotEnd: "2026-09-05T04:10:00.000Z" })];
    expect(upcomingFor(rows, "2026-09-05").map((a) => a.id)).toEqual(["this-morning"]);
    expect(rowStateOf(rows[0]!, NOW)).toBe("missed");
  });

  it("drops a booking from a day that has already gone — that is history, not a commitment", () => {
    const rows = [apt({ id: "last-week", serviceDate: "2026-08-28" })];
    expect(upcomingFor(rows, "2026-09-05")).toEqual([]);
  });

  /** Whatever else a widened read returns, a cancelled or spent row is not something still standing. */
  it("drops cancelled, rescheduled, no-show and checked-in rows", () => {
    const rows = [
      apt({ id: "cancelled", status: "cancelled", serviceDate: "2026-09-11" }),
      apt({ id: "rescheduled", status: "rescheduled", serviceDate: "2026-09-11" }),
      apt({ id: "no-show", status: "no_show", serviceDate: "2026-09-11" }),
      apt({ id: "arrived", status: "checked_in", serviceDate: "2026-09-11" }),
      apt({ id: "standing", status: "booked", serviceDate: "2026-09-11" }),
    ];
    expect(upcomingFor(rows, "2026-09-05").map((a) => a.id)).toEqual(["standing"]);
  });
});
