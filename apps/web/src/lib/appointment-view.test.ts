import { describe, expect, it } from "vitest";
import { bookCounts, bookOrder, rebookingToday, rowStateOf } from "./appointment-view";
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
