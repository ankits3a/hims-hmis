import { addDays, ageYearsAt, istDate, istDateTimeToUtc, istDayIndex, istMonthBounds, istWeekday } from "./time";

describe("IST helpers (pure, fixed +05:30, no DST)", () => {
  it("istDate flips at 18:30 UTC", () => {
    expect(istDate(new Date("2026-08-15T18:29:59.000Z"))).toBe("2026-08-15");
    expect(istDate(new Date("2026-08-15T18:30:00.000Z"))).toBe("2026-08-16");
  });
  it("istDayIndex differences count IST calendar days", () => {
    // 2026-08-08 23:59:59 IST → 2026-08-16 00:00:00 IST = 8 days
    expect(istDayIndex(new Date("2026-08-15T18:30:00.000Z")) - istDayIndex(new Date("2026-08-08T18:29:59.000Z"))).toBe(8);
    expect(istDayIndex(new Date("2026-08-15T18:29:59.000Z")) - istDayIndex(new Date("2026-08-15T00:00:00.000Z"))).toBe(0);
  });
  it("istDateTimeToUtc: 2026-08-17 10:30 IST = 05:00 UTC", () => {
    expect(istDateTimeToUtc("2026-08-17", "10:30").toISOString()).toBe("2026-08-17T05:00:00.000Z");
    expect(istDateTimeToUtc("2026-08-17", "00:00").toISOString()).toBe("2026-08-16T18:30:00.000Z");
  });
  it("istWeekday: 2026-08-17 is a Monday (1); 2026-08-16 a Sunday (0)", () => {
    expect(istWeekday("2026-08-17")).toBe(1);
    expect(istWeekday("2026-08-16")).toBe(0);
  });
  it("addDays crosses month ends", () => {
    expect(addDays("2026-08-30", 3)).toBe("2026-09-02");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });
  it("istMonthBounds for August 2026 = [Jul 31 18:30Z, Aug 31 18:30Z)", () => {
    const b = istMonthBounds(new Date("2026-08-15T12:00:00.000Z"));
    expect(b.start.toISOString()).toBe("2026-07-31T18:30:00.000Z");
    expect(b.end.toISOString()).toBe("2026-08-31T18:30:00.000Z");
  });
  it("ageYearsAt is anniversary-aware", () => {
    const at = new Date("2026-08-15T06:00:00.000Z");
    expect(ageYearsAt(new Date("1990-04-02T00:00:00.000Z"), at)).toBe(36);
    expect(ageYearsAt(new Date("2016-08-16T00:00:00.000Z"), at)).toBe(9); // birthday tomorrow
    expect(ageYearsAt(new Date("2016-08-15T00:00:00.000Z"), at)).toBe(10); // birthday today
  });

  it("T0 (MINOR): a birthday is an IST calendar day — 13 from midnight IST, not from 05:30", () => {
    const dob = new Date("2013-08-17T00:00:00.000Z");
    // 2026-08-16 19:00 UTC = 2026-08-17 00:30 IST: the birthday has arrived in the hospital's clock.
    expect(ageYearsAt(dob, new Date("2026-08-16T19:00:00.000Z"))).toBe(13);
    // 2026-08-16 18:00 UTC = 23:30 IST on the 16th: not yet.
    expect(ageYearsAt(dob, new Date("2026-08-16T18:00:00.000Z"))).toBe(12);
  });
});
