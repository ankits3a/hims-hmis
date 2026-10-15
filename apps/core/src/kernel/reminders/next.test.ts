import { firstDue, istClock, istInstant, nextOccurrence } from "@hmis/contracts";

/**
 * E1.2 done-means 7 — the repeat grammar in IST (spec /opt/hmis-context/SPEC-reminders-2026-10-11.md).
 * Fixed dates are safe here: nothing below reads the clock — every function takes its instants.
 */
const at = (day: string, hhmm: string): Date => istInstant(day, hhmm)!;

describe("E1.2 — when a reminder fires next (IST)", () => {
  // 2026-10-17 is a Saturday.
  const SAT_4PM = at("2026-10-17", "16:00");
  const justAfter = new Date(SAT_4PM.getTime() + 20_000);

  it("(7) fired on Saturday 16:00 IST: daily → Sunday, Mon–Sat → Monday, weekly → next Saturday, all at 16:00 IST; once → nothing", () => {
    expect(istClock(SAT_4PM)).toEqual({ day: "2026-10-17", hhmm: "16:00", weekday: 6 });
    expect(nextOccurrence("daily", SAT_4PM, justAfter)).toEqual(at("2026-10-18", "16:00"));
    expect(nextOccurrence("mon_sat", SAT_4PM, justAfter)).toEqual(at("2026-10-19", "16:00"));
    expect(nextOccurrence("weekly", SAT_4PM, justAfter)).toEqual(at("2026-10-24", "16:00"));
    expect(nextOccurrence("none", SAT_4PM, justAfter)).toBeNull();
  });

  it("a worker that was down for days fires once and moves to the first time still ahead — no backlog", () => {
    const threeDaysLate = at("2026-10-20", "17:00"); // Tuesday 17:00
    expect(nextOccurrence("daily", SAT_4PM, threeDaysLate)).toEqual(at("2026-10-21", "16:00"));
    expect(nextOccurrence("mon_sat", SAT_4PM, at("2026-10-24", "16:30"))).toEqual(at("2026-10-26", "16:00")); // past Saturday, skips Sunday
    expect(nextOccurrence("weekly", SAT_4PM, at("2026-11-02", "09:00"))).toEqual(at("2026-11-07", "16:00"));
    // Exactly on a later time: strictly after, so the next one.
    expect(nextOccurrence("daily", SAT_4PM, at("2026-10-18", "16:00"))).toEqual(at("2026-10-19", "16:00"));
  });

  it("a Mon–Sat reminder set for a Sunday first fires on the Monday; nothing else moves", () => {
    const sun9 = at("2026-10-18", "09:00");
    expect(firstDue("mon_sat", sun9)).toEqual(at("2026-10-19", "09:00"));
    expect(firstDue("daily", sun9)).toEqual(sun9);
    expect(firstDue("mon_sat", SAT_4PM)).toEqual(SAT_4PM);
  });

  it("reads only well-formed IST days and times", () => {
    expect(istInstant("2026-10-17", "24:00")).toBeNull();
    expect(istInstant("17-10-2026", "09:00")).toBeNull();
    expect(at("2026-10-17", "00:30").toISOString()).toBe("2026-10-16T19:00:00.000Z");
  });
});
