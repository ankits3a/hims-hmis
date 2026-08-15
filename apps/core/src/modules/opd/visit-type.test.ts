import { classifyVisit } from "./visit-type";

const anchor = (iso: string, followUpDays = 7) => ({ consultCompletedAt: new Date(iso), followUpDays });

describe("classifyVisit (pure; IST calendar days, inclusive window)", () => {
  it("no completed consult in the department → new", () => {
    expect(classifyVisit(null, new Date("2026-08-15T05:00:00.000Z"))).toBe("new");
  });
  it("day 7 after an Aug-8 consult is a revisit; day 8 is a renewal (7-day default, inclusive)", () => {
    expect(classifyVisit(anchor("2026-08-08T10:00:00.000Z"), new Date("2026-08-15T05:00:00.000Z"))).toBe("revisit"); // 7 days
    expect(classifyVisit(anchor("2026-08-08T10:00:00.000Z"), new Date("2026-08-15T18:30:00.000Z"))).toBe("renewal"); // Aug 16 IST = 8 days
  });
  it("counts calendar days, not 168 hours: 23:59 IST → 00:00 IST seven nights later is still day 7", () => {
    expect(classifyVisit(anchor("2026-08-08T18:29:59.000Z"), new Date("2026-08-14T18:30:00.000Z"))).toBe("revisit"); // Aug 8 23:59:59 IST → Aug 15 00:00 IST
  });
  it("an extended window (30) reaches Sep 7 and not Sep 8", () => {
    expect(classifyVisit(anchor("2026-08-08T10:00:00.000Z", 30), new Date("2026-09-07T05:00:00.000Z"))).toBe("revisit");
    expect(classifyVisit(anchor("2026-08-08T10:00:00.000Z", 30), new Date("2026-09-08T05:00:00.000Z"))).toBe("renewal");
  });
});
