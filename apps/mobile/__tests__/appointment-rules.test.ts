import { readFileSync } from "fs";
import { join } from "path";
import {
  addDaysIso, bookCounts, bookOrder, bookedAlready, dayOffer, dayPartOf, daysFrom, movedAlready, partCounts, rebookingToday, rowStateOf, sittingWeekdays,
  slotClock, upcomingOf, weekdayOf,
} from "../src/counter/appointment-rules";

const read = (rel: string): string => readFileSync(join(__dirname, rel), "utf8");
const NOW = new Date("2026-10-07T06:00:00.000Z"); // 11:30 IST, Wednesday
const row = (over: Record<string, unknown>) => ({ id: "a", doctorId: "d1", status: "booked" as const, serviceDate: "2026-10-07", slotStart: "2026-10-07T05:00:00.000Z", slotEnd: "2026-10-07T05:10:00.000Z", ...over });
const tpl = (weekday: number, startTime: string, endTime: string, over: Record<string, unknown> = {}) => ({ weekday, startTime, endTime, validFrom: "2026-01-01", validTo: null, active: true, ...over });

describe("how an appointment is read — one file for the counter PC and the phone", () => {
  it("the web reads the SAME file: its view re-exports the moved rules and defines none; the phone grows no copy", () => {
    const view = read("../../web/src/lib/appointment-view.ts");
    expect(view).toContain('from "../../../../packages/contracts/src/appointment-book"');
    expect(view).not.toMatch(/export function/);
    const stages = read("../../web/src/screens/desk-one/stages.tsx");
    expect(stages).toContain('import { dayPartOf } from "../../lib/appointment-view"');
    expect(stages).not.toMatch(/function dayPartOf/);
    expect(read("../src/counter/appointment-rules.ts")).not.toMatch(/export (function|const)/);
  });

  it("the day's weekday and the leave-before-timetable order are the server's own (slots.ts)", () => {
    const slots = read("../../core/src/modules/opd/slots.ts");
    expect(slots).toContain('l.status === "scheduled" && l.fromDate <= date && date <= l.toDate');
    expect(slots).toContain("t.validFrom > date || (t.validTo !== null && t.validTo < date)");
    expect(weekdayOf("2026-10-07")).toBe(3);
    expect(weekdayOf("2026-10-11")).toBe(0);
    expect(addDaysIso("2026-10-30", 3)).toBe("2026-11-02");
    expect(daysFrom("2026-10-07", 3)).toEqual(["2026-10-07", "2026-10-08", "2026-10-09"]);
  });

  it("a day is open only inside an active template of its weekday — and a scheduled leave closes it whatever the timetable says", () => {
    const schedules = [tpl(3, "14:00:00", "17:00:00"), tpl(3, "09:00:00", "11:00:00"), tpl(5, "09:00", "13:00", { validTo: "2026-10-08" }), tpl(4, "09:00", "12:00", { active: false })];
    const leaves = [{ fromDate: "2026-10-14", toDate: "2026-10-15", status: "scheduled", reason: " conference " }, { fromDate: "2026-10-21", toDate: "2026-10-21", status: "cancelled", reason: "x" }];
    // Two sessions on one day (the orthopaedics timetable): both, in clock order.
    expect(dayOffer("2026-10-07", schedules, leaves)).toEqual({ kind: "open", sessions: [{ startTime: "09:00", endTime: "11:00" }, { startTime: "14:00", endTime: "17:00" }] });
    expect(dayOffer("2026-10-14", schedules, leaves)).toEqual({ kind: "leave", reason: "conference" });
    expect(dayOffer("2026-10-21", schedules, leaves).kind).toBe("open"); // a cancelled leave closes nothing
    expect(dayOffer("2026-10-08", schedules, leaves)).toEqual({ kind: "no_session" }); // inactive template
    expect(dayOffer("2026-10-09", schedules, leaves)).toEqual({ kind: "no_session" }); // past its validity
    expect(sittingWeekdays(schedules, "2026-10-07")).toEqual([3, 5]);
    expect(sittingWeekdays(schedules, "2026-10-09")).toEqual([3]);
  });

  it("morning before 12:00, noon from 12:00, evening from 17:00 — on the IST clock the slot prints", () => {
    expect(slotClock("2026-10-07T03:30:00.000Z")).toBe("09:00");
    expect(dayPartOf("2026-10-07T06:29:00.000Z")).toBe("morning");
    expect(dayPartOf("2026-10-07T06:30:00.000Z")).toBe("noon");
    expect(dayPartOf("2026-10-07T11:29:00.000Z")).toBe("noon");
    expect(dayPartOf("2026-10-07T11:30:00.000Z")).toBe("evening");
    const s = (start: string, booked = false, past = false) => ({ start, end: start, booked, past });
    expect(partCounts([s("2026-10-07T03:30:00.000Z"), s("2026-10-07T04:00:00.000Z", true), s("2026-10-07T04:30:00.000Z", false, true), s("2026-10-07T08:00:00.000Z")]))
      .toEqual({ morning: { all: 3, free: 1 }, noon: { all: 1, free: 1 }, evening: { all: 0, free: 0 } });
  });

  it("'missed' is the clock's answer today (the sweep has not run); missed rows sink; the counts come from the same pass", () => {
    const past = row({ id: "p" }), ahead = row({ id: "f", slotStart: "2026-10-07T08:00:00.000Z", slotEnd: "2026-10-07T08:10:00.000Z" });
    const arrived = row({ id: "c", status: "checked_in" }), moved = row({ id: "m", status: "rescheduled" });
    expect(rowStateOf(past, NOW)).toBe("missed");
    expect(rowStateOf(ahead, NOW)).toBe("booked");
    expect(rowStateOf(arrived, NOW)).toBe("waiting");
    expect(rowStateOf(moved, NOW)).toBe("cancelled");
    expect(bookOrder([past, ahead, arrived], NOW).map((a) => a.id)).toEqual(["c", "f", "p"]);
    expect(bookCounts([past, ahead, arrived, moved], NOW)).toEqual({ checkedIn: 1, toArrive: 1, missed: 1 });
  });

  it("what a patient still has booked is bound on the calendar day; the re-booking list is today forward", () => {
    const rows = [row({ id: "old", serviceDate: "2026-10-01" }), row({ id: "today" }), row({ id: "strand", status: "needs_rebooking", serviceDate: "2026-10-09", slotStart: "2026-10-09T05:00:00.000Z" }), row({ id: "gone", status: "cancelled", serviceDate: "2026-10-10" }), row({ id: "stale", status: "needs_rebooking", serviceDate: "2026-09-01" })];
    expect(upcomingOf(rows, "2026-10-07").map((a) => a.id)).toEqual(["today", "strand"]);
    expect(rebookingToday(rows, "2026-10-07").map((a) => a.id)).toEqual(["strand"]);
  });

  it("a lost answer is settled by reading: the exact slot held, or the old row naming its successor — never a guess", () => {
    const rows = [row({ id: "a1", doctorId: "d2", slotStart: "2026-10-08T03:30:00.000Z" }), row({ id: "a2", status: "rescheduled", rescheduledToId: "a3" }), row({ id: "a3", doctorId: "d3" }), row({ id: "a4", status: "cancelled", doctorId: "d2", slotStart: "2026-10-09T03:30:00.000Z" })];
    expect(bookedAlready(rows, "d2", "2026-10-08T03:30:00Z")?.id).toBe("a1"); // the same instant, however it is written
    expect(bookedAlready(rows, "d1", "2026-10-08T03:30:00.000Z")).toBeNull(); // another doctor's slot is not this booking
    expect(bookedAlready(rows, "d2", "2026-10-09T03:30:00.000Z")).toBeNull(); // a cancelled row holds nothing
    expect(movedAlready(rows, "a2")?.id).toBe("a3");
    expect(movedAlready(rows, "a1")).toBeNull();
  });
});
